import assert from 'node:assert/strict';
import { test } from 'node:test';
import { stages } from './index.ts';

const handoff = [
  'Outcome',
  'PR summary',
  'Files',
  'Tests',
  'Operations',
  'Limitations',
  'Merge commands',
]
  .map((heading) => `## ${heading}\n\nnone`)
  .join('\n\n');

test('work output is left for its validator', () => {
  assert.deepEqual(stages.work.parse('Done.', 0, stages.work.contract), {
    json: JSON.stringify({ output: 'Done.' }),
    kind: 'unchecked',
  });
});

test('a plan is its files, whatever the agent said', () => {
  assert.equal(stages.plan.parse('anything', 0, stages.plan.contract).kind, 'valid');
});

test('a handoff missing a heading is invalid and names it', () => {
  assert.equal(stages.wrapup.parse(handoff, 0, stages.wrapup.contract).kind, 'valid');
  const missing = stages.wrapup.parse(
    handoff.replace('## Tests', '## Testing'),
    0,
    stages.wrapup.contract,
  );
  assert.equal(missing.kind, 'invalid');
  assert.match(missing.kind === 'invalid' ? missing.error : '', /^## Tests is missing\.$/);
});

test('an unreadable review is invalid with the parser failures', () => {
  const parsed = stages.review.parse('Looks good to me.', 1, stages.review.contract);
  assert.equal(parsed.kind, 'invalid');
});
