import assert from 'node:assert/strict';
import { test } from 'node:test';
import { effects } from './effects.ts';
import { stages } from './index.ts';

test('every stage builds its prompts from its own skill and contract', () => {
  for (const stage of Object.values(stages)) {
    for (const prompt of [
      stage.turn({ failures: ['plan.md is missing.'], kind: 'correction' }),
      stage.turn({ answer: 'Use the catalog', kind: 'reply' }),
    ]) {
      assert.match(prompt, new RegExp(`Follow the ${stage.skill} skill`));
      // The plan is its files: its template is a suggestion.
      assert.match(
        prompt,
        stage.name === 'plan'
          ? /factory\.plan\.v3 template in the skill is a suggested summary, not a requirement/
          : new RegExp(`Return only the ${stage.contract} template`),
      );
    }
  }
});

test('only work takes a return to work', () => {
  assert.match(
    stages.work.turn({
      kind: 'return',
      origin: 'Review',
      problems: ['1. Missing guard'],
      round: 2,
    }),
    /Review round 2 requested changes[\s\S]*- 1\. Missing guard/,
  );
  for (const stage of [stages.plan, stages.review, stages.wrapup]) {
    assert.throws(
      () => stage.turn({ kind: 'return', origin: 'Review', problems: [], round: 1 }),
      /cannot take a return to work/,
    );
  }
});

test('a stage prepares input exactly when its effects can', () => {
  for (const [name, stage] of Object.entries(stages)) {
    assert.equal(stage.preparesInput, 'prepareInput' in effects[stage.name], name);
  }
});

test('a stage has FACTORY.json settings exactly when it is optional', () => {
  for (const stage of Object.values(stages)) {
    assert.equal(stage.optional, stage.settings !== undefined, stage.name);
  }
});
