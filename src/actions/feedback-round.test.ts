import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { git, initRepo } from '../../tests/git-repo.ts';
import type { CodeHost, PullRequestInfo } from '../ports/code-host.ts';
import type { PullRequestFeedback } from '../ports/pull-request-feedback.ts';
import { blank } from '../stories/fixtures.ts';
import { prepareFeedbackRound, writeFeedbackTask } from './feedback-round.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

const url = 'https://github.com/geut/factory-skills/pull/7';

const thread: PullRequestFeedback['items'][number] = {
  comments: [{ author: 'alice', body: 'Rename it.', createdAt: 't', url: null }],
  kind: 'thread',
  line: 1,
  path: 'README.md',
  threadId: 'PRRT_1',
};

function unused(): never {
  throw new Error('unused');
}

function host(
  pullRequest: Partial<PullRequestInfo> | null,
  feedback: PullRequestFeedback,
): CodeHost {
  return {
    findPullRequest: unused,
    kind: 'github',
    pullRequest: () =>
      pullRequest === null
        ? null
        : {
            author: 'dpaez',
            closedAt: null,
            headBranch: 'factory/proj-1',
            headSha: null,
            mergedAt: null,
            number: 7,
            openedAt: '2026-10-15T10:00:00Z',
            state: 'open',
            title: 'Persist the filter',
            url,
            ...pullRequest,
          },
    pullRequestFeedback: () => feedback,
    pullRequestOutcome: unused,
    verifyWebhook: unused,
  };
}

// A ticket at handoff, with its worktree a repository on one commit.
function handedOff() {
  const worktree = mkdtempSync(path.join(tmpdir(), 'factory-feedback-'));
  roots.push(worktree);
  initRepo(worktree);
  const snapshot = blank({ displayRef: 'proj-1' });
  snapshot.execution.status = 'ready_for_handoff';
  snapshot.execution.policy.pullRequests = true;
  snapshot.execution.stage = 'wrapup';
  snapshot.execution.worktreePath = worktree;
  snapshot.execution.factoryDir = path.join(worktree, '.factory', 'tickets', 'proj-1');
  return { head: git(worktree, ['rev-parse', 'HEAD']), snapshot };
}

const some: PullRequestFeedback = { items: [thread], since: null, skipped: [], truncated: false };
const none: PullRequestFeedback = {
  items: [],
  since: null,
  skipped: [{ author: 'coderabbitai', kind: 'review', url: null }],
  truncated: false,
};

test('a round renders its task file from the worktree head, and the file is written once', () => {
  const { head, snapshot } = handedOff();
  const prepared = prepareFeedbackRound({
    codeHost: host({ headSha: head }, some),
    note: null,
    pullRequestUrl: url,
    snapshot,
  });
  if ('reason' in prepared) {
    assert.fail(prepared.message);
  }
  assert.deepEqual(
    { ...prepared, taskText: '' },
    {
      // What the controller keeps: each item's place and first line.
      feedback: {
        items: [
          {
            author: 'alice',
            id: 'F1',
            kind: 'thread',
            location: 'README.md:1',
            summary: 'Rename it.',
            url: null,
          },
        ],
        pullRequestUrl: url,
        round: 1,
        skipped: [],
      },
      round: 1,
      startHead: head,
      taskFile: 'feedback/1/task.md',
      taskText: '',
      title: 'Feedback round 1',
    },
  );
  // Nothing is written until the controller accepts the round.
  const file = path.join(snapshot.execution.factoryDir, 'feedback/1/task.md');
  assert.equal(existsSync(file), false);
  writeFeedbackTask(snapshot.execution.factoryDir, prepared);
  assert.match(
    readFileSync(file, 'utf8'),
    /^- \[ \] F1: review thread on `README.md:1` \(alice\): Rename it\.$/m,
  );
  // A repeated command cannot change a running round's file.
  writeFeedbackTask(snapshot.execution.factoryDir, { ...prepared, taskText: 'other' });
  assert.notEqual(readFileSync(file, 'utf8'), 'other');
});

test('a round is refused without an open pull request, new feedback, or a matching head', () => {
  const { snapshot } = handedOff();
  const refused = (
    codeHost: CodeHost,
    pullRequestUrl: string | null = url,
    note: string | null = null,
  ) => {
    const result = prepareFeedbackRound({
      codeHost,
      note,
      pullRequestUrl,
      snapshot,
    });
    return 'reason' in result ? `${result.reason}: ${result.message}` : 'started';
  };
  assert.match(refused(host({}, some), null), /invalid_state: proj-1 has no pull request/);
  assert.match(refused(host({ state: 'merged' }, some)), /pull\/7 is merged, not open/);
  assert.match(refused(host(null, some)), /pull\/7 is gone, not open/);
  assert.match(
    refused(host({}, none)),
    /No new feedback on .*pull\/7 since the last push \(1 skipped: not from collaborators or codeHost\.feedback\.authors\)/,
  );
  assert.match(
    refused(host({}, { ...none, truncated: true })),
    /only the newest 100 of each list were read/,
  );
  // A note alone is enough.
  assert.equal(refused(host({}, none), url, 'Rename the flag.'), 'started');
  assert.match(
    refused(host({ headSha: 'f'.repeat(40) }, some)),
    /pull\/7 is at fffffff, the worktree at/,
  );
  const failing = host({}, some);
  failing.pullRequestFeedback = () => {
    throw new Error('HTTP 502');
  };
  assert.match(refused(failing), /code_host_unavailable: Cannot read .*pull\/7: HTTP 502/);
  snapshot.execution.policy.pullRequests = false;
  assert.match(refused(host({}, some)), /codeHost\.pullRequests is off/);
  snapshot.execution.status = 'active';
  assert.match(refused(host({}, some)), /proj-1 is wrapup\/active, not ready for handoff/);
});
