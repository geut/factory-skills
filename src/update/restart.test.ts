import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderRestartScript, waitForHandoff } from './restart.ts';

test('the restart script carries the server environment and starts the new server after this one', () => {
  const script = renderRestartScript({
    after: 'instance-1',
    binary: '/opt/factory/factory',
    codeRoot: '/work/app',
    env: {
      FACTORY_LAUNCH_SCRIPT: '/tmp/old.sh',
      HERDR_PANE_ID: 'pane-1',
      LINEAR_API_KEY: "lin_'key",
      'not a name': 'x',
      PATH: '/usr/bin:/bin',
      PWD: '/elsewhere',
    },
    paneId: 'pane-1',
    waitPid: 4242,
  });
  assert.equal(
    script,
    `#!/usr/bin/env bash
rm -f -- "$0"
export LINEAR_API_KEY='lin_'\\''key'
export PATH='/usr/bin:/bin'
export HERDR_PANE_ID="\${HERDR_PANE_ID:-pane-1}"
cd '/work/app' || exit 1
while kill -0 4242 2>/dev/null; do sleep 0.2; done
exec '/opt/factory/factory' serve --after 'instance-1'
`,
  );
});

test('the new server waits for the old one to hand back the lease, and gives up', async () => {
  let checks = 0;
  assert.equal(
    await waitForHandoff({
      held: () => {
        checks += 1;
        return checks < 3;
      },
      pollMs: 1,
    }),
    true,
  );
  assert.equal(await waitForHandoff({ held: () => true, pollMs: 1, timeoutMs: 5 }), false);
});

test('a rollback starts the older binary without --after, once this server has exited', () => {
  const script = renderRestartScript({
    after: null,
    binary: '/opt/factory/factory',
    codeRoot: '/work/app',
    env: {},
    paneId: 'pane-1',
    waitPid: 4242,
  });
  assert.match(
    script,
    /while kill -0 4242 2>\/dev\/null; do sleep 0\.2; done\nexec '\/opt\/factory\/factory' serve\n$/,
  );
});
