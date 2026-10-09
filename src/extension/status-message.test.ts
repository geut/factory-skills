import assert from 'node:assert/strict';
import { test } from 'node:test';
import { factoryStatusPayload, renderFactoryStatus, type StatusTheme } from './status-message.ts';

const theme: StatusTheme = {
  bold: (text) => text,
  fg: (_color, text) => text,
};

const notice = [
  'dpaez/factory-dashboard#7',
  'stage: work',
  'status: ready for review',
  'task: 02/03 Store the filter',
  'progress: 1/3 done',
  'tone: done',
  'Run ended with subagent_done.',
  'Artifacts are written and validated: every ticket AC maps to task criteria.',
  '## Status',
  'planned',
  '## Artifacts',
  '- plan: .factory/tickets/example/plan.md',
].join('\n');

test('a status card shows the task and folds the body behind a one-line summary', () => {
  const collapsed = renderFactoryStatus({ expanded: false, text: notice, theme, width: 80 });
  assert.equal(collapsed[0], '✓ dpaez/factory-dashboard#7 · work · ready for review');
  assert.equal(collapsed[1], '  02/03 Store the filter · 1/3 done');
  assert.match(collapsed[2] ?? '', /Artifacts are written and validated/);
  assert.doesNotMatch(collapsed.join('\n'), /## Status|Run ended with/);
  assert.match(collapsed.at(-1) ?? '', /\+\d+ lines · expand to read/);
  const expanded = renderFactoryStatus({ expanded: true, text: notice, theme, width: 80 });
  assert.match(expanded.join('\n'), /## Status/);
  assert.match(expanded.join('\n'), /plan\.md/);
  assert.doesNotMatch(expanded.join('\n'), /expand to read/);
  const payload = factoryStatusPayload(notice);
  assert.match(payload.content, /^dpaez\/factory-dashboard#7 · work · ready for review\n02\/03/);
  assert.match(payload.content, /Artifacts are written and validated/);
  assert.doesNotMatch(payload.content, /## Status/);
  assert.equal(payload.details.text, notice);
});

test('an attention card shows its whole body and the command to run', () => {
  const text = [
    'proj-1',
    'stage: review',
    'status: paused',
    'tone: attention',
    'next: /factory retry proj-1',
    'The worktree changed again.',
    'Ignore generated files.',
  ].join('\n');
  const lines = renderFactoryStatus({ expanded: false, text, theme, width: 60 });
  assert.equal(lines[0], '▲ proj-1 · review · paused');
  assert.ok(lines.includes('  Ignore generated files.'));
  assert.equal(lines.at(-1), '  → /factory retry proj-1');
  assert.equal(factoryStatusPayload(text).content.endsWith('Next: /factory retry proj-1'), true);
});
