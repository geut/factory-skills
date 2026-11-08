import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { after, before, test } from 'node:test';
import { LinearClient } from '@linear/sdk';
import type { LinearTrackerConfig } from '../src/config.ts';
import {
  checkLinearSettings,
  commentIdFor,
  commentIdsFor,
  createLinearTracker,
  linearSdkApi,
} from '../src/ports/linear.ts';
import type { Tracker, TrackerIssue } from '../src/ports/tracker.ts';

// Against real Linear, by hand: it proves what Linear's docs leave open.
//
//   LINEAR_API_KEY=lin_api_... LINEAR_SMOKE_TEAM=SCRATCH node --test tests/linear-smoke.test.ts
//
// Both can instead sit in a .env file at the repo root, which git ignores.
// LINEAR_SMOKE_TEAM is the team's key, such as ENG, not its name.
//
// It creates one throwaway issue in the scratch team and deletes it after.
// Without both variables, as in CI, it is skipped.

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const apiKey = process.env['LINEAR_API_KEY'] ?? '';
const team = process.env['LINEAR_SMOKE_TEAM'] ?? '';
const skip =
  apiKey.length === 0 || team.length === 0 ? 'needs LINEAR_API_KEY and LINEAR_SMOKE_TEAM' : false;

// The SDK refuses an empty key, so it is only made when the test runs.
const sdk = skip === false ? new LinearClient({ apiKey }) : (undefined as unknown as LinearClient);
const api = linearSdkApi(apiKey);
let issueId = '';
let issue: TrackerIssue;
let tracker: Tracker;
let config: LinearTrackerConfig;

before(async () => {
  if (skip !== false) {
    return;
  }
  const inventory = await api.inventory();
  const scratch = inventory.teams.find((item) => item.key === team);
  assert.ok(
    scratch,
    `no team with key ${team}; the keys are ${inventory.teams.map((item) => item.key).join(', ')}`,
  );
  const started = scratch.states.filter((state) => state.type === 'started');
  assert.ok(started.length > 0, `team ${team} has no started state`);
  config = {
    apiKeyEnv: 'LINEAR_API_KEY',
    backlog: { labels: [], project: null, states: ['backlog', 'unstarted', 'triage'] },
    kind: 'linear',
    status: { in_progress: { state: started[0]?.name ?? '' } },
    team,
    updates: { checklist: true, comments: true },
  };
  assert.deepEqual(checkLinearSettings(config, inventory), []);
  const teams = await sdk.teams({ filter: { key: { eq: team } } });
  const created = await sdk.createIssue({
    description: 'Factory smoke test; safe to delete.\n\n- [ ] First box\n- [ ] Second box\n',
    teamId: teams.nodes[0]?.id ?? '',
    title: 'factory smoke test',
  });
  issueId = (await created.issue)?.id ?? '';
  assert.ok(issueId.length > 0);
  tracker = createLinearTracker(config, api);
  const resolved = await tracker.resolve((await api.issue(issueId)).identifier);
  assert.equal(resolved?.kind, 'issue');
  issue = resolved?.kind === 'issue' ? resolved.issue : (undefined as never);
});

after(async () => {
  if (issueId.length > 0) {
    await sdk.deleteIssue(issueId);
  }
});

test(
  'Markdown boxes in a description survive a write and read back as boxes',
  { skip },
  async () => {
    const items = await tracker.checklistItems(issue);
    assert.deepEqual(
      items.map((item) => [item.text, item.done]),
      [
        ['First box', false],
        ['Second box', false],
      ],
    );
    assert.deepEqual(await tracker.tickBoxes(issue, [items[0]?.key ?? '']), { conflicts: [] });
    const after = await tracker.checklistItems(issue);
    assert.deepEqual(
      after.map((item) => [item.text, item.done]),
      [
        ['First box', true],
        ['Second box', false],
      ],
    );
  },
);

test(
  'a comment id derived from the key is accepted, and a repeat never posts twice',
  { skip },
  async () => {
    await tracker.comment(issue, 'Smoke: first.', 'smoke', 'once');
    await tracker.comment(issue, 'Smoke: first.', 'smoke', 'once');
    const id = commentIdFor(issueId, 'smoke');
    // A create with the same id, as after a crash, fails instead of duplicating.
    await assert.rejects(() => api.createComment({ body: 'Smoke: twice.', id, issueId }));
    await tracker.comment(issue, 'Smoke: replaced.', 'smoke', 'replace');
    const comments = await (await sdk.issue(issueId)).comments();
    assert.deepEqual(
      comments.nodes.map((comment) => [comment.id, comment.body]),
      [[id, 'Smoke: replaced.']],
    );
    // A person deletes it: Linear refuses the id again, so the next post
    // takes the key's next id.
    await sdk.deleteComment(id);
    await tracker.comment(issue, 'Smoke: after a deletion.', 'smoke', 'replace');
    const next = commentIdsFor(issueId, 'smoke')[1];
    const left = await (await sdk.issue(issueId)).comments();
    assert.deepEqual(
      left.nodes.map((comment) => [comment.id, comment.body]),
      [[next, 'Smoke: after a deletion.']],
    );
  },
);

test('a status moves the issue to the mapped workflow state by name', { skip }, async () => {
  assert.equal(await tracker.setStatus(issue, 'in_progress'), null);
  assert.equal((await api.issue(issueId)).state?.name, config.status.in_progress?.state);
});

test('the factory’s ticket branch links to the issue', { skip }, async () => {
  const key = (await api.issue(issueId)).identifier;
  const found = await sdk.issueVcsBranchSearch(`factory/${key.toLowerCase()}-1a2b3c4d`);
  assert.equal(found?.id, issueId);
});
