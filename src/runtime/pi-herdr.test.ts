import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifySidecar,
  herdrPaneArgs,
  herdrRenameArgs,
  parsePaneId,
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
    model: 'work-model',
    piBin: 'pi',
    promptFile: '/tmp/prompt.txt',
    runId: 'run-1',
    sessionFile: '/tmp/session.jsonl',
    subagentDonePath: '/pkg/subagent-done.ts',
    thinking: 'medium',
    tools: 'read,bash,grep,find,ls,caller_ping,subagent_done',
  });
  assert.match(script, /trap '' TSTP/);
  assert.match(script, /-e '\/pkg\/subagent-done\.ts'/);
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

test('session usage reads the latest assistant totals', () => {
  const usage = usageFromSession(
    `${JSON.stringify({ message: { usage: { cacheRead: 1, cacheWrite: 2, cost: { total: 0.001 }, input: 10, output: 4, totalTokens: 17 } } })}\n`,
  );
  assert.equal(usage.inputTokens, 10);
  assert.equal(usage.totalTokens, 17);
  assert.equal(usage.costUsdMicros, 1000);
});
