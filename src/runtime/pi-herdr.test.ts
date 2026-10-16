import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mock, test } from 'node:test';
import { runId, sessionId } from '../domain.ts';
import {
  classifySidecar,
  createPiHerdrRuntime,
  gateExitSidecar,
  herdrAgentPromptArgs,
  herdrMetadataArgs,
  herdrPaneArgs,
  herdrProcessInfoArgs,
  herdrRenameArgs,
  markedPrompt,
  paneProcessIsLive,
  parsePaneId,
  promptMarker,
  renderLaunchScript,
  usageFromSession,
} from './pi-herdr.ts';

test('classifies pi-herdr sidecars into one terminal kind', () => {
  assert.equal(
    classifySidecar({
      exitCodeText: null,
      exitJson: '{"type":"done"}',
      runId: 'run-1',
      sessionEntryCount: 2,
      trigger: 'sidecar',
      withinStartupWindow: false,
    }).kind,
    'subagent_done',
  );
  assert.deepEqual(
    classifySidecar({
      exitCodeText: null,
      exitJson: '{"type":"ping","message":"Which API?"}',
      runId: 'run-1',
      sessionEntryCount: 2,
      trigger: 'sidecar',
      withinStartupWindow: false,
    }),
    { kind: 'caller_ping', question: 'Which API?' },
  );
  assert.equal(
    classifySidecar({
      exitCodeText: '0 run-1',
      exitJson: null,
      runId: 'run-1',
      sessionEntryCount: 2,
      trigger: 'sidecar',
      withinStartupWindow: false,
    }).kind,
    'completed_user_exit',
  );
  assert.equal(
    classifySidecar({
      exitCodeText: '1 run-1',
      exitJson: null,
      runId: 'run-1',
      sessionEntryCount: 0,
      trigger: 'sidecar',
      withinStartupWindow: true,
    }).kind,
    'launch_failed',
  );
  assert.equal(
    classifySidecar({
      exitCodeText: '1 other-run',
      exitJson: null,
      runId: 'run-1',
      sessionEntryCount: 0,
      trigger: 'sidecar',
      withinStartupWindow: true,
    }).kind,
    'pending',
  );
  assert.equal(
    classifySidecar({
      exitCodeText: null,
      exitJson: null,
      runId: 'run-1',
      sessionEntryCount: 0,
      trigger: 'event',
      withinStartupWindow: false,
    }).kind,
    'pane_killed',
  );
  assert.equal(
    classifySidecar({
      exitCodeText: null,
      exitJson: null,
      runId: 'run-1',
      sessionEntryCount: 0,
      trigger: 'gone',
      withinStartupWindow: false,
    }).kind,
    'gap_exit',
  );
});

test('herdr launch uses the generic argv pane contract', () => {
  assert.deepEqual(
    herdrPaneArgs({ cwd: '/repo', launchScript: '/tmp/run.sh', targetPaneId: 'pane-parent' }),
    [
      'plugin',
      'pane',
      'open',
      '--plugin',
      'pi-herdr-subagents',
      '--entrypoint',
      'argv',
      '--placement',
      'split',
      '--target-pane',
      'pane-parent',
      '--direction',
      'right',
      '--cwd',
      '/repo',
      '--env',
      'PI_HERDR_LAUNCH_SCRIPT=/tmp/run.sh',
      '--no-focus',
    ],
  );
  const script = renderLaunchScript({
    handshakePath: '/pkg/child-handshake.ts',
    model: 'work-model',
    piBin: 'pi',
    promptFile: '/tmp/prompt.txt',
    runId: 'run-1',
    sessionFile: '/tmp/session.jsonl',
    thinking: 'medium',
    tools: 'read,bash,grep,find,ls,caller_ping,subagent_done',
  });
  assert.match(script, /trap '' TSTP/);
  assert.match(script, /-e '\/pkg\/child-handshake\.ts'/);
  assert.match(script, /PI_SUBAGENT_AUTO_EXIT=1/);
  assert.match(script, /FACTORY_CHILD=1/);
  assert.match(script, /--tools 'read,bash,grep,find,ls,caller_ping,subagent_done'/);
  assert.match(script, / '@\/tmp\/prompt\.txt'/);
  assert.match(script, /\.exitcode/);
  assert.doesNotMatch(script, /--print|(^|\s)-p(\s|$)/);
  assert.doesNotMatch(script, /\nexec /);
  assert.doesNotMatch(script, /subagent_resume/);
  assert.deepEqual(herdrRenameArgs('pane-1', '🔎 owner/repo#3'), [
    'pane',
    'rename',
    'pane-1',
    '🔎 owner/repo#3',
  ]);
});

