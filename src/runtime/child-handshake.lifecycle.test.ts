import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type FauxResponseStep,
} from '@earendil-works/pi-ai';
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import factoryChildHandshake, {
  DONE_RESULT,
  MISSING_REPLY,
  PING_RESULT,
} from './child-handshake.ts';

// The handshake in a real Pi session, on Pi's scripted model: what the session
// file holds when the child exits, and what a resumed session sends the model.

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

// What the controller would find the moment the child exits, and how many
// model requests had run by then.
type Exit = { code: number; requests: number; results: Array<string>; sidecar: string | null };

// Session file entries as `role` or `toolResult <id>`.
function roles(file: string): Array<string> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const entry: unknown = JSON.parse(line);
      if (typeof entry !== 'object' || entry === null || !('message' in entry)) {
        return [];
      }
      const message = entry.message as { role: string; toolCallId?: string };
      return [
        message.role === 'toolResult' ? `toolResult ${message.toolCallId ?? ''}` : message.role,
      ];
    });
}

async function child(input: {
  // An existing session to resume, else a new one.
  dir?: string;
  env?: Record<string, string>;
  extra?: (pi: ExtensionAPI) => void;
  responses: Array<FauxResponseStep>;
  sessionFile?: string;
}) {
  const dir = input.dir ?? mkdtempSync(path.join(tmpdir(), 'factory-handshake-'));
  if (input.dir === undefined) {
    dirs.push(dir);
  }
  const agentDir = path.join(dir, 'agent');
  const faux = fauxProvider({ models: [{ id: 'faux-1' }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: path.join(agentDir, 'auth.json'),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const sessionManager =
    input.sessionFile === undefined
      ? SessionManager.create(dir, path.join(dir, 'sessions'))
      : SessionManager.open(input.sessionFile, path.join(dir, 'sessions'));
  const sessionFile = sessionManager.getSessionFile() ?? assert.fail('no session file');
  const exits: Array<Exit> = [];
  const loader = new DefaultResourceLoader({
    agentDir,
    cwd: dir,
    extensionFactories: [
      (pi) => {
        factoryChildHandshake(pi, {
          env: { PI_SUBAGENT_SESSION: sessionFile, ...input.env },
          exit: (code) => {
            exits.push({
              code,
              requests: faux.state.callCount,
              results: roles(sessionFile).filter((role) => role.startsWith('toolResult')),
              sidecar: existsSync(`${sessionFile}.exit`)
                ? readFileSync(`${sessionFile}.exit`, 'utf8')
                : null,
            });
          },
        });
        input.extra?.(pi);
      },
    ],
    noExtensions: true,
  });
  await loader.reload();
  faux.setResponses(input.responses);
  const { session } = await createAgentSession({
    agentDir,
    cwd: dir,
    model: faux.getModel(),
    modelRuntime,
    noTools: 'builtin',
    resourceLoader: loader,
    sessionManager,
    settingsManager: SettingsManager.inMemory(),
  });
  return { dir, exits, faux, session, sessionFile };
}

const report = fauxText('## Status\n\nready_for_review');

test('subagent_done saves its result before the child exits, and a correction resumes valid history', async () => {
  const first = await child({
    responses: [
      fauxAssistantMessage([report, fauxToolCall('subagent_done', {}, { id: 'toolu_done' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('a request after the terminal call'),
    ],
  });
  await first.session.prompt('Do the task.');
  // The result is in the session file before the sidecar tells the controller
  // the run ended, and no model request follows the terminal call.
  assert.deepEqual(first.exits, [
    { code: 0, requests: 1, results: ['toolResult toolu_done'], sidecar: '{"type":"done"}' },
  ]);
  assert.equal(first.faux.state.callCount, 1);
  assert.deepEqual(roles(first.sessionFile), [
    'system',
    'user',
    'assistant',
    'toolResult toolu_done',
  ]);

  // The controller resumes the same session with a validation correction.
  rmSync(`${first.sessionFile}.exit`);
  let sent: Array<{ content?: unknown; role: string; toolCallId?: string }> = [];
  const resumed = await child({
    dir: first.dir,
    responses: [
      (context) => {
        sent = context.messages as typeof sent;
        return fauxAssistantMessage(
          [report, fauxToolCall('subagent_done', {}, { id: 'toolu_again' })],
          {
            stopReason: 'toolUse',
          },
        );
      },
    ],
    sessionFile: first.sessionFile,
  });
  await resumed.session.prompt('Validation failed. Correct the task and continue.');
  const tail = sent.slice(-3);
  assert.deepEqual(
    tail.map((message) => message.role),
    ['assistant', 'toolResult', 'user'],
  );
  assert.equal(tail[1]?.toolCallId, 'toolu_done');
  assert.match(JSON.stringify(tail[1]?.content), new RegExp(DONE_RESULT.slice(0, 30)));
});

test('caller_ping saves its result, publishes the question, and a reply resumes valid history', async () => {
  const first = await child({
    env: { PI_SUBAGENT_NAME: 'work-01' },
    responses: [
      fauxAssistantMessage(
        [fauxToolCall('caller_ping', { message: 'Which API?' }, { id: 'toolu_ping' })],
        { stopReason: 'toolUse' },
      ),
    ],
  });
  await first.session.prompt('Do the task.');
  assert.deepEqual(first.exits, [
    {
      code: 0,
      requests: 1,
      results: ['toolResult toolu_ping'],
      sidecar: '{"type":"ping","name":"work-01","message":"Which API?"}',
    },
  ]);
  rmSync(`${first.sessionFile}.exit`);
  let sent: Array<{ content?: unknown; role: string; toolCallId?: string }> = [];
  const resumed = await child({
    dir: first.dir,
    responses: [
      (context) => {
        sent = context.messages as typeof sent;
        return fauxAssistantMessage('Thanks.');
      },
    ],
    sessionFile: first.sessionFile,
  });
  await resumed.session.prompt('Use the REST API.');
  const tail = sent.slice(-3);
  assert.deepEqual(
    tail.map((message) => message.role),
    ['assistant', 'toolResult', 'user'],
  );
  assert.equal(tail[1]?.toolCallId, 'toolu_ping');
  assert.match(JSON.stringify(tail[1]?.content), new RegExp(PING_RESULT.slice(0, 30)));
});

test('a terminal call batched with another tool leaves no call without a result, and no request follows', async () => {
  const first = await child({
    extra: (pi) => {
      pi.registerTool({
        description: 'Reads nothing.',
        async execute() {
          return { content: [{ text: 'read', type: 'text' }], details: undefined };
        },
        label: 'Look',
        name: 'look',
        parameters: { additionalProperties: false, properties: {}, type: 'object' } as never,
      });
    },
    responses: [
      fauxAssistantMessage(
        [
          report,
          fauxToolCall('look', {}, { id: 'toolu_look' }),
          fauxToolCall('subagent_done', {}, { id: 'toolu_done' }),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('a request after the terminal call'),
    ],
  });
  await first.session.prompt('Do the task.');
  // The child exits at the end of that turn, before Pi could ask the model
  // again: here `exit` only records, so Pi goes on after it.
  assert.deepEqual(first.exits.at(0), {
    code: 0,
    requests: 1,
    results: ['toolResult toolu_look', 'toolResult toolu_done'],
    sidecar: '{"type":"done"}',
  });
});

test('a done without a written reply is nudged once and the run goes on', async () => {
  const first = await child({
    env: { FACTORY_REPLY_REQUIRED: '1' },
    responses: [
      fauxAssistantMessage([fauxToolCall('subagent_done', {}, { id: 'toolu_early' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([report, fauxToolCall('subagent_done', {}, { id: 'toolu_done' })], {
        stopReason: 'toolUse',
      }),
    ],
  });
  await first.session.prompt('Do the task.');
  assert.equal(first.faux.state.callCount, 2);
  assert.deepEqual(first.exits, [
    {
      code: 0,
      requests: 2,
      results: ['toolResult toolu_early', 'toolResult toolu_done'],
      sidecar: '{"type":"done"}',
    },
  ]);
  assert.match(readFileSync(first.sessionFile, 'utf8'), new RegExp(MISSING_REPLY.slice(0, 30)));
});
