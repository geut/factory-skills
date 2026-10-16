import { writeFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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

export default function factoryChildHandshake(pi: ExtensionAPI): void {
  const writeTerminal = createTerminalWriter();
  let replyNudged = false;

  pi.registerTool({
    description:
      'Finish this factory stage once your reply is written as text. Call it once. The process exits immediately. If a reply still arrives, stop. Do not call it again and do not call caller_ping.',
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      // A Pi without a tool context cannot be checked; it ends as before.
      const entries = (ctx as typeof ctx | undefined)?.sessionManager.getEntries();
      // Asked once per run; a second call ends the run either way.
      if (
        process.env['FACTORY_REPLY_REQUIRED'] === '1' &&
        !replyNudged &&
        entries !== undefined &&
        replyIsMissing(entries as ReadonlyArray<SessionEntryLike>)
      ) {
        replyNudged = true;
        return { content: [{ text: MISSING_REPLY, type: 'text' }], details: undefined };
      }
      writeTerminal(process.env['PI_SUBAGENT_SESSION'], { type: 'done' });
      process.exit(0);
    },
    label: 'Done',
    name: 'subagent_done',
    parameters: doneParameters,
  });
  pi.registerTool({
    description:
      'Ask the human a question you cannot answer. This replaces the stage template. Do not use it to report that the work is finished.',
    async execute(_toolCallId, params: { message?: string }) {
      const message = typeof params.message === 'string' ? params.message : '';
      writeTerminal(process.env['PI_SUBAGENT_SESSION'], {
        message,
        name: pingName(process.env),
        type: 'ping',
      });
      process.exit(0);
    },
    label: 'Ping',
    name: 'caller_ping',
    parameters: pingParameters,
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
      process.exit(1);
    }
    nudges = 0;
    if (process.env['PI_SUBAGENT_AUTO_EXIT'] !== '1' || !shouldAutoExit(event.messages)) {
      return;
    }
    writeTerminal(process.env['PI_SUBAGENT_SESSION'], { type: 'done' });
    process.exit(0);
  });
}