test('pane id comes from the nested herdr plugin pane payload', () => {
  const stdout = `${JSON.stringify({ result: { plugin_pane: { pane: { pane_id: 'pane-child' } } } })}\n`;
  assert.equal(parsePaneId(stdout), 'pane-child');
  assert.equal(
    parsePaneId(JSON.stringify({ plugin_pane: { pane: { pane_id: 'pane-direct' } } })),
    'pane-direct',
  );
  assert.equal(parsePaneId('pane-bare'), 'pane-bare');
  assert.equal(parsePaneId('{"result":{"plugin_pane":{}}}'), null);
});

test('session usage sums every request in the session', () => {
  const usage = usageFromSession(
    [
      JSON.stringify({
        message: {
          usage: {
            cacheRead: 1,
            cacheWrite: 2,
            cost: { total: 0.001 },
            input: 10,
            output: 4,
            totalTokens: 17,
          },
        },
      }),
      JSON.stringify({ message: { role: 'user' } }),
      JSON.stringify({
        message: {
          usage: {
            cacheRead: 100,
            cacheWrite: 0,
            cost: { total: 0.0025 },
            input: 3,
            output: 50,
            totalTokens: 153,
          },
        },
      }),
      '',
    ].join('\n'),
  );
  assert.equal(usage.inputTokens, 13);
  assert.equal(usage.outputTokens, 54);
  assert.equal(usage.cacheReadTokens, 101);
  assert.equal(usage.totalTokens, 170);
  assert.equal(usage.costUsdMicros, 3500);
});

test('a done sidecar is ignored until this run prompt is in the session', () => {
  assert.equal(
    classifySidecar({
      exitCodeText: null,
      exitJson: '{"type":"done"}',
      runId: 'run-2',
      sessionEntryCount: 4,
      sessionText: 'Factory run run-1\n',
      trigger: 'sidecar',
      withinStartupWindow: false,
    }).kind,
    'pending',
  );
  assert.deepEqual(
    gateExitSidecar({
      exitJson: '{"type":"done"}',
      runId: 'run-2',
      sessionText: 'Factory run run-1\n',
    }),
    { discard: true, exitJson: null },
  );
  assert.equal(
    classifySidecar({
      exitCodeText: null,
      exitJson: '{"type":"done"}',
      runId: 'run-2',
      sessionEntryCount: 5,
      sessionText: `previous\n${promptMarker('run-2')}\n`,
      trigger: 'sidecar',
      withinStartupWindow: false,
    }).kind,
    'subagent_done',
  );
  assert.equal(markedPrompt('run-2', 'Fix the lint.'), `Fix the lint.\n${promptMarker('run-2')}`);
});

test('a reused launch script exit counts for the correction once its prompt is in the session', () => {
  const marker = promptMarker('run-2');
  const done = JSON.stringify({
    message: {
      content: [{ arguments: {}, name: 'subagent_done', type: 'toolCall' }],
      role: 'assistant',
    },
  });
  const ping = JSON.stringify({
    message: {
      content: [
        {
          arguments: { message: 'Which API?' },
          name: 'caller_ping',
          type: 'toolCall',
        },
      ],
      role: 'assistant',
    },
  });
  const base = {
    exitJson: null,
    runId: 'run-2',
    sessionEntryCount: 6,
    trigger: 'sidecar' as const,
    withinStartupWindow: false,
  };
  assert.equal(
    classifySidecar({
      ...base,
      exitCodeText: '0 run-1',
      sessionText: `call subagent_done\n${marker}\n${done}`,
    }).kind,
    'subagent_done',
  );
  assert.deepEqual(
    classifySidecar({
      ...base,
      exitCodeText: '0 run-1',
      sessionText: `${marker}\nthen call subagent_done\n${ping}`,
    }),
    { kind: 'caller_ping', question: 'Which API?' },
  );
  assert.equal(
    classifySidecar({
      ...base,
      exitCodeText: '1 run-1',
      sessionText: `${marker}\n`,
    }).kind,
    'crashed',
  );
  assert.equal(
    classifySidecar({
      ...base,
      exitCodeText: '0 run-1',
      sessionText: 'Factory run run-1\n',
    }).kind,
    'pending',
  );
  assert.equal(
    classifySidecar({
      ...base,
      exitCodeText: '0 run-2',
      sessionText: `${marker}\n${done}`,
    }).kind,
    'completed_user_exit',
  );
});

