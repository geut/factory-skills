import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blank, run, session } from '../../stories/fixtures.ts';
import { passCompareBase, readIssueBoxes } from './effects.ts';

test('wrap-up numbers the open checklist items B1..Bn and keeps the tracker’s keys', async () => {
  assert.deepEqual(
    await readIssueBoxes(async () => [
      { done: true, key: 'done', text: 'The README says so.' },
      { done: false, key: 'sub-12', text: 'A reload keeps the filter.' },
      { done: false, key: 'sub-13', text: 'The filter is labelled.' },
    ]),
    {
      boxes: [
        { id: 'B1', key: 'sub-12', text: 'A reload keeps the filter.' },
        { id: 'B2', key: 'sub-13', text: 'The filter is labelled.' },
      ],
      unread: null,
    },
  );
});

test('no tracker checklist is no boxes, and an unreadable tracker says why', async () => {
  assert.deepEqual(await readIssueBoxes(async () => null), { boxes: [], unread: null });
  assert.deepEqual(
    await readIssueBoxes(async () => {
      throw new Error('gh: rate limited');
    }),
    { boxes: [], unread: 'gh: rate limited' },
  );
});

// A wrap-up baseline as a pass stores it, with `compareBase`.
const baseline = (compareBase: string | null) =>
  JSON.stringify({ branch: 'b', compareBase, factory: {}, head: 'h', remotes: {}, worktree: {} });

test("the handoff diff runs from the latest pass's compare base, not one worked out again", () => {
  const snapshot = blank();
  assert.equal(passCompareBase(snapshot), null);
  const wrapup = session(snapshot, 'wrapup');
  run(snapshot, wrapup).baseline = baseline('a'.repeat(40));
  // A correction keeps its pass's baseline; a later pass stores its own.
  run(snapshot, wrapup);
  assert.equal(passCompareBase(snapshot), 'a'.repeat(40));
  run(snapshot, wrapup).baseline = baseline('b'.repeat(40));
  assert.equal(passCompareBase(snapshot), 'b'.repeat(40));
  // A pass stored before passes kept one falls back to where the ticket branched.
  run(snapshot, wrapup).baseline = baseline(null);
  assert.equal(passCompareBase(snapshot), null);
});
