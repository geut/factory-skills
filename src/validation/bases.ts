import { spawnSync } from 'node:child_process';
import type { FactorySnapshot } from '../domain.ts';
import { feedbackRounds } from '../stages/feedback.ts';

// The commits a project's checks compare a ticket against. A remote branch's
// tip, such as `origin/main`, moves under a running ticket: every ticket the
// factory starts fetches it into the code root, and every worktree shares the
// ref. A check comparing against the tip counts what landed upstream since
// the ticket branched as the ticket's own change. These commits are recorded
// per ticket and never move, so parallel tickets never shift each other's.

// The commit the ticket's branch started from: its merge-base with the target
// when it started, which answers "what did this ticket change".
export const TICKET_BASE_ENV = 'FACTORY_TICKET_BASE';
// The commit the current round of work started from: the feedback round's
// start, or the ticket base before any round. It answers "what did this round
// change".
export const ROUND_BASE_ENV = 'FACTORY_ROUND_BASE';
// The branch the ticket's pull request targets, by name: for messages and CI,
// not to compare against, since its tip moves.
export const TARGET_BRANCH_ENV = 'FACTORY_TARGET_BRANCH';

export const BASES_ENV = [TICKET_BASE_ENV, ROUND_BASE_ENV, TARGET_BRANCH_ENV] as const;

export type ComparisonBases = {
  roundBase: string;
  targetBranch: string | null;
  ticketBase: string;
};

// The ticket's comparison commits, or null before its worktree is ready. Once
// a feedback round starts, every later run belongs to it: rounds start only
// after the planned tasks are done.
export function comparisonBases(
  snapshot: Pick<FactorySnapshot, 'execution' | 'tasks'>,
): ComparisonBases | null {
  const { roundBaseSha, worktreeBaseBranch, worktreeBaseSha } = snapshot.execution;
  if (worktreeBaseSha === null) {
    return null;
  }
  return {
    roundBase:
      feedbackRounds(snapshot.tasks) > 0 && roundBaseSha !== null ? roundBaseSha : worktreeBaseSha,
    targetBranch: worktreeBaseBranch,
    ticketBase: worktreeBaseSha,
  };
}

// The bases as environment variables, the target branch only when known.
export function basesEnv(
  bases: ComparisonBases,
): Partial<Record<(typeof BASES_ENV)[number], string>> {
  return {
    [ROUND_BASE_ENV]: bases.roundBase,
    [TICKET_BASE_ENV]: bases.ticketBase,
    ...(bases.targetBranch === null ? {} : { [TARGET_BRANCH_ENV]: bases.targetBranch }),
  };
}

// Why `worktree`'s HEAD no longer descends from the ticket's bases, or null
// when it does. A branch rebased onto a newer target leaves the ticket base
// behind: a comparison against it would count the target's own changes as
// the ticket's, so the checks do not run on it. A history git cannot read is
// never taken as a clean one.
export function basesDiverged(worktree: string, bases: ComparisonBases): string | null {
  for (const [name, commit] of [
    ['ticket base', bases.ticketBase],
    ['round base', bases.roundBase],
  ] as const) {
    const result = spawnSync('git', ['merge-base', '--is-ancestor', commit, 'HEAD'], {
      cwd: worktree,
      encoding: 'utf8',
    });
    if (result.status === 0) {
      continue;
    }
    const short = commit.slice(0, 12);
    if (result.status === 1) {
      return `The worktree's HEAD no longer descends from the ${name} ${short} (${name === 'ticket base' ? TICKET_BASE_ENV : ROUND_BASE_ENV}): the branch was rebased or reset. No project check ran, since comparing against that commit would count other changes as the ticket's.`;
    }
    const reason =
      (result.stderr ?? '').trim() || result.error?.message || `git exited with ${result.status}`;
    return `Cannot check that the worktree descends from the ${name} ${short}: ${reason}. No project check ran.`;
  }
  return null;
}