test('herdr process info treats a live foreground pid as the existing pane', () => {
  assert.deepEqual(herdrProcessInfoArgs('pane-old'), [
    'pane',
    'process-info',
    '--pane',
    'pane-old',
  ]);
  assert.equal(
    paneProcessIsLive(
      0,
      JSON.stringify({
        result: { process_info: { foreground_processes: [{ pid: 9 }], shell_pid: 4 } },
      }),
    ),
    true,
  );
  assert.equal(
    paneProcessIsLive(
      0,
      JSON.stringify({ result: { process_info: { foreground_processes: [], shell_pid: null } } }),
    ),
    false,
  );
  assert.equal(paneProcessIsLive(1, ''), false);
});

test('resume prompts a live pane and replaces a dead one', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-resume-'));
  const calls: Array<Array<string>> = [];
  let live = true;
  const runtime = createPiHerdrRuntime({
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'pane' && args[1] === 'process-info') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({
            result: {
              process_info: live
                ? { foreground_processes: [{ pid: 9 }], shell_pid: 4 }
                : { foreground_processes: [], shell_pid: null },
            },
          }),
        };
      }
      if (args[0] === 'plugin') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({ result: { plugin_pane: { pane_id: 'pane-new' } } }),
        };
      }
      return { code: 0, stderr: '', stdout: '' };
    },
    targetPaneId: 'parent',
  });
  const spec = {
    cwd: directory,
    mode: 'resume' as const,
    model: 'work-model',
    paneName: '🛠 repo#1 01',
    previousPaneId: 'pane-old',
    prompt: 'Fix the lint.',
    purpose: 'validation_correction' as const,
    runId: runId('run-2'),
    sessionFile: path.join(directory, 'session.jsonl'),
    sessionId: sessionId('session-1'),
    stage: 'work' as const,
    taskLabel: 'Fix lint · 2 left',
    thinking: 'medium',
    tools: 'read,bash',
  };
  const reused = await runtime.resume(spec);
  assert.equal(reused.paneId, 'pane-old');
  assert.deepEqual(calls[0], herdrProcessInfoArgs('pane-old'));
  assert.deepEqual(calls[1], herdrAgentPromptArgs('pane-old', markedPrompt('run-2', spec.prompt)));
  assert.deepEqual(
    calls[2],
    herdrMetadataArgs({
      paneId: 'pane-old',
      purpose: 'validation_correction',
      seq: 1,
      taskLabel: 'Fix lint · 2 left',
    }),
  );
  assert.equal(
    calls.some((args) => args[0] === 'plugin'),
    false,
  );
  calls.length = 0;
  live = false;
  const replaced = await runtime.resume({
    ...spec,
    purpose: 'initial',
    runId: runId('run-3'),
    taskLabel: null,
  });
  assert.equal(replaced.paneId, 'pane-new');
  assert.deepEqual(calls[1], ['pane', 'close', 'pane-old']);
  assert.equal(calls[2]?.[0], 'plugin');
  assert.equal(
    calls.some(
      (args) => args.includes('status=initial') && !args.some((arg) => arg.startsWith('task=')),
    ),
    true,
  );
  assert.match(readFileSync(`${spec.sessionFile}.sh`, 'utf8'), /-e '.*child-handshake\.ts'/);
});

