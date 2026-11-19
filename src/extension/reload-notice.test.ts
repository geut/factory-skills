import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainTheme } from '../stories/story.ts';
import {
  createVersionAsks,
  reloadNeeded,
  renderReloadFooter,
  renderReloadNotice,
} from './reload-notice.ts';

test('a reload is needed only between different releases', () => {
  assert.deepEqual(reloadNeeded({ pi: '0.5.0+1ddf4f6', server: '0.6.0+9a8b7c6' }), {
    pi: '0.5.0',
    server: '0.6.0',
  });
  // Builds of one release, such as a checkout someone is working on.
  assert.equal(reloadNeeded({ pi: '0.5.0+1ddf4f6-dirty', server: '0.5.0+2eef5a7' }), null);
  assert.equal(reloadNeeded({ pi: 'unknown', server: '0.6.0' }), null);
});

test('the card names both versions and the command', () => {
  const notice = { pi: '0.5.0', server: '0.6.0' };
  assert.deepEqual(renderReloadNotice({ notice, theme: plainTheme, width: 80 }), [
    '⟳ The factory server is on 0.6.0; this Pi runs 0.5.0',
    '  → /reload loads the extension that matches it',
  ]);
  assert.equal(renderReloadFooter({ notice, theme: plainTheme }), '⟳ /reload for factory 0.6.0');
});

test('the version is asked once per server instance, one ask at a time', () => {
  const asks = createVersionAsks({ askAgainMs: 60_000, now: () => 0 });
  assert.equal(asks.shouldAsk('server-1'), true);
  // Still waiting for the answer.
  assert.equal(asks.shouldAsk('server-1'), false);
  asks.answered(true);
  assert.equal(asks.shouldAsk('server-1'), false);
  // A restart is a new instance; no server is never asked.
  assert.equal(asks.shouldAsk('server-2'), true);
  asks.answered(true);
  assert.equal(asks.shouldAsk(null), false);
  assert.equal(asks.shouldAsk('server-2'), true);
});

test('a failed ask is tried again after a minute, not on every poll', () => {
  let now = 0;
  const asks = createVersionAsks({ askAgainMs: 60_000, now: () => now });
  assert.equal(asks.shouldAsk('server-1'), true);
  asks.answered(false);
  for (now = 1000; now < 60_000; now += 1000) {
    assert.equal(asks.shouldAsk('server-1'), false, `asked again at ${now} ms`);
  }
  assert.equal(asks.shouldAsk('server-1'), true);
  asks.answered(true);
  now = 200_000;
  assert.equal(asks.shouldAsk('server-1'), false);
});
