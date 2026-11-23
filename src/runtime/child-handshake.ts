import { writeFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
  REPORT_NUDGE,
  WORK_REPORT,
  WORK_REPORT_PARAMETERS,
  workReportProblems,
} from './work-report.ts';

type ToolParameters = Parameters<ExtensionAPI['registerTool']>[0]['parameters'];

const doneParameters = {
  additionalProperties: false,
  properties: {},
  type: 'object',
} as ToolParameters;

const pingParameters = {
  additionalProperties: false,
  properties: {
    message: {
      description: 'The question you cannot answer.',
      type: 'string',
    },
  },
  required: ['message'],
  type: 'object',
} as ToolParameters;

export type TerminalSidecar = { type: 'done' } | { message: string; name: string; type: 'ping' };

export type TurnMessage = {
  role?: string;
  stopReason?: string;
};

export function shouldAutoExit(messages: ReadonlyArray<TurnMessage>): boolean {
  const last = messages.at(-1);
  if (last === undefined || last.role === 'user') {
    return false;
  }
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') {
      continue;
    }
    return message.stopReason !== 'aborted' && message.stopReason !== 'error';
  }
  return false;
}

// A model request can fail in a way Pi does not retry, such as a provider
// that answers 200 with a failed body. The child would sit idle with no
// terminal call, so it nudges itself to continue with backoff, then exits
// with a failure so the controller's infrastructure retry takes over.
export const NUDGE_DELAYS_MS = [15_000, 60_000, 180_000] as const;
export const NUDGE_PROMPT =
  'The last model request failed. Continue the task from where you stopped.';

export type FailedTurnStep =
  | { kind: 'none' }
  | { delayMs: number; kind: 'nudge' }
  | { kind: 'exit' };

export function afterFailedTurn(
  messages: ReadonlyArray<TurnMessage>,
  nudges: number,
): FailedTurnStep {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || last.stopReason !== 'error') {
    return { kind: 'none' };
  }
  const delayMs = NUDGE_DELAYS_MS[nudges];
  return delayMs === undefined ? { kind: 'exit' } : { delayMs, kind: 'nudge' };
}

export function createTerminalWriter(): (
  sessionFile: string | undefined,
  body: TerminalSidecar,
) => boolean {
  let written = false;
  return (sessionFile, body) => {
    if (written || sessionFile === undefined || sessionFile.length === 0) {
      return false;
    }
    written = true;
    const json =
      body.type === 'done'
        ? '{"type":"done"}'
        : `{"type":"ping","name":${JSON.stringify(body.name)},"message":${JSON.stringify(body.message)}}`;
    writeFileSync(`${sessionFile}.exit`, json);
    return true;
  };
}

// The controller grades a stage's reply: the last assistant text since the
// latest prompt. When it holds no `## ` heading, the agent has not written
// its template yet; an agent that calls subagent_done after only thinking it
// through would end the run with nothing to grade.
export const MISSING_REPLY =
  'Not finished: the controller grades your reply text, and this run has no template in it yet. Write the stage template now as plain text, then call subagent_done.';

// How many missed reports end a run without one: refused calls, and turns
// that ended without calling subagent_done.
export const REPORT_ATTEMPTS = 3;

export const REPORT_DONE_DESCRIPTION =
  "Finish this factory stage: your report is this call's arguments, and the controller reads only them. Call it once, as your last tool call; the session ends after it. If the report is refused, fix the fields the error names and call it again. If a message still arrives, follow it. Do not call caller_ping after it.";

// What a refused report tells the agent.
export function refusal(problems: ReadonlyArray<string>): string {
  return [
    'Report refused; the session goes on. Fix these fields and call subagent_done again:',
    ...problems.map((problem) => `- ${problem}`),
    'No project checks were run.',
  ].join('\n');
}

type SessionEntryLike = { message?: { content?: unknown; role?: string }; type?: string };

export function replyIsMissing(entries: ReadonlyArray<SessionEntryLike>): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const message = entries[index]?.type === 'message' ? entries[index]?.message : undefined;
    if (message?.role === 'user') {
      return true;
    }
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) {
      continue;
    }
    const text = message.content
      .flatMap((part: unknown) =>
        typeof part === 'object' &&
        part !== null &&
        'type' in part &&
        part.type === 'text' &&
        'text' in part &&
        typeof part.text === 'string'
          ? [part.text]
          : [],
      )
      .join('\n');
    if (text.trim().length > 0) {
      return !/^##\s+\S/m.test(text);
    }
  }
  return true;
}

function pingName(env: NodeJS.ProcessEnv): string {
  const name = env['PI_SUBAGENT_NAME'];
  return name !== undefined && name.length > 0 ? name : 'factory';
}

// What a terminal tool answers. The run ends after the turn, so the model
// reads these only when the controller resumes the session: they tell it why
// its last call has a result and a new message follows.
export const DONE_RESULT =
  'The session is shutting down: the controller checks your reply. A later message resumes this session; follow it.';
export const PING_RESULT =
  'The session is shutting down until a person answers your question. Their answer arrives as the next message; follow it.';

export type HandshakeDeps = { env: NodeJS.ProcessEnv; exit: (code: number) => void };

