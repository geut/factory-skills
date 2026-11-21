import { spawn } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { factoryRootOf } from '../controller/keys.ts';
import { loadSnapshotByExecution } from '../controller/store.ts';
import { executionId, type FactorySnapshot } from '../domain.ts';
import { isOsMetadata } from '../os-metadata.ts';
import type { ProcessInfo } from './strays.ts';

// Cleaning up after a completed ticket: its worktree, with the dependencies
// and build output a run leaves in it, and its local branch. Only what is
// safe to lose goes: a worktree with changes no commit holds, or one a
// process still runs in, stays, and so does a branch whose commits are not
// on a remote or in the merged pull request. Remote branches are never
// touched. Running it again finds what is already gone and moves on.

export type CleanupItem =
  | { kind: 'removed' }
  // Nothing to do: never made, or already cleaned up.
  | { kind: 'gone' }
  | { kind: 'kept'; reason: string }
  // Safe to remove, left in place by a dry run.
  | { kind: 'would_remove' }
  | { kind: 'failed'; reason: string };

export type CleanupOutcome = {
  branch: CleanupItem;
  branchName: string | null;
  displayRef: string;
  worktree: CleanupItem;
  worktreePath: string | null;
};

type Git = { code: number; stderr: string; stdout: string };

// Git as a child the server awaits: removing a worktree full of dependencies
// takes a while, and the server keeps answering meanwhile.
function git(cwd: string, args: Array<string>): Promise<Git> {
  return new Promise((resolve) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout: Array<Buffer> = [];
    const stderr: Array<Buffer> = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      resolve({ code: 1, stderr: error.message, stdout: '' });
    });
    child.on('close', (code) => {
      resolve({
        code: code ?? 1,
        stderr: Buffer.concat(stderr).toString('utf8'),
        stdout: Buffer.concat(stdout).toString('utf8'),
      });
    });
  });
}

function real(file: string): string {
  try {
    return realpathSync(file);
  } catch {
    return path.resolve(file);
  }
}

function inside(dir: string, target: string): boolean {
  const relative = path.relative(dir, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// The worktree paths git has registered for the code root.
async function registeredWorktrees(codeRoot: string): Promise<Set<string>> {
  const listed = await git(codeRoot, ['worktree', 'list', '--porcelain']);
  return new Set(
    listed.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => real(line.slice('worktree '.length))),
  );
}

// What in the worktree no commit holds: modified, staged, or untracked
// files. Ignored files, such as dependencies and build output, are what the
// cleanup is for; OS metadata is the host's.
async function pendingChanges(worktree: string): Promise<Array<string> | { error: string }> {
  const status = await git(worktree, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status.code !== 0) {
    return { error: status.stderr.trim() || 'git status failed' };
  }
  return status.stdout
    .split('\n')
    .filter((line) => line.length > 3)
    .map((line) => line.slice(3))
    .filter((file) => !isOsMetadata(path.basename(file)));
}

// The processes running in the worktree, by working directory or by the
// worktree a factory launch script marked them with.
function processesIn(worktree: string, processes: ReadonlyArray<ProcessInfo>): Array<ProcessInfo> {
  const dir = real(worktree);
  return processes.filter((item) =>
    [item.cwd, item.factoryWorktree].some(
      (place) => place !== null && path.isAbsolute(place) && inside(dir, real(place)),
    ),
  );
}

function listed(items: Array<string>, limit = 5): string {
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown}, and ${items.length - limit} more` : shown;
}

async function worktreeStep(input: {
  codeRoot: string;
  dryRun: boolean;
  processes: () => ReadonlyArray<ProcessInfo>;
  worktree: string | null;
  worktreesDir: string;
}): Promise<CleanupItem> {
  const { worktree } = input;
  if (worktree === null || !existsSync(worktree)) {
    return { kind: 'gone' };
  }
  // Only a worktree the factory made, as git knows it.
  if (!inside(real(input.worktreesDir), real(worktree))) {
    return { kind: 'kept', reason: `it is outside ${input.worktreesDir}` };
  }
  if (!(await registeredWorktrees(input.codeRoot)).has(real(worktree))) {
    return { kind: 'kept', reason: 'git does not list it as a worktree of the repository' };
  }
  const pending = await pendingChanges(worktree);
  if (!Array.isArray(pending)) {
    return { kind: 'failed', reason: pending.error };
  }
  if (pending.length > 0) {
    return {
      kind: 'kept',
      reason: `it has changes no commit holds: ${listed(pending)}`,
    };
  }
  const running = processesIn(worktree, input.processes());
  if (running.length > 0) {
    return {
      kind: 'kept',
      reason: `a process still runs in it: ${listed(running.map((item) => `${item.command} (pid ${item.pid})`))}`,
    };
  }
  if (input.dryRun) {
    return { kind: 'would_remove' };
  }
  // The checks above are the safety; --force only lets git remove ignored
  // files and the host's metadata with the rest.
  const removed = await git(input.codeRoot, ['worktree', 'remove', '--force', worktree]);
  return removed.code === 0
    ? { kind: 'removed' }
    : { kind: 'failed', reason: removed.stderr.trim() || 'git worktree remove failed' };
}

async function branchStep(input: {
  baseSha: string | null;
  branch: string | null;
  codeRoot: string;
  dryRun: boolean;
  // The commits of the ticket's pull request, as the code host reported them.
  pullRequestCommits: ReadonlySet<string>;
  worktree: CleanupItem;
}): Promise<CleanupItem> {
  const { branch } = input;
  if (branch === null) {
    return { kind: 'gone' };
  }
  const tip = await git(input.codeRoot, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`,
  ]);
  if (tip.code !== 0) {
    return { kind: 'gone' };
  }
  if (input.worktree.kind === 'kept' || input.worktree.kind === 'failed') {
    return { kind: 'kept', reason: 'its worktree is kept' };
  }
  const sha = tip.stdout.trim();
  const unchanged = input.baseSha !== null && sha === input.baseSha;
  const onRemote =
    (
      await git(input.codeRoot, [
        'for-each-ref',
        '--contains',
        sha,
        '--format=%(refname)',
        'refs/remotes',
      ])
    ).stdout.trim().length > 0;
  if (!unchanged && !onRemote && !input.pullRequestCommits.has(sha)) {
    const ahead =
      input.baseSha === null
        ? null
        : (
            await git(input.codeRoot, ['rev-list', '--count', `${input.baseSha}..${sha}`])
          ).stdout.trim();
    return {
      kind: 'kept',
      reason: `${ahead === null ? 'its commits are' : `${ahead} commit${ahead === '1' ? ' is' : 's are'}`} on no remote branch and not in a merged pull request`,
    };
  }
  if (input.dryRun) {
    return { kind: 'would_remove' };
  }
  const deleted = await git(input.codeRoot, ['branch', '-D', branch]);
  return deleted.code === 0
    ? { kind: 'removed' }
    : { kind: 'failed', reason: deleted.stderr.trim() || 'git branch -D failed' };
}

