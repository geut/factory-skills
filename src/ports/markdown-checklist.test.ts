import assert from 'node:assert/strict';
import { test } from 'node:test';
import { markdownChecklist, tickMarkdown } from './markdown-checklist.ts';

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
  '- [ ] The filter survives a reload.',
].join('\r\n');

test('every box of a body is an item keyed by its text and which of that text it is', () => {
  assert.deepEqual(markdownChecklist(body), [
    { done: false, key: '1:The filter survives a reload.', text: 'The filter survives a reload.' },
    { done: true, key: '1:The filter has a label.', text: 'The filter has a label.' },
    {
      done: false,
      key: '1:Clearing the filter shows every row.',
      text: 'Clearing the filter shows every row.',
    },
    { done: false, key: '1:Numbered boxes count.', text: 'Numbered boxes count.' },
    { done: false, key: '1:The docs mention it.', text: 'The docs mention it.' },
    // The same text again, under another heading.
    { done: false, key: '2:The filter survives a reload.', text: 'The filter survives a reload.' },
  ]);
  assert.deepEqual(markdownChecklist('No boxes here.'), []);
});

test('ticking flips only the boxes of the given keys and leaves every other byte alone', () => {
  const ticked = tickMarkdown(body, ['2:The filter survives a reload.', '1:The docs mention it.']);
  assert.deepEqual(ticked.conflicts, []);
  const lines = body.split('\r\n');
  lines[lines.length - 1] = '- [x] The filter survives a reload.';
  assert.equal(ticked.body, lines.join('\r\n').replace('  - [ ]   The docs', '  - [x]   The docs'));
});

test('a box ticked already is left as it is; a box whose text changed is a conflict', () => {
  const ticked = tickMarkdown(body, [
    '1:The filter has a label.',
    '1:The filter survives reloads.',
  ]);
  assert.equal(ticked.body, body);
  assert.deepEqual(ticked.conflicts, ['1:The filter survives reloads.']);
});
