import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  childDescription,
  childInstructions,
  childToolList,
  paneLabel,
  stageLaunchPolicy,
} from './policy.ts';

test('stage launch policy auto-exits and specialist skills finish with subagent_done', () => {
  for (const policy of Object.values(stageLaunchPolicy)) {
    assert.equal(policy.autoExit, true);
    assert.equal(policy.spawning, false);
    const instructions = childInstructions(policy.skill, policy.contract);
    assert.match(instructions, /subagent_done/);
    assert.match(instructions, /caller_ping/);
    const skill = readFileSync(
      new URL(`../../skills/${policy.skill}/SKILL.md`, import.meta.url),
      'utf8',
    );
    assert.match(skill, /subagent_done/);
    assert.doesNotMatch(skill, /factory-supervise|fstate|FACTORY-STATE/);
  }
  assert.match(childToolList('plan'), /subagent_done/);
  assert.match(childToolList('work'), /caller_ping/);
});

test('pane labels use a stage emoji and descriptions stay short', () => {
  assert.equal(
    paneLabel('plan', 'dpaez/factory-dashboard#3', null),
    '🔎 dpaez/factory-dashboard#3',
  );
  assert.equal(
    paneLabel('work', 'dpaez/factory-dashboard#3', '01'),
    '🛠 dpaez/factory-dashboard#3 01',
  );
  assert.equal(
    paneLabel('review', 'dpaez/factory-dashboard#3', null),
    '👀 dpaez/factory-dashboard#3',
  );
  assert.equal(
    paneLabel('wrapup', 'dpaez/factory-dashboard#3', null),
    '📦 dpaez/factory-dashboard#3',
  );
  assert.equal(
    childDescription('Turn derivation layer (pure server-side module)'),
    'Turn derivation layer',
  );
  assert.equal(childDescription('local diff bug review'), 'Local diff bug review');
});
