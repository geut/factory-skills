import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { feedbackTaskId } from '../stages/feedback.ts';
import { addTasks, blank } from '../stories/fixtures.ts';
import {
  checkBases,
  fetchTarget,
  ROUND_BASE_REF,
  roundBase,
  roundStart,
  syncWorktreeRefs,
  TARGET_REF,
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

test('HEAD that left the round base has moved; a history with no target in common, or an unknown commit, cannot answer', () => {
  const { wt1 } = factory();
  const base = git(wt1, ['rev-parse', 'HEAD']);
  syncWorktreeRefs({ roundBase: base, targetBranch: 'main', worktree: wt1 });
  assert.deepEqual(checkBases(wt1, base), { kind: 'ok' });
  // Committing on top still descends: the commit check is work's to judge.
  commit(wt1, 'feature.txt', 'one\n');
  assert.deepEqual(checkBases(wt1, base), { kind: 'ok' });

  const elsewhere = git(wt1, ['commit-tree', 'HEAD^{tree}', '-m', 'elsewhere']);
  const moved = checkBases(wt1, elsewhere);
  assert.equal(moved.kind, 'moved');
  assert.match(
    moved.kind === 'moved' ? moved.message : '',
    /HEAD no longer descends from the round's start [0-9a-f]{12} \(refs\/worktree\/factory\/round-base\)/,
  );

  const unknown = checkBases(wt1, 'f'.repeat(40));
  assert.equal(unknown.kind, 'unreadable');

  // A HEAD with no history in common with the target.
  git(wt1, ['checkout', '-q', elsewhere]);
  const unrelated = checkBases(wt1, elsewhere);
  assert.equal(unrelated.kind, 'unreadable');
  assert.match(
    unrelated.kind === 'unreadable' ? unrelated.message : '',
    /shares no history with the target .* no project check ran/,
  );
});

test('a round fetches its target; with no remote there is nothing to fetch, and a failed fetch says why', async () => {
  const { root, upstream, wt1 } = factory();
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
  assert.equal(await fetchTarget({ targetBranch: 'main', worktree: wt1 }), null);
});
