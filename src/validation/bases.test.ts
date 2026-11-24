import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { feedbackTaskId } from '../stages/feedback.ts';
import { addTasks, blank } from '../stories/fixtures.ts';
import { basesDiverged, comparisonBases } from './bases.ts';

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

function repo(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'factory-bases-'));
  dirs.push(cwd);
  git(cwd, ['init', '-qb', 'main']);
  return cwd;
}

test('the ticket base is where the worktree started, and the round base moves with feedback rounds', () => {
  const snapshot = blank();
  snapshot.execution.worktreeBaseSha = null;
  assert.equal(comparisonBases(snapshot), null);
  snapshot.execution.worktreeBaseSha = 'a'.repeat(40);
  snapshot.execution.worktreeBaseBranch = 'main';
  // A round's start recorded earlier does not count before a round runs.
  snapshot.execution.roundBaseSha = 'b'.repeat(40);
  assert.deepEqual(comparisonBases(snapshot), {
    roundBase: 'a'.repeat(40),
    targetBranch: 'main',
    ticketBase: 'a'.repeat(40),
  });
  addTasks(snapshot, 1);
  const round = snapshot.tasks[0];
  assert.ok(round !== undefined);
  round.taskId = feedbackTaskId(1);
  assert.deepEqual(comparisonBases(snapshot), {
    roundBase: 'b'.repeat(40),
    targetBranch: 'main',
    ticketBase: 'a'.repeat(40),
  });
});

test('a worktree that descends from its bases is fine, a rebased one is not, and an unreadable history is never clean', () => {
  const cwd = repo();
  const base = commit(cwd, 'README.md', '# demo\n');
  const round = commit(cwd, 'feature.txt', 'round 1\n');
  const bases = { roundBase: round, targetBranch: 'main', ticketBase: base };
  assert.equal(basesDiverged(cwd, bases), null);

  // Rebased onto a newer target: HEAD no longer descends from the ticket base.
  git(cwd, ['checkout', '-q', '--orphan', 'rebased']);
  git(cwd, ['rm', '-rq', '--cached', '.']);
  commit(cwd, 'upstream.txt', 'upstream\n');
  commit(cwd, 'feature.txt', 'round 1\n');
  assert.match(
    basesDiverged(cwd, bases) ?? '',
    /HEAD no longer descends from the ticket base [0-9a-f]{12} \(FACTORY_TICKET_BASE\): the branch was rebased or reset\. No project check ran/,
  );

  // A commit the repository does not have.
  assert.match(
    basesDiverged(cwd, { ...bases, ticketBase: 'f'.repeat(40) }) ?? '',
    /^Cannot check that the worktree descends from the ticket base f{12}: .+\. No project check ran\.$/,
  );
});
