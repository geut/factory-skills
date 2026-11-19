import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainTheme } from '../stories/story.ts';
import { reloadNeeded, renderReloadFooter, renderReloadNotice } from './reload-notice.ts';

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