// The commits of a ticket's pull request, as the code host last reported
// them: a merged pull request's branch may be gone from the remote.
export function pullRequestCommits(db: DatabaseSync, executionId: string): Set<string> {
  return new Set(
    db
      .prepare('SELECT sha FROM pull_request_commits WHERE execution_id = ?')
      .all(executionId)
      .map((row) => String(row['sha'])),
  );
}

// Cleans up after one completed ticket, as far as it is safe.
export async function cleanUpTicket(input: {
  dryRun: boolean;
  processes: () => ReadonlyArray<ProcessInfo>;
  pullRequestCommits: ReadonlySet<string>;
  snapshot: FactorySnapshot;
}): Promise<CleanupOutcome> {
  const { execution, ticket } = input.snapshot;
  const codeRoot = execution.policy.codeRoot;
  const worktree = await worktreeStep({
    codeRoot,
    dryRun: input.dryRun,
    processes: input.processes,
    worktree: execution.worktreePath,
    worktreesDir: path.join(factoryRootOf(execution.factoryDir), 'worktrees'),
  });
  // Pruning git's record of a worktree removed by hand frees its branch.
  if (worktree.kind === 'gone' && !input.dryRun) {
    await git(codeRoot, ['worktree', 'prune']);
  }
  const branch = await branchStep({
    baseSha: execution.worktreeBaseSha,
    branch: execution.worktreeBranch,
    codeRoot,
    dryRun: input.dryRun,
    pullRequestCommits: input.pullRequestCommits,
    worktree,
  });
  return {
    branch,
    branchName: execution.worktreeBranch,
    displayRef: ticket.displayRef,
    worktree,
    worktreePath: execution.worktreePath,
  };
}

// The current generation of every completed ticket. Cancelled tickets keep
// their worktree, as cancelling promises, and failed ones can be retried.
export function completedTickets(db: DatabaseSync): Array<FactorySnapshot> {
  return db
    .prepare(
      "SELECT id FROM ticket_executions WHERE is_current = 1 AND status = 'complete' ORDER BY updated_at",
    )
    .all()
    .flatMap((row) => {
      const snapshot = loadSnapshotByExecution(db, executionId(String(row['id'])));
      return snapshot === null ? [] : [snapshot];
    });
}

function itemLine(name: string, item: CleanupItem): string | null {
  switch (item.kind) {
    case 'removed':
      return `removed ${name}`;
    case 'would_remove':
      return `would remove ${name}`;
    case 'gone':
      return null;
    case 'kept':
      return `kept ${name}: ${item.reason}`;
    case 'failed':
      return `could not remove ${name}: ${item.reason}`;
    default: {
      const _exhaustive: never = item;
      return _exhaustive;
    }
  }
}

// One line per ticket: what went, what stayed and why. Null when there was
// nothing left to clean.
export function outcomeLine(outcome: CleanupOutcome): string | null {
  const parts = [
    itemLine(`worktree ${outcome.worktreePath ?? ''}`.trim(), outcome.worktree),
    itemLine(`branch ${outcome.branchName ?? ''}`.trim(), outcome.branch),
  ].filter((part) => part !== null);
  return parts.length === 0 ? null : `${outcome.displayRef}: ${parts.join('; ')}.`;
}

// Whether the operator has something to resolve.
export function needsAttention(outcome: CleanupOutcome): boolean {
  return [outcome.worktree, outcome.branch].some(
    (item) => item.kind === 'kept' || item.kind === 'failed',
  );
}
