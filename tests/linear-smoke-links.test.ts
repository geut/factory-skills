import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { before, test } from 'node:test';
import { LinearClient } from '@linear/sdk';
import type { LinearTrackerConfig } from '../src/config.ts';
import { createLinearTracker, linearMentions, linearSdkApi } from '../src/ports/linear.ts';
import type { LinkedIssue, Tracker, TrackerIssue } from '../src/ports/tracker.ts';
import { linkedIssuesSection, readPlanLinks } from '../src/stages/plan/links.ts';

// The plan stage's linked issues against real Linear, by hand. It only
// reads: it creates, edits, and deletes nothing.
//
//   LINEAR_API_KEY=lin_api_... LINEAR_SMOKE_LINKS_ISSUE=ENG-42 \
//     node --test tests/linear-smoke-links.test.ts
//
// Both can instead sit in a .env file at the repo root, which git ignores.
// Pick an issue with a parent, sub-issues, relations, or other issue keys in
// its description. Without both variables, as in CI, it is skipped.

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const apiKey = process.env['LINEAR_API_KEY'] ?? '';
const key = (process.env['LINEAR_SMOKE_LINKS_ISSUE'] ?? '').toUpperCase();
const skip =
  apiKey.length === 0 || key.length === 0
    ? 'needs LINEAR_API_KEY and LINEAR_SMOKE_LINKS_ISSUE'
    : false;

// The SDK refuses an empty key, so it is only made when the test runs.
const sdk = skip === false ? new LinearClient({ apiKey }) : (undefined as unknown as LinearClient);
const api = linearSdkApi(apiKey);
let tracker: Tracker;
let issue: TrackerIssue;
let links: Array<LinkedIssue> = [];

before(async () => {
  if (skip !== false) {
    return;
  }
  // The issue's own team; the adapter reads links across teams either way.
  const config: LinearTrackerConfig = {
    apiKeyEnv: 'LINEAR_API_KEY',
    backlog: { labels: [], project: null, states: ['backlog', 'unstarted'] },
    kind: 'linear',
    status: {},
    team: key.split('-')[0] ?? '',
    updates: { checklist: true, comments: true },
  };
  tracker = createLinearTracker(config, api);
  const resolved = await tracker.resolve(key);
  assert.equal(resolved?.kind, 'issue', JSON.stringify(resolved));
  issue = resolved?.kind === 'issue' ? resolved.issue : (undefined as never);
  // The real queries: a response Linear shapes differently fails here, with
  // the query and the field.
  links = await tracker.related(issue);
});

test(
  'the linked issues read back well formed, each once, never the issue itself',
  { skip },
  (t) => {
    t.diagnostic(`${key}: ${links.length} linked issue(s)`);
    const refs = links.map((link) => link.displayRef);
    assert.equal(new Set(refs).size, refs.length, `a link is listed twice: ${refs.join(', ')}`);
    assert.ok(!refs.includes(key), `${key} links to itself`);
    for (const link of links) {
      assert.match(link.displayRef, /^[A-Z][A-Z0-9_]*-\d+$/, link.displayRef);
      assert.ok(
        [
          'blocked by',
          'blocks',
          'duplicate',
          'mentioned',
          'parent',
          'related',
          'sub-issue',
        ].includes(link.relation),
        `${link.displayRef}: ${link.relation}`,
      );
      assert.ok(link.title.length > 0, `${link.displayRef} has no title`);
      assert.match(link.url ?? '', /^https:\/\/linear\.app\//, `${link.displayRef}: ${link.url}`);
      assert.ok(link.state !== null && link.stateType !== null, `${link.displayRef} has no state`);
      assert.ok((link.comments?.count ?? -1) >= 0, `${link.displayRef} has no comment count`);
      for (const url of link.pullRequests) {
        assert.match(
          url,
          /^https?:\/\/[^/]+\/[^/]+\/[^/]+\/pull\/\d+/,
          `${link.displayRef}: ${url}`,
        );
      }
    }
  },
);

test('the native links match what the Linear SDK reports for the issue', { skip }, async () => {
  const raw = await sdk.issue(key);
  const parent = await raw.parent;
  const children = (await raw.children({ first: 20 })).nodes;
  const relations = (await raw.relations({ first: 20 })).nodes;
  const inverse = (await raw.inverseRelations({ first: 20 })).nodes;
  const expected = new Set<string>();
  if (parent !== undefined) {
    expected.add(`parent ${parent.identifier}`);
  }
  for (const child of children) {
    expected.add(`sub-issue ${child.identifier}`);
  }
  // From the issue's side: its own `blocks` relation blocks the other issue.
  for (const relation of relations) {
    const other = await relation.relatedIssue;
    if (other !== undefined) {
      const kind =
        relation.type === 'blocks'
          ? 'blocks'
          : relation.type === 'duplicate'
            ? 'duplicate'
            : 'related';
      expected.add(`${kind} ${other.identifier}`);
    }
  }
  for (const relation of inverse) {
    const other = await relation.issue;
    if (other !== undefined) {
      const kind =
        relation.type === 'blocks'
          ? 'blocked by'
          : relation.type === 'duplicate'
            ? 'duplicate'
            : 'related';
      expected.add(`${kind} ${other.identifier}`);
    }
  }
  // An issue linked twice, as a parent that is also related, keeps its
  // first relation; compare by issue for those.
  const native = links.filter((link) => link.relation !== 'mentioned');
  assert.deepEqual(
    new Set(native.map((link) => link.displayRef)),
    new Set([...expected].map((entry) => entry.split(' ').at(-1))),
  );
  for (const link of native) {
    assert.ok(
      expected.has(`${link.relation} ${link.displayRef}`),
      `${link.relation} ${link.displayRef} is not among ${[...expected].join(', ')}`,
    );
  }
});

test('every mentioned issue is named in the description', { skip }, () => {
  const named = linearMentions(issue.body);
  for (const link of links.filter((item) => item.relation === 'mentioned')) {
    assert.ok(named.includes(link.displayRef), `${link.displayRef} is not in the description`);
  }
});

test('the plan prompt’s section, as the planner would get it', { skip }, async (t) => {
  const read = await readPlanLinks({
    issue,
    limit: 20,
    log: (line) => t.diagnostic(line),
    tracker,
  });
  assert.equal(read.kind, 'read');
  const section = linkedIssuesSection(read);
  for (const line of section.length === 0 ? ['(no linked issues: no section)'] : section) {
    t.diagnostic(line);
  }
});
