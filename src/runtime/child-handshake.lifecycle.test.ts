import assert from 'node:assert/strict';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxThinking,
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
  REPORT_ATTEMPTS,
} from './child-handshake.ts';
import { runReport } from './session-activity.ts';
import { REPORT_NUDGE } from './work-report.ts';

// A follow-up runs after the prompt resolves; wait for the child to exit.
async function waitForExit(exits: Array<unknown>): Promise<void> {
  for (let tries = 0; exits.length === 0 && tries < 100; tries += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

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

// The F3 session: every run ended on a thinking block that held the reply,
// then subagent_done with no arguments.
const onlyThought = (id: string) =>
  fauxAssistantMessage(
    [
      fauxThinking('The PII checker passes and the 35 view tests pass.'),
      fauxToolCall('subagent_done', {}, { id }),
    ],
    { stopReason: 'toolUse' },
  );

function reportWorktree(): string {
  const tree = mkdtempSync(path.join(tmpdir(), 'factory-report-tree-'));
  dirs.push(tree);
  mkdirSync(path.join(tree, 'tests'));
  writeFileSync(path.join(tree, 'tests', 'admin_views_test.py'), '');
  return tree;
}

// Only the arguments of a tool call whose result was an error, in order.
function refusedCalls(file: string): Array<string> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const entry = JSON.parse(line) as {
        message?: { isError?: boolean; role?: string; toolCallId?: string };
      };
      return entry.message?.role === 'toolResult' && entry.message.isError === true
        ? [entry.message.toolCallId ?? '']
        : [];
    });
}

