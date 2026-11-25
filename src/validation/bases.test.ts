import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { feedbackTaskId } from '../stages/feedback.ts';
import { addTasks, blank } from '../stories/fixtures.ts';
import {
  fetchTarget,
  headCheck,
  ROUND_BASE_REF,
  roundBase,
  roundStart,
  syncWorktreeRefs,
  TARGET_REF,
  unreadableHistory,
} from './bases.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_AUTHOR_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'Factory',
};

function git(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: gitEnv });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout);
  }
  return result.stdout.trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, ['add', file]);
  git(cwd, ['-c', 'commit.gpgsign=false', 'commit', '-qm', file]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// An upstream repository, and a code root cloned from it with two ticket
// worktrees, as a factory has them.
function factory(): { root: string; upstream: string; wt1: string; wt2: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-bases-'));
  dirs.push(dir);
  const upstream = path.join(dir, 'upstream');
  mkdirSync(upstream);
  git(upstream, ['init', '-qb', 'main']);
  commit(upstream, 'README.md', '# demo\n');
  const root = path.join(dir, 'root');
  git(dir, ['clone', '-q', upstream, root]);
  const wt1 = path.join(dir, 'wt1');
  const wt2 = path.join(dir, 'wt2');
  git(root, ['worktree', 'add', '-qb', 'factory/one', wt1, 'origin/main']);
  git(root, ['worktree', 'add', '-qb', 'factory/two', wt2, 'origin/main']);
  return { root, upstream, wt1, wt2 };
}

// The files the ticket changed, as a project check finds them through the
// worktree's refs.
function ticketFiles(worktree: string): Array<string> {
  const base = git(worktree, ['merge-base', 'HEAD', TARGET_REF]);
  return git(worktree, ['diff', '--name-only', base]).split('\n').filter(Boolean);
}

test('the round base is where the ticket branched until a feedback round starts', () => {
  const snapshot = blank();
  snapshot.execution.worktreeBaseSha = null;
  assert.equal(roundBase(snapshot), null);
  snapshot.execution.worktreeBaseSha = 'a'.repeat(40);
  // A round's start recorded earlier does not count before a round runs.
  snapshot.execution.roundBaseSha = 'b'.repeat(40);
  assert.equal(roundStart(snapshot), null);
  assert.equal(roundBase(snapshot), 'a'.repeat(40));
  addTasks(snapshot, 1);
  const round = snapshot.tasks[0];
  assert.ok(round !== undefined);
  round.taskId = feedbackTaskId(1);
  assert.equal(roundStart(snapshot), 'b'.repeat(40));
  assert.equal(roundBase(snapshot), 'b'.repeat(40));
});

test('each worktree holds its own refs, and the target follows the remote as it moves', () => {
  const { root, upstream, wt1, wt2 } = factory();
  const base = git(wt1, ['rev-parse', 'HEAD']);
  assert.equal(syncWorktreeRefs({ roundBase: base, targetBranch: 'main', worktree: wt1 }), null);
  // Repeating it changes nothing.
  assert.equal(syncWorktreeRefs({ roundBase: base, targetBranch: 'main', worktree: wt1 }), null);
  assert.equal(git(wt1, ['symbolic-ref', TARGET_REF]), 'refs/remotes/origin/main');
  assert.equal(git(wt1, ['rev-parse', ROUND_BASE_REF]), base);
  // Another ticket's worktree never sees them.
  assert.equal(
    spawnSync('git', ['rev-parse', '--verify', '--quiet', ROUND_BASE_REF], { cwd: wt2 }).status,
    1,
  );
  // Another ticket's start fetches the target into the shared ref.
  const moved = commit(upstream, 'routes.py', 'urlpatterns = []\n');
  git(root, ['fetch', '-q', 'origin']);
  assert.equal(git(wt1, ['rev-parse', TARGET_REF]), moved);
  // The ticket's own change is all a check finds; the route change is not.
  commit(wt1, 'feature.txt', 'one\n');
  writeFileSync(path.join(wt1, 'README.md'), '# demo\nchanged\n');
  assert.deepEqual(ticketFiles(wt1), ['README.md', 'feature.txt']);
});

test('a ticket rebased onto a newer target, or with the target merged in, still compares to its own changes', () => {
  const { root, upstream, wt1, wt2 } = factory();
  commit(wt1, 'feature.txt', 'one\n');
  commit(wt2, 'other.txt', 'two\n');
  commit(upstream, 'routes.py', 'urlpatterns = []\n');
  git(root, ['fetch', '-q', 'origin']);
  for (const worktree of [wt1, wt2]) {
    syncWorktreeRefs({
      roundBase: git(worktree, ['rev-parse', 'HEAD']),
      targetBranch: 'main',
      worktree,
    });
  }
  // The pull request conflicted, and a person rebased it onto the new main.
  git(wt1, ['rebase', '-q', 'origin/main']);
  assert.deepEqual(ticketFiles(wt1), ['feature.txt']);
  // The other merged main in instead.
  git(wt2, ['-c', 'commit.gpgsign=false', 'merge', '-q', '--no-edit', 'origin/main']);
  assert.deepEqual(ticketFiles(wt2), ['other.txt']);
});

test('HEAD that left the round base fails the HEAD check, a commit on top included', () => {
  const { wt1 } = factory();
  const base = git(wt1, ['rev-parse', 'HEAD']);
  const passed = headCheck(wt1, base);
  assert.equal('status' in passed ? passed.status : null, 'passed');
  // A commit on top still descends from the base, and still moved HEAD.
  commit(wt1, 'feature.txt', 'one\n');
  const committed = headCheck(wt1, base);
  assert.equal('status' in committed ? committed.status : null, 'failed');
  assert.match(
    'details' in committed ? committed.details : '',
    /^HEAD is at [0-9a-f]{40}, not the round's start [0-9a-f]{40}: leave the work uncommitted/,
  );
});

test('a history with no target in common, or a round base git does not have, cannot answer', () => {
  const { wt1 } = factory();
  const base = git(wt1, ['rev-parse', 'HEAD']);
  syncWorktreeRefs({ roundBase: base, targetBranch: 'main', worktree: wt1 });
  assert.equal(unreadableHistory(wt1, base), null);
  assert.match(
    unreadableHistory(wt1, 'f'.repeat(40)) ?? '',
    /^The round base f{12} is not a commit in this repository\. No project check ran\.$/,
  );
  // A HEAD with no history in common with the target.
  const elsewhere = git(wt1, ['commit-tree', 'HEAD^{tree}', '-m', 'elsewhere']);
  git(wt1, ['checkout', '-q', elsewhere]);
  assert.match(
    unreadableHistory(wt1, elsewhere) ?? '',
    /shares no history with the target .* no project check ran/,
  );
});

test('the target ref keeps the remote it was written with when another is added', async () => {
  const { root, upstream, wt1, wt2 } = factory();
  const base = git(wt1, ['rev-parse', 'HEAD']);
  syncWorktreeRefs({ roundBase: base, targetBranch: 'main', worktree: wt1 });
  // A second remote, and origin renamed: no rule would pick a remote now.
  git(root, ['remote', 'rename', 'origin', 'fork']);
  git(root, ['remote', 'add', 'upstream', upstream]);
  git(root, ['update-ref', 'refs/remotes/origin/main', base]);
  git(wt1, ['symbolic-ref', TARGET_REF, 'refs/remotes/fork/main']);
  assert.equal(syncWorktreeRefs({ roundBase: base, targetBranch: 'main', worktree: wt1 }), null);
  assert.equal(git(wt1, ['symbolic-ref', TARGET_REF]), 'refs/remotes/fork/main');
  // The round fetches from the remote the ref names.
  const moved = commit(upstream, 'routes.py', 'urlpatterns = []\n');
  assert.equal(await fetchTarget({ targetBranch: 'main', worktree: wt1 }), null);
  assert.equal(git(wt1, ['rev-parse', TARGET_REF]), moved);
  // A worktree with no target ref yet, among remotes none of which is
  // origin: no target is written, and the fetch says why it cannot choose.
  assert.equal(syncWorktreeRefs({ roundBase: base, targetBranch: 'main', worktree: wt2 }), null);
  assert.equal(spawnSync('git', ['symbolic-ref', '--quiet', TARGET_REF], { cwd: wt2 }).status, 1);
  assert.equal(
    await fetchTarget({ targetBranch: 'main', worktree: wt2 }),
    'Cannot choose a remote to fetch main from among fork, upstream; name one origin.',
  );
});

test('a round fetches its target; a failed fetch says why, and with no remote there is nothing to fetch', async () => {
  const { root, upstream, wt1, wt2 } = factory();
  syncWorktreeRefs({
    roundBase: git(wt1, ['rev-parse', 'HEAD']),
    targetBranch: 'main',
    worktree: wt1,
  });
  const moved = commit(upstream, 'routes.py', 'urlpatterns = []\n');
  assert.equal(await fetchTarget({ targetBranch: 'main', worktree: wt1 }), null);
  assert.equal(git(wt1, ['rev-parse', TARGET_REF]), moved);
  assert.match(
    (await fetchTarget({ targetBranch: 'no-such-branch', worktree: wt1 })) ?? '',
    /^Cannot fetch origin\/no-such-branch: /,
  );
  git(root, ['remote', 'remove', 'origin']);
  assert.equal(await fetchTarget({ targetBranch: 'main', worktree: wt2 }), null);
});

test('a fetch that hangs, its helper included, ends at the timeout', async () => {
  const { root, wt1 } = factory();
  // A remote whose upload-pack never answers, and leaves a child holding the
  // pipe, as an ssh stuck connecting does.
  git(root, ['config', 'remote.origin.uploadpack', 'sh -c "sleep 30 & sleep 30"']);
  const started = Date.now();
  assert.equal(
    await fetchTarget({ targetBranch: 'main', timeoutMs: 300, worktree: wt1 }),
    'Cannot fetch origin/main: timed out after 1s',
  );
  assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
});

test('a target branch with slashes keeps the remote it was recorded with', async () => {
  const { root, upstream, wt1 } = factory();
  git(upstream, ['branch', 'release/stable']);
  // The ticket targets fork's release/stable; an origin added later points
  // elsewhere, and is not where the round fetches from.
  git(root, ['remote', 'rename', 'origin', 'fork']);
  git(root, ['fetch', '-q', 'fork']);
  const elsewhere = path.join(path.dirname(root), 'elsewhere');
  git(path.dirname(root), ['init', '-qb', 'main', elsewhere]);
  const base = git(wt1, ['rev-parse', 'HEAD']);
  git(wt1, ['symbolic-ref', TARGET_REF, 'refs/remotes/fork/release/stable']);
  git(root, ['remote', 'add', 'origin', elsewhere]);
  assert.equal(
    syncWorktreeRefs({ roundBase: base, targetBranch: 'release/stable', worktree: wt1 }),
    null,
  );
  assert.equal(git(wt1, ['symbolic-ref', TARGET_REF]), 'refs/remotes/fork/release/stable');
  git(upstream, ['checkout', '-q', 'release/stable']);
  const moved = commit(upstream, 'release.txt', 'stable\n');
  assert.equal(await fetchTarget({ targetBranch: 'release/stable', worktree: wt1 }), null);
  assert.equal(git(wt1, ['rev-parse', TARGET_REF]), moved);
});