const processDeps: HandshakeDeps = {
  env: process.env,
  exit: (code) => {
    process.exit(code);
  },
};

// subagent_done and caller_ping end the run, but a tool call must keep its
// result in the session: a resumed session whose last tool call has none is
// history a provider such as Anthropic's refuses. So a terminal tool records
// the ending and returns a result that asks Pi to stop after the turn
// (`terminate`). At turn_end, Pi has saved every tool result of the turn and
// starts no further request, so the child publishes the sidecar and exits
// then: the controller never sees a session it cannot resume.
export default function factoryChildHandshake(
  pi: ExtensionAPI,
  deps: HandshakeDeps = processDeps,
): void {
  const { env } = deps;
  const writeTerminal = createTerminalWriter();
  let replyNudged = false;
  // The first terminal call of the turn; the run ends once the turn does.
  let ending: TerminalSidecar | null = null;

  // A stage with a report takes it as subagent_done's arguments: the run
  // cannot end without one the controller can read.
  const report = env['FACTORY_REPORT'] === WORK_REPORT;
  const feedbackItems = (env['FACTORY_FEEDBACK_ITEMS'] ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  // Reports missed this run: calls refused by Pi's schema check or by this
  // one, and turns that ended without a call.
  let missed = 0;
  const finish = () => {
    ending ??= { type: 'done' };
    return {
      content: [{ text: DONE_RESULT, type: 'text' as const }],
      details: undefined,
      terminate: true,
    };
  };

  pi.registerTool({
    description: report
      ? REPORT_DONE_DESCRIPTION
      : 'Finish this factory stage once your reply is written as text. Call it once, as your last tool call; the session ends after it. If a message still arrives, follow it. Do not call it again in the same turn and do not call caller_ping.',
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (report) {
        const problems = workReportProblems(params, {
          feedbackItems,
          worktree: env['FACTORY_WORKTREE'] ?? process.cwd(),
        });
        if (problems.length > 0) {
          // A thrown error is a failed tool result: the run goes on.
          throw new Error(refusal(problems));
        }
        return finish();
      }
      // A Pi without a tool context cannot be checked; it ends as before.
      const entries = (ctx as typeof ctx | undefined)?.sessionManager.getEntries();
      // Asked once per run; a second call ends the run either way.
      if (
        env['FACTORY_REPLY_REQUIRED'] === '1' &&
        !replyNudged &&
        entries !== undefined &&
        replyIsMissing(entries as ReadonlyArray<SessionEntryLike>)
      ) {
        replyNudged = true;
        return { content: [{ text: MISSING_REPLY, type: 'text' }], details: undefined };
      }
      return finish();
    },
    label: 'Done',
    name: 'subagent_done',
    parameters: report ? (WORK_REPORT_PARAMETERS as unknown as ToolParameters) : doneParameters,
  });
  pi.registerTool({
    description:
      'Ask the human a question you cannot answer. This replaces the stage template. Do not use it to report that the work is finished.',
    async execute(_toolCallId, params: { message?: string }) {
      const message = typeof params.message === 'string' ? params.message : '';
      ending ??= { message, name: pingName(env), type: 'ping' };
      return {
        content: [{ text: PING_RESULT, type: 'text' }],
        details: undefined,
        terminate: true,
      };
    },
    label: 'Ping',
    name: 'caller_ping',
    parameters: pingParameters,
  });
  // Every tool result of the turn is saved by now, and no request has started.
  pi.on('turn_end', (event) => {
    if (report && ending === null) {
      missed += event.toolResults.filter(
        (result) => result.toolName === 'subagent_done' && result.isError,
      ).length;
      // An agent that cannot produce a report stops here, without one, for
      // the controller to handle, rather than spending requests on it.
      if (missed >= REPORT_ATTEMPTS) {
        ending = { type: 'done' };
      }
    }
    if (ending === null) {
      return;
    }
    writeTerminal(env['PI_SUBAGENT_SESSION'], ending);
    deps.exit(0);
  });
  let nudges = 0;
  pi.on('agent_end', (event, ctx) => {
    const step = afterFailedTurn(event.messages, nudges);
    if (step.kind === 'nudge') {
      nudges += 1;
      setTimeout(() => {
        // Pi may have retried on its own meanwhile.
        if (ctx.isIdle()) {
          pi.sendUserMessage(NUDGE_PROMPT);
        }
      }, step.delayMs);
      return;
    }
    if (step.kind === 'exit') {
      deps.exit(1);
      return;
    }
    nudges = 0;
    if (env['PI_SUBAGENT_AUTO_EXIT'] !== '1' || !shouldAutoExit(event.messages)) {
      return;
    }
    // A run with a report ends only through subagent_done: a turn that ends
    // without the call, however its reply reads, is asked for it, and counts
    // as a missed report.
    if (report && ending === null) {
      missed += 1;
      if (missed < REPORT_ATTEMPTS) {
        pi.sendUserMessage(REPORT_NUDGE, { deliverAs: 'followUp' });
        return;
      }
    }
    writeTerminal(env['PI_SUBAGENT_SESSION'], { type: 'done' });
    deps.exit(0);
  });
}
