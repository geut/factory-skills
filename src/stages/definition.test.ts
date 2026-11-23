import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTasks, blank, task } from '../stories/fixtures.ts';
import { effects } from './effects.ts';
import { stages } from './index.ts';
import type { PlanInput } from './plan/definition.ts';
import { END_TO_END } from './prompt.ts';

test('every stage builds its prompts from its own skill and contract', () => {
  for (const stage of Object.values(stages)) {
    for (const prompt of [
      stage.turn({ failures: ['plan.md is missing.'], kind: 'correction' }),
      stage.turn({ answer: 'Use the catalog', kind: 'reply' }),
    ]) {
      assert.match(prompt, new RegExp(`Follow the ${stage.skill} skill`));
      // The plan is its files: its template is a suggestion. Work's report is
      // subagent_done's arguments, its answers' and corrections' too.
      assert.match(
        prompt,
        stage.name === 'plan'
          ? /factory\.plan\.v3 template in the skill is a suggested summary, not a requirement/
          : stage.name === 'work'
            ? /call subagent_done with your report as its arguments: the controller reads only them/
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

// The plan's first prompt for ticket #7, given what CONTEXT.md lacks and
// its linked issues.
function initial(
  context: PlanInput['context'],
  links: PlanInput['links'] = { kind: 'none' },
): string {
  return stages.plan.turn({
    input: {
      body: 'Remember the filter.',
      context,
      displayRef: '#7',
      factoryDir: '/repo/.factory/tickets/7',
      links,
      title: 'Filter',
    },
    kind: 'initial',
  });
}

test('the first plan in a factory root is asked to create CONTEXT.md', () => {
  const missing = initial({ kind: 'missing' });
  assert.match(missing, /Create \/repo\/\.factory\/CONTEXT\.md/);
  for (const section of [
    'Commands',
    'Environment',
    'Test layers',
    'Servers and ports',
    'Known flakes',
    'Fixtures and fakes',
    'Vocabulary',
  ]) {
    assert.ok(missing.includes(section), section);
  }
  assert.doesNotMatch(initial({ kind: 'read', missingSections: [] }), /CONTEXT\.md/);
  // A hand-written file is completed, not rewritten.
  const partial = initial({ kind: 'read', missingSections: ['Known flakes'] });
  assert.doesNotMatch(partial, /Create .*CONTEXT\.md/);
  assert.match(partial, /Add the ## Known flakes section to \/repo\/\.factory\/CONTEXT\.md/);
});

test('the plan prompt lists the linked issues after the ticket body, and nothing without them', () => {
  const read: PlanInput['context'] = { kind: 'read', missingSections: [] };
  const withLinks = initial(read, {
    issues: [
      {
        comments: null,
        displayRef: '#3',
        pullRequests: [],
        relation: 'parent',
        state: 'open',
        stateType: 'open',
        title: 'Filters everywhere',
        url: null,
      },
    ],
    kind: 'read',
    omitted: 0,
  });
  assert.ok(
    withLinks.endsWith(
      'Remember the filter.\n\nLinked issues (one level; read one with the project’s tools when it matters):\n- parent #3 [open] Filters everywhere',
    ),
  );
  assert.ok(initial(read).endsWith('Remember the filter.'));
  assert.equal(initial(read, { issues: [], kind: 'read', omitted: 0 }), initial(read));
});

// Work's first prompt for task 01, with QA on or off for the project and the task.
function workPrompt(qa: 'on' | 'off' | 'skipped'): string {
  const snapshot = blank();
  addTasks(snapshot, 1);
  snapshot.execution.worktreePath = '/repo/.factory/worktrees/demo';
  if (qa !== 'off') {
    snapshot.execution.policy.stages['qa'] = { commands: [], enabled: true };
  }
  if (qa === 'skipped') {
    task(snapshot, '01').summaries.qa = { counts: {}, label: 'skipped', round: 0 };
  }
  const input = stages.work.input?.(
    { snapshot, task: task(snapshot, '01') },
    {
      handoff: null,
      prepared: { adrPath: null, contextPath: null, taskType: 'feature' },
      round: 0,
    },
  );
  return stages.work.turn({ input: input ?? assert.fail('no input'), kind: 'initial' });
}

test('work leaves end-to-end tests, API requests included, to QA exactly when QA runs for the task', () => {
  const on = workPrompt('on');
  assert.match(
    on,
    /QA runs for this task and owns its end-to-end tests: write unit tests \(and component tests where the project has them\), keep the existing end-to-end suite passing, and leave every end-to-end test of this task's acceptance criteria, API requests included, to QA\./,
  );
  // Work and QA mean the same thing by end-to-end, a project without a UI included.
  assert.ok(on.includes(END_TO_END));
  assert.match(
    END_TO_END,
    /a browser, an HTTP API .*test client.*, a job run synchronously, or a CLI run/,
  );
  for (const qa of ['off', 'skipped'] as const) {
    const off = workPrompt(qa);
    assert.match(
      off,
      /QA does not run for this task: add or update end-to-end coverage for its acceptance criteria/,
    );
    assert.ok(off.includes(END_TO_END));
  }
});

test('QA proves each criterion at the cheapest layer that runs the real code', () => {
  const text = stages.qa.turn({
    input: {
      changedFiles: [],
      checks: [],
      commands: [],
      criteria: [{ id: 'AC1', text: 'The filter survives a reload.' }],
      dir: '/qa',
      displayRef: '#7',
      planPath: '/plan.md',
      round: 1,
      taskFile: '/01-task.md',
      taskId: '01',
      title: 'Filter',
      validationCommands: [],
      workerSummary: '',
      worktree: '/wt',
    },
    kind: 'initial',
  });
  assert.ok(text.includes(END_TO_END));
  assert.match(
    text,
    /Prove each criterion a user can observe at the cheapest layer that runs the real code: a browser end-to-end test for a user path through the running app; a component test or story for a component's look or state; a test-client request, a synchronous job run, or a CLI run for an API, a job, or a command\./,
  );
  assert.match(text, /a criterion with nothing on screen has none/);
  assert.match(text, /Extend the existing spec for the feature/);
  assert.doesNotMatch(text, /one observable end-to-end test for each criterion/);
});
