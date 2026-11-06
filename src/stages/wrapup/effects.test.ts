import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readIssueBoxes } from './effects.ts';

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
