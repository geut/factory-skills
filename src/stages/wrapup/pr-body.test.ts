import assert from 'node:assert/strict';
import { test } from 'node:test';
import { pullRequestBody } from './pr-body.ts';

const handoff = [
  '## Outcome',
  '',
  'The filter survives a reload.',
  '',
  '## PR summary',
  '',
  'Keeps the catalog filter in the URL. Not a saved-views feature.',
  '',
  '## Screenshots',
  '',
  '- Task 01 AC1: qa/01/screenshots/reload.png',
  '',
  '## Files',
  '',
  '- `src/filter.ts` — reads and writes the filter in the URL',
  '',
  '## Tests',
  '',
  '- npm test: passed',
  '',
  '## Issue checklist',
  '',
  'none',
  '',
  '## Decisions',
  '',
  '- URL over localStorage, so links share the filter (src/filter.ts:1-20).',
  '',
  '## Operations',
  '',
  'none',
  '',
  '## Limitations',
  '',
  'none',
  '',
  '## Merge commands',
  '',
  'https://github.com/geut/app/pull/9',
].join('\n');

test('minimal and standard bodies are the summary and the tests', () => {
  for (const verbosity of ['minimal', 'standard'] as const) {
    assert.equal(
      pullRequestBody({
        communication: { verbosity, voice: 'developer' },
        displayRef: '#42',
        handoff,
      }),
      '## Summary\n\nKeeps the catalog filter in the URL. Not a saved-views feature.\n\n## Tests\n\n- npm test: passed\n',
    );
  }
});

test('a full body adds the files, decisions, and screenshots, and skips sections that say none', () => {
  const body = pullRequestBody({
    communication: { verbosity: 'full', voice: 'developer' },
    displayRef: '#42',
    handoff,
  });
  assert.deepEqual(
    [...body.matchAll(/^## (.+)$/gm)].map((match) => match[1]),
    ['Summary', 'Files', 'Tests', 'Decisions', 'Screenshots'],
  );
  assert.match(body, /## Screenshots\n\n- Task 01 AC1: qa\/01\/screenshots\/reload\.png\n$/);
});

test('the factory voice signs the body; the developer voice does not', () => {
  const signed = pullRequestBody({
    communication: { verbosity: 'minimal', voice: 'factory' },
    displayRef: 'ENG-42',
    handoff,
  });
  assert.match(signed, /\n\n---\n\nOpened by the factory for ENG-42\.\n$/);
  const plain = pullRequestBody({
    communication: { verbosity: 'full', voice: 'developer' },
    displayRef: 'ENG-42',
    handoff,
  });
  assert.doesNotMatch(plain, /factory/i);
});
