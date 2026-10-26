import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewFinding } from '../../domain.ts';
import { diffNotes } from './notes.ts';

const finding: ReviewFinding = {
  blocking: false,
  evidence: 'The label is never rendered.',
  finding: 'The filter has no visible label.',
  id: 'R1-2',
  location: 'src/filter.ts:30-34',
  number: 2,
  severity: 'minor',
  suggestion: 'Render the label above the input.',
  title: 'Unlabelled filter',
};

const diff = ['src/filter.ts', 'src/catalog.ts', 'README.md']
  .map(
    (file) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-a\n+b\n`,
  )
  .join('');

const handoff = (files: string, decisions: string) => `## Outcome

The catalog keeps its filter.

## Files

${files}

## Decisions

${decisions}
`;

test('the handoff diff carries what each file does, the decisions where they show, and the open findings', () => {
  assert.deepEqual(
    diffNotes(
      diff,
      handoff(
        [
          'Added:',
          '- `src/filter.ts` — keeps the filter in the URL',
          '- src/catalog.ts: reads the filter on load',
          '- `README.md`',
        ].join('\n'),
        '- Stored the filter in the URL instead of localStorage, so a link keeps it (src/filter.ts:12-20)',
      ),
      [{ finding, taskId: '01' }],
    ),
    {
      files: [
        {
          annotations: [
            { author: 'wrap-up', summary: 'keeps the filter in the URL' },
            {
              author: 'wrap-up',
              newRange: [12, 20],
              summary:
                'Decision: Stored the filter in the URL instead of localStorage, so a link keeps it',
            },
            {
              author: 'review',
              newRange: [30, 34],
              rationale:
                'The filter has no visible label.\n\nSuggestion: Render the label above the input.',
              summary: 'Task 01 R1-2 [minor] Unlabelled filter',
            },
          ],
          path: 'src/filter.ts',
        },
        {
          annotations: [{ author: 'wrap-up', summary: 'reads the filter on load' }],
          path: 'src/catalog.ts',
        },
      ],
      version: 1,
    },
  );
});

test('a handoff with nothing to say about its diff has no notes', () => {
  assert.equal(diffNotes(diff, handoff('- `src/filter.ts`', 'none'), []), null);
  // A finding without a location has nowhere to show.
  assert.equal(
    diffNotes(diff, handoff('none', 'none'), [
      { finding: { ...finding, location: null }, taskId: '01' },
    ]),
    null,
  );
  // Nor does a note on a file the diff leaves alone.
  assert.equal(diffNotes(diff, handoff('- `src/other.ts` — unrelated', 'none'), []), null);
});
