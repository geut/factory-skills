import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hyperlink, visibleWidth } from '@earendil-works/pi-tui';
import { plainTheme } from '../stories/story.ts';
import { renderUpdateFooter, renderUpdateNotice } from './update-notice.ts';

const notice = {
  current: '0.3.0',
  installed: false,
  latest: '0.6.0',
  name: 'Factory updates itself',
  notesUrl: 'https://github.com/geut/factory-skills/compare/v0.3.0...v0.6.0',
};

test('the card names the newest release, links what changed, and gives the commands', () => {
  assert.deepEqual(renderUpdateNotice({ notice, theme: plainTheme, width: 80 }), [
    '⬆ factory 0.6.0 is available · you run 0.3.0',
    '  Factory updates itself',
    "  What's new in 0.6.0",
    '  https://github.com/geut/factory-skills/compare/v0.3.0...v0.6.0',
    '  → /factory update · later: /factory update --later',
  ]);
});

test('a release named after its tag skips the name, and links open in terminals that follow them', () => {
  const rows = renderUpdateNotice({
    link: hyperlink,
    notice: { ...notice, name: 'v0.6.0' },
    theme: plainTheme,
    width: 80,
  });
  assert.equal(rows[1], `  ${hyperlink("What's new in 0.6.0", notice.notesUrl)}`);
  assert.equal(rows.length, 4);
});

test('the card fits narrow terminals', () => {
  for (const row of renderUpdateNotice({ notice, theme: plainTheme, width: 24 })) {
    assert.ok(visibleWidth(row) <= 24, row);
  }
});

const footer = { installed: false, later: false, latest: '0.5.0', pending: false };

test('the footer line dims once the owner said later', () => {
  const marked = { ...plainTheme, fg: (color: string, text: string) => `[${color}]${text}` };
  assert.equal(renderUpdateFooter({ ...footer, theme: marked }), '[accent]⬆ factory 0.5.0');
  assert.equal(
    renderUpdateFooter({ ...footer, later: true, theme: marked }),
    '[dim]⬆ factory 0.5.0',
  );
});

test('an update another factory installed asks for a restart', () => {
  const rows = renderUpdateNotice({
    notice: { ...notice, current: '0.5.0', installed: true },
    theme: plainTheme,
    width: 100,
  });
  assert.equal(
    rows[0],
    '⬆ factory 0.6.0 is installed · restart to use it · this server runs 0.5.0',
  );
  assert.equal(
    renderUpdateFooter({ ...footer, installed: true, theme: plainTheme }),
    '⬆ factory 0.5.0 · restart',
  );
  assert.equal(
    renderUpdateFooter({ ...footer, pending: true, theme: plainTheme }),
    '⬆ factory 0.5.0 · when idle',
  );
});
