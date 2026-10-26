import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueCheckboxes, tickCheckboxes } from './checklist.ts';

const body = [
  '## Acceptance criteria',
  '',
  '- [ ] The filter survives a reload.',
  '- [x] The filter has a label.',
  '* [ ] Clearing the filter shows every row.',
  '',
  '```md',
  '- [ ] Not a box: an example inside a fence.',
  '~~~',
  '- [ ] Still inside: only ``` closes this fence.',
  '```',
  '1. [ ] Numbered boxes count.',
  '',
  '## Done when',
  '  - [ ]   The docs mention it.  ',
].join('\r\n');

test('the open boxes of an issue body are B1..Bn in order, outside code fences', () => {
  assert.deepEqual(issueCheckboxes(body), [
    { id: 'B1', text: 'The filter survives a reload.' },
    { id: 'B2', text: 'Clearing the filter shows every row.' },
    { id: 'B3', text: 'Numbered boxes count.' },
    { id: 'B4', text: 'The docs mention it.' },
  ]);
  assert.deepEqual(issueCheckboxes('No boxes here.'), []);
});

test('ticking flips only the matched boxes and leaves every other byte alone', () => {
  const ticked = tickCheckboxes(body, ['The filter survives a reload.', 'The docs mention it.']);
  assert.deepEqual(ticked.conflicts, []);
  assert.equal(
    ticked.body,
    body
      .replace('- [ ] The filter survives', '- [x] The filter survives')
      .replace('  - [ ]   The docs', '  - [x]   The docs'),
  );
});

test('a box ticked already is left as it is; a box whose text changed is a conflict', () => {
  const ticked = tickCheckboxes(body, ['The filter has a label.', 'The filter survives reloads.']);
  assert.equal(ticked.body, body);
  assert.deepEqual(ticked.conflicts, ['The filter survives reloads.']);
});
