import { spawn, spawnSync } from 'node:child_process';
import type { FactorySnapshot } from '../domain.ts';
import { feedbackRounds } from '../stages/feedback.ts';

// What a project's checks compare a ticket against. A remote branch's tip,
// such as `origin/main`, moves under a running ticket: every ticket the
// factory starts fetches it into the code root, and every worktree shares the
// ref. A check that diffs against the tip counts what landed upstream since
// the ticket branched as the ticket's own change.
//
// So each ticket's worktree holds two refs of its own. Git keeps
// `refs/worktree/*` per worktree: parallel tickets never see each other's,
// and every shell in the worktree reads them, the agent's, a validation
// command's, or a person's.
//
// - `refs/worktree/factory/target` names the branch the pull request
//   targets, as a symbolic ref to its remote-tracking branch. Its merge-base
//   with HEAD is where the ticket's own changes begin: it follows a rebase
//   onto a newer target, or the target merged in, and stays put as the
//   target moves on.
// - `refs/worktree/factory/round-base` is the commit the current round of
//   work started from: the feedback round's start, or where the ticket
//   branched before any round.
export const TARGET_REF = 'refs/worktree/factory/target';
export const ROUND_BASE_REF = 'refs/worktree/factory/round-base';

// The commit the current feedback round started from, or null before any
// round. Rounds start only after the planned tasks are done, so once one
// has, every later run belongs to it.
export function roundStart(snapshot: Pick<FactorySnapshot, 'execution' | 'tasks'>): string | null {
  return feedbackRounds(snapshot.tasks) > 0 ? snapshot.execution.roundBaseSha : null;
}

// The commit the current round of work started from: the round's start, or
// where the ticket branched. Null before the worktree is ready.
export function roundBase(snapshot: Pick<FactorySnapshot, 'execution' | 'tasks'>): string | null {
  return roundStart(snapshot) ?? snapshot.execution.worktreeBaseSha;
}

type Git = { code: number; stderr: string; stdout: string };

function git(cwd: string, args: Array<string>): Git {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return {
    code: result.status ?? 1,
    stderr: (result.stderr ?? '').trim() || result.error?.message || '',
    stdout: (result.stdout ?? '').trim(),
  };
}

// The remote a ticket's target comes from, as worktree preparation chose
// it: `origin`, or the only remote. Null without one.
export function targetRemote(names: ReadonlyArray<string>): string | null {
  return names.includes('origin') ? 'origin' : names.length === 1 ? (names[0] ?? null) : null;
}

// Points the worktree's refs at the ticket's current state; repeating it
// changes nothing. Null on success, or why it failed.
export function syncWorktreeRefs(input: {
  roundBase: string;
  targetBranch: string | null;
  worktree: string;
}): string | null {
  const round = git(input.worktree, ['update-ref', ROUND_BASE_REF, input.roundBase]);
  if (round.code !== 0) {
    return `Cannot record the round base in ${input.worktree}: ${round.stderr}`;
  }
  if (input.targetBranch === null) {
    return null;
  }
  const remotes = git(input.worktree, ['remote']);
  const remote = targetRemote(remotes.stdout.split('\n').filter((name) => name.length > 0));
  const target =
    remote === null
      ? `refs/heads/${input.targetBranch}`
      : `refs/remotes/${remote}/${input.targetBranch}`;
  const current = git(input.worktree, ['symbolic-ref', '--quiet', TARGET_REF]);
  if (current.code === 0 && current.stdout === target) {
    return null;
  }
  const pointed = git(input.worktree, ['symbolic-ref', TARGET_REF, target]);
  return pointed.code === 0
    ? null
    : `Cannot record the target branch in ${input.worktree}: ${pointed.stderr}`;
}

export type BaseCheck =
  | { kind: 'ok' }
  // HEAD left the round's start: something in the worktree rebased, reset,
  // or committed.
  | { kind: 'moved'; message: string }
  // The history cannot answer: no common history with the target, or git
  // failed. Never taken as a clean diff.
  | { kind: 'unreadable'; message: string };

// Whether the worktree still compares cleanly: HEAD descends from the round
// base, and shares history with the target.
export function checkBases(worktree: string, base: string): BaseCheck {
  const short = base.slice(0, 12);
  const descends = git(worktree, ['merge-base', '--is-ancestor', base, 'HEAD']);
  if (descends.code === 1) {
    return {
      kind: 'moved',
      message: `HEAD no longer descends from the round's start ${short} (${ROUND_BASE_REF}): the branch was rebased or reset. Bring HEAD back to ${short} and leave the work uncommitted on it.`,
    };
  }
  if (descends.code !== 0) {
    return {
      kind: 'unreadable',
      message: `Cannot check that HEAD descends from the round base ${short}: ${descends.stderr || `git exited with ${descends.code}`}. No project check ran.`,
    };
  }
  const target = git(worktree, ['rev-parse', '--verify', '--quiet', TARGET_REF]);
  if (target.code !== 0) {
    // No target recorded, as for a repository without a branch to target.
    return { kind: 'ok' };
  }
  const shared = git(worktree, ['merge-base', 'HEAD', TARGET_REF]);
  if (shared.code !== 0) {
    return {
      kind: 'unreadable',
      message: `HEAD shares no history with the target (${TARGET_REF}): ${shared.stderr || 'git merge-base found none'}. Comparing against it would count every file as the ticket's, so no project check ran.`,
    };
  }
  return { kind: 'ok' };
}

// A fetch that waits on a password or host-key prompt fails instead.
const FETCH_TIMEOUT_MS = 120_000;

// Brings the target's remote-tracking branch up to date in the worktree's
// repository, so the merge-base with it sees a branch rebased onto a newer
// target, or the target merged in. Awaited, so the server keeps answering.
// Null when it is current, or when there is no remote to fetch from; else
// why the fetch failed, which leaves the older ref in place.
export async function fetchTarget(input: {
  targetBranch: string;
  timeoutMs?: number;
  worktree: string;
}): Promise<string | null> {
  const remotes = git(input.worktree, ['remote']);
  const remote = targetRemote(remotes.stdout.split('\n').filter((name) => name.length > 0));
  if (remote === null) {
    return null;
  }
  const branch = input.targetBranch;
  const result = await new Promise<Git>((resolve) => {
    const child = spawn(
      'git',
      ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`],
      {
        cwd: input.worktree,
        env: {
          ...process.env,
          GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] ?? 'ssh -o BatchMode=yes',
          GIT_TERMINAL_PROMPT: '0',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: input.timeoutMs ?? FETCH_TIMEOUT_MS,
      },
    );
    const stderr: Array<Buffer> = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      resolve({ code: 1, stderr: error.message, stdout: '' });
    });
    child.on('close', (code, signal) => {
      resolve({
        code: code ?? 1,
        stderr:
          Buffer.concat(stderr).toString('utf8').trim() ||
          (signal === null ? '' : `stopped by ${signal}`),
        stdout: '',
      });
    });
  });
  return result.code === 0
    ? null
    : `Cannot fetch ${remote}/${branch}: ${result.stderr || 'git fetch failed'}`;
}
