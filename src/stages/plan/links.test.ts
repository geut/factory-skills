import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { LinkedIssue, Tracker, TrackerCapability, TrackerIssue } from '../../ports/tracker.ts';
import { linkedIssuesSection, readPlanLinks } from './links.ts';

const issue: TrackerIssue = {
  author: null,
  body: '',
  createdAt: null,
  displayRef: 'PLT-2842',
  id: 'linear:uuid',
  labels: [],
  ref: 'PLT-2842',
  title: 'Guard the remaining org-admin views',
  updatedAt: null,
  url: 'https://linear.app/acme/issue/PLT-2842',
};

function link(displayRef: string, overrides: Partial<LinkedIssue> = {}): LinkedIssue {
  return {
    comments: null,
    displayRef,
    pullRequests: [],
    relation: 'mentioned',
    state: 'Done',
    stateType: 'completed',
    title: `Issue ${displayRef}`,
    url: null,
    ...overrides,
  };
}

const unused = () => Promise.reject(new Error('unused'));

// A tracker whose related links are `related`, which may throw.
function trackerWith(
  related: () => Promise<Array<LinkedIssue>>,
  capabilities: Array<TrackerCapability> = ['related'],
): Tracker {
  return {
    blockedBy: unused,
    capabilities: new Set(capabilities),
    checklistItems: unused,
    children: unused,
    comment: unused,
    kind: 'linear',
    listBacklog: unused,
    refHint: 'a Linear key',
    related,
    resolve: unused,
    setStatus: unused,
    tickBoxes: unused,
  };
}

const quiet = () => undefined;

test('links are listed up to the limit, with how many were left out', async () => {
  const many = Array.from({ length: 23 }, (_, index) => link(`PLT-${index + 1}`));
  const read = await readPlanLinks({
    issue,
    limit: 20,
    log: quiet,
    tracker: trackerWith(async () => many),
  });
  assert.equal(read.kind === 'read' ? read.issues.length : 0, 20);
  assert.equal(read.kind === 'read' ? read.omitted : 0, 3);
  assert.equal(linkedIssuesSection(read).at(-1), '- and 3 more not listed (limits.linkedIssues).');
});

test('no tracker, a tracker that cannot read links, or a limit of 0 reads nothing', async () => {
  const asked: Array<string> = [];
  const tracker = trackerWith(async () => {
    asked.push('related');
    return [link('PLT-1')];
  });
  assert.deepEqual(await readPlanLinks({ issue, limit: 20, log: quiet, tracker: null }), {
    kind: 'none',
  });
  assert.deepEqual(
    await readPlanLinks({
      issue,
      limit: 20,
      log: quiet,
      tracker: trackerWith(async () => [link('PLT-1')], []),
    }),
    { kind: 'none' },
  );
  assert.deepEqual(await readPlanLinks({ issue, limit: 0, log: quiet, tracker }), {
    kind: 'none',
  });
  assert.deepEqual(asked, []);
  assert.deepEqual(linkedIssuesSection({ kind: 'none' }), []);
  assert.deepEqual(linkedIssuesSection({ issues: [], kind: 'read', omitted: 0 }), []);
});

test('a tracker that fails is logged, and the plan is told the links could not be read', async () => {
  const lines: Array<string> = [];
  const read = await readPlanLinks({
    issue,
    limit: 20,
    log: (line) => lines.push(line),
    tracker: trackerWith(() => Promise.reject(new Error('Authentication required'))),
  });
  assert.deepEqual(read, { kind: 'failed' });
  assert.deepEqual(lines, [
    'Could not read the linked issues of PLT-2842; planning without them: Authentication required',
  ]);
  assert.match(
    linkedIssuesSection(read).join('\n'),
    /Linked issues: the tracker could not be read/,
  );
});

test('one line per link: relation, ref, state, title, pull requests, and comments', () => {
  assert.deepEqual(
    linkedIssuesSection({
      issues: [
        link('PLT-2478', {
          comments: { count: 16, more: false },
          pullRequests: ['https://github.com/acme/app/pull/11844'],
          title: 'Guard the org-admin views',
        }),
        link('BUG-1351', {
          comments: { count: 50, more: true },
          pullRequests: [
            'https://github.com/acme/app/pull/1',
            'https://github.com/acme/app/pull/2',
          ],
          relation: 'blocked by',
          state: 'In Review',
          title: 'Restrict the audit view',
        }),
        link('PLT-2483', {
          comments: { count: 1, more: false },
          state: null,
          title: 'Out of scope',
        }),
      ],
      kind: 'read',
      omitted: 0,
    }),
    [
      '',
      'Linked issues (one level; read one with the project’s tools when it matters):',
      '- mentioned PLT-2478 [Done] Guard the org-admin views · PR https://github.com/acme/app/pull/11844 · 16 comments',
      '- blocked by BUG-1351 [In Review] Restrict the audit view · PRs https://github.com/acme/app/pull/1 https://github.com/acme/app/pull/2 · 50+ comments',
      '- mentioned PLT-2483 Out of scope · 1 comment',
    ],
  );
});
