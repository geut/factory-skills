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

function pingName(env: NodeJS.ProcessEnv): string {
  const name = env['PI_SUBAGENT_NAME'];
  return name !== undefined && name.length > 0 ? name : 'factory';
}

export default function factoryChildHandshake(pi: ExtensionAPI): void {
  const writeTerminal = createTerminalWriter();

  pi.registerTool({
    description:
      'Finish this factory stage. Call it once. The process exits immediately. If a reply still arrives, stop. Do not call it again and do not call caller_ping.',
    async execute() {
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
  pi.on('agent_end', (event) => {
    if (process.env['PI_SUBAGENT_AUTO_EXIT'] !== '1' || !shouldAutoExit(event.messages)) {
      return;
    }
    writeTerminal(process.env['PI_SUBAGENT_SESSION'], { type: 'done' });
    process.exit(0);
  });
}