test('observe deletes a stale done until the new prompt is in the session', async () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-watch-'));
  const sessionFile = path.join(directory, 'session.jsonl');
  writeFileSync(sessionFile, '{"type":"message","message":{"role":"assistant","content":"old"}}\n');
  writeFileSync(`${sessionFile}.exit`, '{"type":"done"}');
  const events: Array<string> = [];
  const runtime = createPiHerdrRuntime({
    events: null,
    pollMs: 1000,
    run: async () => ({ code: 0, stderr: '', stdout: '' }),
    targetPaneId: 'parent',
  });
  const stop = runtime.observe(
    { paneId: 'pane-old', runId: runId('run-2'), sessionFile },
    (event) => {
      events.push(event.kind);
    },
  );
  try {
    mock.timers.tick(1000);
    assert.deepEqual(events, []);
    assert.equal(existsSync(`${sessionFile}.exit`), false);
    writeFileSync(
      sessionFile,
      `${readFileSync(sessionFile, 'utf8')}${JSON.stringify({ message: { content: promptMarker('run-2') } })}\n`,
    );
    writeFileSync(`${sessionFile}.exit`, '{"type":"done"}');
    mock.timers.tick(1000);
    assert.deepEqual(events, ['subagent_done']);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test('a pane exit records the sidecar once', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-pane-exit-'));
  const sessionFile = path.join(directory, 'session.jsonl');
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ message: { content: promptMarker('run-4') } })}\n`,
  );
  writeFileSync(`${sessionFile}.exit`, '{"type":"done"}');
  let notify: (() => void) | undefined;
  const runtime = createPiHerdrRuntime({
    events: {
      watch(_paneId, listener) {
        notify = () => {
          listener({ event: 'pane_exited', paneId: 'pane-4' });
        };
        return () => undefined;
      },
    },
    pollMs: 1000,
    run: async () => ({ code: 0, stderr: '', stdout: '' }),
    targetPaneId: 'parent',
  });
  const events: Array<string> = [];
  const stop = runtime.observe(
    { paneId: 'pane-4', runId: runId('run-4'), sessionFile },
    (event) => {
      events.push(event.kind);
    },
  );
  try {
    notify?.();
    assert.deepEqual(events, ['subagent_done']);
    mock.timers.tick(5000);
    assert.deepEqual(events, ['subagent_done']);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test('a pane exit waits one poll for the exit code written after pi', () => {
  mock.timers.enable({ apis: ['setInterval'] });
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-pane-code-'));
  const sessionFile = path.join(directory, 'session.jsonl');
  writeFileSync(
    sessionFile,
    `${JSON.stringify({ message: { content: promptMarker('run-5') } })}\n`,
  );
  let notify: (() => void) | undefined;
  const runtime = createPiHerdrRuntime({
    events: {
      watch(_paneId, listener) {
        notify = () => {
          listener({ event: 'pane_closed', paneId: 'pane-5' });
        };
        return () => undefined;
      },
    },
    pollMs: 1000,
    run: async () => ({ code: 0, stderr: '', stdout: '' }),
    targetPaneId: 'parent',
  });
  const events: Array<string> = [];
  const stop = runtime.observe(
    { paneId: 'pane-5', runId: runId('run-5'), sessionFile },
    (event) => {
      events.push(event.kind);
    },
  );
  try {
    notify?.();
    assert.deepEqual(events, []);
    writeFileSync(`${sessionFile}.exitcode`, '0 run-5');
    mock.timers.tick(1000);
    assert.deepEqual(events, ['completed_user_exit']);
    mock.timers.tick(1000);
    assert.deepEqual(events, ['completed_user_exit']);
  } finally {
    stop();
    mock.timers.reset();
  }
});

test('a ticket runs its agents in its tab root shell, splits only when the root is busy, and keeps the tab', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-tabs-'));
  const tabsFile = path.join(directory, 'runtime', 'tabs.json');
  const calls: Array<Array<string>> = [];
  let tabs = 0;
  const gone = new Set<string>();
  const run = async (args: Array<string>) => {
    calls.push(args);
    if (args[0] === 'pane' && args[1] === 'get') {
      const pane = args[2] ?? '';
      return gone.has(pane)
        ? { code: 1, stderr: 'no such pane', stdout: '' }
        : {
            code: 0,
            stderr: '',
            stdout: JSON.stringify({ result: { pane: { pane_id: pane, workspace_id: 'ws-1' } } }),
          };
    }
    if (args[0] === 'tab' && args[1] === 'create') {
      tabs += 1;
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({
          result: { root_pane: { pane_id: `root-${tabs}` }, tab: { tab_id: `tab-${tabs}` } },
        }),
      };
    }
    if (args[0] === 'plugin') {
      return {
        code: 0,
        stderr: '',
        stdout: JSON.stringify({ result: { plugin_pane: { pane_id: `split-${calls.length}` } } }),
      };
    }
    return { code: 0, stderr: '', stdout: '' };
  };
  const spec = (ticket: string, id: string, previousPaneId: string | null = null) => ({
    cwd: directory,
    mode: 'launch' as const,
    model: 'work-model',
    paneName: `🛠 ${ticket}`,
    previousPaneId,
    prompt: 'Work.',
    purpose: 'initial' as const,
    runId: runId(id),
    sessionFile: path.join(directory, `${id}.jsonl`),
    sessionId: sessionId(id),
    stage: 'work' as const,
    tab: { key: `${ticket}-key`, label: ticket },
    taskLabel: null,
    thinking: 'medium',
    tools: 'read',
  });
  const finish = (id: string) =>
    writeFileSync(path.join(directory, `${id}.jsonl.exitcode`), `0 ${id}\n`);
  // Where each pane went: `run <pane>` for a root shell, `split <target>` for a split.
  const placements = () =>
    calls.flatMap((args) =>
      args[0] === 'pane' && args[1] === 'run'
        ? [`run ${args[2]}`]
        : args[0] === 'plugin'
          ? [`split ${args[args.indexOf('--target-pane') + 1]}`]
          : [],
    );

  const runtime = createPiHerdrRuntime({ run, tabsFile, targetPaneId: 'server' });
  const first = await runtime.launch(spec('repo#1', 'r1'));
  assert.equal(first.paneId, 'root-1');
  assert.match(
    calls.find((args) => args[1] === 'run')?.[3] ?? '',
    /^cd '.*' && '.*r1\.jsonl\.sh'$/,
  );
  // r1 is still running: the next pane for repo#1 splits beside it.
  await runtime.launch(spec('repo#1', 'r2'));
  await runtime.launch(spec('repo#2', 'r3'));
  finish('r1');
  await runtime.launch(spec('repo#1', 'r4'));
  assert.deepEqual(placements(), ['run root-1', 'split root-1', 'run root-2', 'run root-1']);
  const created = calls.filter((args) => args[0] === 'tab' && args[1] === 'create');
  assert.equal(created.length, 2);
  assert.deepEqual(created[0]?.slice(2, 4), ['--workspace', 'ws-1']);

  // A restarted runtime remembers the tab and what runs in its root.
  const restarted = createPiHerdrRuntime({ run, tabsFile, targetPaneId: 'server' });
  calls.length = 0;
  await restarted.launch(spec('repo#1', 'r5'));
  finish('r4');
  // A resume never closes a root shell; the finished root runs the next turn.
  await restarted.resume({ ...spec('repo#1', 'r6', 'root-1'), mode: 'resume' });
  assert.deepEqual(placements(), ['split root-1', 'run root-1']);
  assert.equal(
    calls.some((args) => args[0] === 'pane' && args[1] === 'close'),
    false,
  );

  // A tab whose root is gone is made again.
  gone.add('root-2');
  calls.length = 0;
  await restarted.launch(spec('repo#2', 'r7'));
  assert.deepEqual(placements(), ['run root-3']);

  // Handoff: the first pane takes the free root, the second splits beside it.
  finish('r6');
  calls.length = 0;
  for (const name of ['📦 repo#1', '🔀 repo#1']) {
    await restarted.openPane({
      cwd: directory,
      name,
      scriptFile: path.join(directory, `${name.length}.sh`),
      tab: { key: 'repo#1-key', label: 'repo#1' },
      target: { kind: 'session', sessionFile: path.join(directory, 'r6.jsonl') },
    });
  }
  assert.deepEqual(placements(), ['run root-1', 'split root-1']);

  await restarted.closeTab?.('repo#1-key');
  assert.deepEqual(calls.at(-1), ['tab', 'close', 'tab-1']);
  assert.equal(JSON.parse(readFileSync(tabsFile, 'utf8'))['repo#1-key'], undefined);
});

test('a tab that cannot be made falls back to the server pane', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'factory-tabs-'));
  const calls: Array<Array<string>> = [];
  const runtime = createPiHerdrRuntime({
    run: async (args) => {
      calls.push(args);
      if (args[0] === 'tab') {
        return { code: 1, stderr: 'no workspace', stdout: '' };
      }
      if (args[0] === 'plugin') {
        return {
          code: 0,
          stderr: '',
          stdout: JSON.stringify({ result: { plugin_pane: { pane_id: 'p' } } }),
        };
      }
      return { code: 0, stderr: '', stdout: '' };
    },
    targetPaneId: 'server',
  });
  await runtime.launch({
    cwd: directory,
    mode: 'launch',
    model: 'm',
    paneName: 'x',
    previousPaneId: null,
    prompt: 'p',
    purpose: 'initial',
    runId: runId('r'),
    sessionFile: path.join(directory, 'r.jsonl'),
    sessionId: sessionId('s'),
    stage: 'plan',
    tab: { key: 'k', label: 'repo#1' },
    taskLabel: null,
    thinking: 'medium',
    tools: 'read',
  });
  const plugin = calls.find((args) => args[0] === 'plugin') ?? [];
  assert.equal(plugin[plugin.indexOf('--target-pane') + 1], 'server');
});
