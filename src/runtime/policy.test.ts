import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { stages, stageTools } from '../stages/index.ts';
import { childInstructions } from '../stages/prompt.ts';
import {
  childDescription,
  clipTaskTitle,
  paneLabel,
  runStatusLabel,
  taskProgressText,
} from './policy.ts';

const replyPrompt = (stage: 'plan' | 'work', answer: string) =>
  stages[stage].turn({ answer, kind: 'reply' });
const workCorrectionPrompt = (failures: Array<string>) =>
  stages.work.turn({ failures, kind: 'correction' });

test('stage launch policy auto-exits and specialist skills finish with subagent_done', () => {
  for (const policy of Object.values(stages)) {
    assert.equal(policy.autoExit, true);
    assert.equal(policy.spawning, false);
    const instructions = childInstructions(policy.skill, policy.contract);
    assert.match(instructions, /subagent_done/);
    assert.match(instructions, /caller_ping/);
    assert.match(instructions, /shutting down/);
    const skill = readFileSync(
      new URL(`../../skills/${policy.skill}/SKILL.md`, import.meta.url),
      'utf8',
    );
    assert.match(skill, /subagent_done/);
    assert.match(skill, /shutting down/);
    assert.doesNotMatch(skill, /factory-supervise|fstate|FACTORY-STATE/);
  }
  assert.match(stageTools('plan'), /subagent_done/);
  assert.match(stageTools('work'), /caller_ping/);
  assert.doesNotMatch(stageTools('review'), /bash|edit|write/);
  assert.match(workCorrectionPrompt(['diff is empty']), /factory-work/);
  assert.match(workCorrectionPrompt(['diff is empty']), /diff is empty/);
  assert.match(replyPrompt('work', 'Use the catalog'), /factory-work/);
  assert.match(replyPrompt('work', 'Use the catalog'), /Use the catalog/);
  assert.match(replyPrompt('plan', 'Use the catalog'), /factory-plan/);
});

test('pane labels use a stage emoji and descriptions stay short', () => {
  assert.equal(paneLabel('plan', 'user/project-name#3', null), '🔎 user/project-name#3');
  assert.equal(paneLabel('work', 'user/project-name#3', '01'), '🛠 user/project-name#3 01');
  assert.equal(paneLabel('review', 'user/project-name#3', null), '👀 user/project-name#3');
  assert.equal(paneLabel('wrapup', 'user/project-name#3', null), '📦 user/project-name#3');
  assert.equal(
    childDescription('Turn derivation layer (pure server-side module)'),
    'Turn derivation layer',
  );
  assert.equal(childDescription('local diff bug review'), 'Local diff bug review');
});

test('status and task labels stay inside the herdr token limit', () => {
  assert.equal(runStatusLabel('initial'), 'initial');
  assert.equal(runStatusLabel('validation_correction'), 'correction');
  assert.equal(runStatusLabel('human_reply'), 'reply');
  assert.equal(runStatusLabel('infrastructure_retry'), 'retry');
  assert.equal(runStatusLabel('return_to_work'), 'return');
  assert.equal(runStatusLabel('reentry'), 'rerun');
  assert.equal(runStatusLabel('manual_continue'), 'continue');
  assert.equal(taskProgressText('Fix lint', 3), 'Fix lint · 3 left');
  const title = 'Implement /tickets route and the list filters';
  assert.equal(clipTaskTitle(title), 'Implement /tickets route and the list f…');
  assert.equal(clipTaskTitle(title).length, 40);
  assert.ok(taskProgressText(title, 3).length <= 80);
});
