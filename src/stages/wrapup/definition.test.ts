import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addTasks, blank, review, run, session } from '../../stories/fixtures.ts';
import { wrapup } from './definition.ts';
import type { PrFormat } from './pr-format.ts';
import { parseTitleTemplate } from './title.ts';

test('wrap-up is given each task’s review verification, gaps included', () => {
  const snapshot = blank();
  addTasks(snapshot, 1);
  snapshot.execution.worktreePath = '/repo/.factory/worktrees/demo';
  run(snapshot, session(snapshot, 'review', '01'), {
    output: review(
      'approve',
      'none',
      undefined,
      ['- AC1: verified — src/a.ts:4', '- AC2: not_verified — needs a real browser'].join('\n'),
    ),
    round: 1,
  });
  const input = wrapup.input?.(
    { snapshot, task: null },
    {
      handoff: null,
      prepared: {
        adrPath: null,
        baseline: '{}',
        boxes: [],
        boxesUnread: null,
        contextPath: null,
        prFormat: { kind: 'default' },
        screenshots: [],
        testPlan: [],
        usage: '',
        verification: [],
      },
      round: 0,
    },
  );
  const text = wrapup.turn({ input: input ?? assert.fail('no input'), kind: 'initial' });
  // The skill picks the commit and title reference by where the ticket came from.
  assert.match(
    text,
    new RegExp(
      `Ticket: ${snapshot.ticket.displayRef}\nTicket source: ${snapshot.ticket.sourceKind}\n`,
    ),
  );
  assert.match(
    text,
    /Review verification:\n- Task 01 AC1: verified — src\/a\.ts:4\n- Task 01 AC2: not_verified — needs a real browser\n/,
  );
});

test('wrap-up is given the issue’s open boxes as B1..Bn and each task’s QA test plan', () => {
  const snapshot = blank();
  snapshot.execution.worktreePath = '/repo/.factory/worktrees/demo';
  const prepared = {
    adrPath: null,
    baseline: '{}',
    boxes: [
      { id: 'B1', key: 'k1', text: 'A reload keeps the filter.' },
      { id: 'B2', key: 'k2', text: 'The filter is labelled.' },
    ],
    boxesUnread: null as string | null,
    contextPath: null,
    prFormat: { kind: 'default' } as const,
    screenshots: [],
    testPlan: ['Task 01 AC1: e2e/filter.e2e.ts › survives a reload'],
    usage: '',
    verification: [],
  };
  const turn = () => {
    const input = wrapup.input?.({ snapshot, task: null }, { handoff: null, prepared, round: 0 });
    return wrapup.turn({ input: input ?? assert.fail('no input'), kind: 'initial' });
  };
  const text = turn();
  assert.match(
    text,
    /Issue checkboxes \(one ## Issue checklist line each\):\n- B1: A reload keeps the filter\.\n- B2: The filter is labelled\.\n/,
  );
  assert.match(text, /QA test plan:\n- Task 01 AC1: e2e\/filter\.e2e\.ts › survives a reload\n/);
  assert.match(text, /an open review finding names/);
  prepared.boxes = [];
  assert.match(turn(), /Issue checkboxes: none; write `none` under ## Issue checklist\./);
  prepared.boxesUnread = 'gh: rate limited';
  assert.match(turn(), /none, because the tracker could not be read \(gh: rate limited\)/);
});

function initialPrompt(
  edit: (snapshot: ReturnType<typeof blank>) => void,
  prFormat: PrFormat = { kind: 'default' },
): string {
  const snapshot = blank();
  snapshot.execution.worktreePath = '/repo/.factory/worktrees/demo';
  edit(snapshot);
  const input = wrapup.input?.(
    { snapshot, task: null },
    {
      handoff: null,
      prepared: {
        adrPath: null,
        baseline: '{}',
        boxes: [],
        boxesUnread: null,
        contextPath: null,
        prFormat,
        screenshots: [],
        testPlan: [],
        usage: '',
        verification: [],
      },
      round: 0,
    },
  );
  return wrapup.turn({ input: input ?? assert.fail('no input'), kind: 'initial' });
}

test('with pull requests on, wrap-up is given the rendered title', () => {
  const text = initialPrompt((snapshot) => {
    snapshot.execution.policy.pullRequests = true;
    snapshot.execution.policy.pullRequestTitle = parseTitleTemplate('{ref} | {summary}');
    snapshot.ticket.displayRef = 'ENG-42';
    snapshot.ticket.sourceKind = 'linear';
  });
  assert.match(text, /\nPull request title: ENG-42 \| <summary>\n/);
  assert.match(text, /Title it exactly ENG-42 \| <summary>/);

  const bare = initialPrompt((snapshot) => {
    snapshot.execution.policy.pullRequests = true;
  });
  // A GitHub ticket keeps today's title: the summary alone.
  assert.match(bare, /\nPull request title: <summary>\n/);

  const off = initialPrompt(() => {});
  assert.doesNotMatch(off, /Pull request title:/);
});

test('wrap-up learns which sections make the pull request body, and the tone only in the developer voice', () => {
  const short = initialPrompt((snapshot) => {
    snapshot.execution.policy.pullRequests = true;
    snapshot.execution.policy.communication = {
      tone: 'dry',
      verbosity: 'standard',
      voice: 'factory',
    };
  });
  assert.match(short, /it sets the body itself from ## PR summary and ## Tests,/);
  assert.doesNotMatch(short, /Tone:/);

  const full = initialPrompt((snapshot) => {
    snapshot.execution.policy.pullRequests = true;
    snapshot.execution.policy.communication = {
      tone: 'terse, lowercase',
      verbosity: 'full',
      voice: 'developer',
    };
  });
  assert.match(
    full,
    /from ## PR summary, ## Files, ## Tests, ## Decisions, ## Limitations, and ## Screenshots/,
  );
  assert.match(
    full,
    /in the first person, without mentioning the factory or agents\. Tone: terse, lowercase/,
  );

  // Without pull requests there is no body to set.
  const off = initialPrompt(() => {});
  assert.doesNotMatch(off, /sets the body itself/);
});

test('wrap-up writes the body in the project’s own format, which the controller leaves to it', () => {
  const template: PrFormat = {
    headings: ['What changed', 'Checklist'],
    kind: 'template',
    path: '.github/pull_request_template.md',
    text: '## What changed\n\n<!-- what and why -->\n\n## Checklist\n\n- [ ] Tests added\n',
  };
  const templated = initialPrompt((snapshot) => {
    snapshot.execution.policy.pullRequests = true;
    snapshot.execution.policy.communication = { tone: 't', verbosity: 'minimal', voice: 'factory' };
  }, template);
  assert.match(
    templated,
    /pull request format is the template \.github\/pull_request_template\.md, as of the base commit/,
  );
  assert.match(
    templated,
    /keep every heading, in order, fill each section briefly, remove its <!-- --> hints, and add no other section and no attribution/,
  );
  assert.match(templated, /Template:\n## What changed\n\n<!-- what and why -->/);
  assert.doesNotMatch(templated, /sets the body itself/);

  const instructed = initialPrompt(
    (snapshot) => {
      snapshot.execution.policy.pullRequests = true;
    },
    { kind: 'instructions', path: 'AGENTS.md', text: '## Pull requests\nLead with the risk.' },
  );
  assert.match(
    instructed,
    /agent instructions \(AGENTS\.md, as of the base commit\) say how to write a pull request\. Write the body that way, fully/,
  );
  assert.match(instructed, /\n## Pull requests\nLead with the risk\./);
  assert.doesNotMatch(instructed, /sets the body itself/);
});
