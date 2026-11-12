import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { FeedbackCandidate } from '../stages/feedback.ts';
import type { AgentsViewTheme } from './agents-view.ts';
import { FactoryFeedbackPicker, pickedFeedback, renderFeedbackPicker } from './feedback-picker.ts';

const theme: AgentsViewTheme = {
  bg: (_color, text) => text,
  bold: (text) => text,
  fg: (_color, text) => text,
};

function candidate(ref: string): FeedbackCandidate {
  return {
    author: 'alice',
    kind: 'thread',
    location: 'src/a.ts:1',
    ref,
    summary: `Fix ${ref}.`,
    url: `https://x/pull/7#${ref}`,
  };
}

const UP = '\u001b[A';
const DOWN = '\u001b[B';
const ENTER = '\r';

function picker(candidates: Array<FeedbackCandidate>, note: string | null = null) {
  const events: Array<string> = [];
  const view = new FactoryFeedbackPicker({
    closeView: () => events.push('closed'),
    start: (choice) => events.push(`start ${JSON.stringify(choice.only)}`),
    state: {
      candidates,
      displayRef: 'proj-1',
      note,
      pullRequestUrl: 'https://x/pull/7',
      skipped: 0,
      truncated: false,
    },
    theme,
    tui: { terminal: { rows: 20 } },
  });
  return { events, view };
}

test('enter starts a round on every comment, or on the ticked ones with --only', () => {
  const all = picker([candidate('r1'), candidate('c2'), candidate('p3')]);
  all.view.handleInput(ENTER);
  assert.deepEqual(all.events, ['start null']);

  const some = picker([candidate('r1'), candidate('c2'), candidate('p3')]);
  some.view.handleInput(' '); // untick r1
  some.view.handleInput(UP); // wraps to p3
  some.view.handleInput(' ');
  some.view.handleInput(ENTER);
  // A second enter cannot start a second round.
  some.view.handleInput(ENTER);
  assert.deepEqual(some.events, ['start ["c2"]']);
});

test('with nothing ticked enter explains instead, and q closes', () => {
  const none = picker([candidate('r1'), candidate('c2')]);
  none.view.handleInput('a');
  none.view.handleInput(ENTER);
  assert.deepEqual(none.events, []);
  assert.ok(none.view.render(60).some((line) => line.includes('Tick at least one comment')));
  none.view.handleInput('a');
  none.view.handleInput(DOWN);
  none.view.handleInput('q');
  assert.deepEqual(none.events, ['closed']);
  // A note alone starts a round when nothing is pending.
  assert.deepEqual(pickedFeedback({ candidates: [], note: 'n', ticked: [] }), { only: null });
  assert.equal(pickedFeedback({ candidates: [], note: null, ticked: [] }), null);
});

test('the list scrolls with the cursor and every line fits the width', () => {
  const candidates = Array.from({ length: 12 }, (_, index) => candidate(`r${index}`));
  const lines = renderFeedbackPicker({
    candidates,
    cursor: 11,
    displayRef: 'proj-1',
    height: 24,
    message: null,
    note: null,
    pullRequestUrl: 'https://x/pull/7',
    skipped: 2,
    theme,
    ticked: ['r0'],
    truncated: true,
    width: 50,
  });
  assert.equal(lines.length, 24);
  const text = lines.join('\n');
  assert.match(text, /5–12 of 12 · 1 ticked/);
  assert.match(text, /▶ \[ \] r11/);
  assert.doesNotMatch(text, / r3 /);
  assert.match(text, /2 skipped \(not collaborators\) · only the newes/);
});