test('a work run cannot end on a reply it only thought: the empty call is refused, and the report ends it', async () => {
  const tree = reportWorktree();
  const first = await child({
    env: { FACTORY_FEEDBACK_ITEMS: 'F1', FACTORY_REPORT: 'work', FACTORY_WORKTREE: tree },
    responses: [
      onlyThought('toolu_thought'),
      fauxAssistantMessage(
        [
          fauxToolCall(
            'subagent_done',
            {
              feedback_responses: [{ disposition: 'addressed', id: 'F1', note: 'named fields' }],
              status: 'ready_for_review',
              summary: 'The partial-release logs name each reviewed field.',
              validation_selection: {
                mode: 'focused',
                tests: [{ path: 'tests/admin_views_test.py', reason: 'covers the refusal logs' }],
              },
            },
            { id: 'toolu_report' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage('a request after the terminal call'),
    ],
  });
  await first.session.prompt('Do the task.\nFactory run run-1');
  // Pi refused the empty call against the report's parameters; the run went
  // on, and the report ended it.
  assert.deepEqual(first.exits, [
    {
      code: 0,
      requests: 2,
      results: ['toolResult toolu_thought', 'toolResult toolu_report'],
      sidecar: '{"type":"done"}',
    },
  ]);
  assert.deepEqual(refusedCalls(first.sessionFile), ['toolu_thought']);
  const text = readFileSync(first.sessionFile, 'utf8');
  assert.match(text, /summary/);
  // What the controller reads: the accepted report, never the thinking.
  const reply = runReport(text, 'run-1') ?? '';
  assert.match(
    reply,
    /## Validation selection\n\n- `tests\/admin_views_test.py`: covers the refusal logs/,
  );
  assert.match(reply, /- F1: addressed — named fields/);
  assert.doesNotMatch(reply, /PII checker/);
});

test('a report the handshake refuses names the fields, and the run goes on', async () => {
  const tree = reportWorktree();
  const first = await child({
    env: { FACTORY_FEEDBACK_ITEMS: '', FACTORY_REPORT: 'work', FACTORY_WORKTREE: tree },
    responses: [
      fauxAssistantMessage(
        [
          fauxToolCall(
            'subagent_done',
            {
              status: 'ready_for_review',
              summary: 'Done.',
              validation_selection: {
                mode: 'focused',
                tests: [{ path: 'tests/missing_test.py', reason: 'r' }],
              },
            },
            { id: 'toolu_missing' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
      fauxAssistantMessage(
        [
          fauxToolCall(
            'subagent_done',
            {
              status: 'ready_for_review',
              summary: 'Done.',
              validation_selection: { mode: 'default', reason: 'docs only' },
            },
            { id: 'toolu_default' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
    ],
  });
  await first.session.prompt('Do the task.\nFactory run run-1');
  assert.equal(first.exits.length, 1);
  assert.deepEqual(refusedCalls(first.sessionFile), ['toolu_missing']);
  const text = readFileSync(first.sessionFile, 'utf8');
  assert.match(text, /tests\/missing_test.py is not a file in this worktree/);
  assert.match(text, /No project checks were run/);
  // The refused call's arguments never count as the report.
  assert.match(runReport(text, 'run-1') ?? '', /## Validation selection\n\nnone \(docs only\)/);
});

test('an agent that keeps sending no report stops after the attempts, without one', async () => {
  const first = await child({
    env: { FACTORY_REPORT: 'work', FACTORY_WORKTREE: reportWorktree() },
    responses: [
      ...Array.from({ length: REPORT_ATTEMPTS }, (_, index) => onlyThought(`toolu_${index}`)),
      fauxAssistantMessage('a request after the last attempt'),
    ],
  });
  await first.session.prompt('Do the task.\nFactory run run-1');
  assert.equal(first.exits[0]?.requests, REPORT_ATTEMPTS);
  assert.equal(first.exits[0]?.sidecar, '{"type":"done"}');
  // Every call has its result, so the session resumes cleanly.
  assert.equal(refusedCalls(first.sessionFile).length, REPORT_ATTEMPTS);
  // The controller reads why there is no report, with the last refusal.
  const reply = runReport(readFileSync(first.sessionFile, 'utf8'), 'run-1') ?? '';
  assert.match(reply, /^## Report missing\n/);
  assert.match(
    reply,
    /- status: must have required properties status, summary, validation_selection/,
  );
});

test('a work turn that ends without subagent_done is asked for the report, not ended', async () => {
  const tree = reportWorktree();
  const first = await child({
    env: { FACTORY_REPORT: 'work', FACTORY_WORKTREE: tree, PI_SUBAGENT_AUTO_EXIT: '1' },
    responses: [
      // The reply as text, out of habit, and no call.
      fauxAssistantMessage('## Status\n\nready_for_review'),
      fauxAssistantMessage(
        [
          fauxToolCall(
            'subagent_done',
            {
              status: 'ready_for_review',
              summary: 'Done.',
              validation_selection: { mode: 'default', reason: 'docs only' },
            },
            { id: 'toolu_report' },
          ),
        ],
        { stopReason: 'toolUse' },
      ),
    ],
  });
  await first.session.prompt('Do the task.\nFactory run run-1');
  await waitForExit(first.exits);
  // Here `exit` only records, so Pi goes on after it; the first is the one.
  assert.equal(first.exits[0]?.requests, 2);
  assert.equal(first.exits[0]?.sidecar, '{"type":"done"}');
  const text = readFileSync(first.sessionFile, 'utf8');
  assert.match(text, new RegExp(REPORT_NUDGE.slice(0, 40)));
  assert.match(runReport(text, 'run-1') ?? '', /none \(docs only\)/);
});

test('a work agent that keeps ending turns without subagent_done stops without a report', async () => {
  const first = await child({
    env: {
      FACTORY_REPORT: 'work',
      FACTORY_WORKTREE: reportWorktree(),
      PI_SUBAGENT_AUTO_EXIT: '1',
    },
    responses: Array.from({ length: REPORT_ATTEMPTS + 1 }, () => fauxAssistantMessage('All done.')),
  });
  await first.session.prompt('Do the task.\nFactory run run-1');
  await waitForExit(first.exits);
  assert.equal(first.exits[0]?.requests, REPORT_ATTEMPTS);
  assert.equal(first.exits[0]?.sidecar, '{"type":"done"}');
  const reply = runReport(readFileSync(first.sessionFile, 'utf8'), 'run-1') ?? '';
  assert.match(reply, /^## Report missing\n/);
  assert.doesNotMatch(reply, /All done/);
});

test("Pi's own loader runs the handshake from a directory beside its report module, as the single executable writes them", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-handshake-files-'));
  dirs.push(dir);
  const runtime = path.join(dir, 'runtime');
  mkdirSync(runtime);
  for (const name of ['child-handshake.ts', 'ticket-access.ts', 'work-report.ts']) {
    copyFileSync(new URL(`./${name}`, import.meta.url), path.join(runtime, name));
  }
  const saved = process.env['FACTORY_REPORT'];
  process.env['FACTORY_REPORT'] = 'work';
  try {
    const loader = new DefaultResourceLoader({
      additionalExtensionPaths: [path.join(runtime, 'child-handshake.ts')],
      agentDir: path.join(dir, 'agent'),
      cwd: dir,
      noExtensions: true,
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    assert.deepEqual(loaded.errors, []);
    const done = loaded.extensions
      .flatMap((extension) => [...extension.tools.values()])
      .find((tool) => tool.definition.name === 'subagent_done');
    assert.ok(done !== undefined, 'the handshake registers subagent_done');
    assert.deepEqual((done.definition.parameters as { required?: Array<string> }).required, [
      'status',
      'summary',
      'validation_selection',
    ]);
  } finally {
    if (saved === undefined) {
      delete process.env['FACTORY_REPORT'];
    } else {
      process.env['FACTORY_REPORT'] = saved;
    }
  }
});
