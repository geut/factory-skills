import { existsSync } from 'node:fs';
import {
  cleanUpTicket,
  completedTickets,
  needsAttention,
  NO_WAIT,
  outcomeLine,
  pullRequestCommits,
  type CleanupOutcome,
} from '../actions/cleanup.ts';
import { listProcesses, type ProcessInfo } from '../actions/strays.ts';
import { factoryPaths } from '../controller/service.ts';
import { openStateDatabase, stateDatabasePath } from '../state/database.ts';

export const cleanupUsage = `Usage:
  factory cleanup [--dry-run]   remove completed tickets' worktrees and local branches

The server does this when a ticket completes. This command applies the same
checks to every completed ticket, such as those that completed before, or
after you resolved what a cleanup kept. A worktree with changes no commit
holds, or that a process runs in, stays; so does a branch with commits on no
remote branch and in no merged pull request. Remote branches are never
touched. --dry-run says what would go and changes nothing.`;

type Io = { err: (line: string) => void; out: (line: string) => void };

export async function runCleanupCommand(
  args: Array<string>,
  cwd: string,
  io: Io,
  deps: { processes?: () => Promise<ReadonlyArray<ProcessInfo>> } = {},
): Promise<number> {
  const [flag, ...extra] = args;
  if (flag === '--help' || flag === '-h') {
    io.out(cleanupUsage);
    return 0;
  }
  if (extra.length > 0 || (flag !== undefined && flag !== '--dry-run')) {
    io.err(cleanupUsage);
    return 2;
  }
  const dryRun = flag === '--dry-run';
  const { factoryRoot } = factoryPaths(cwd);
  if (!existsSync(stateDatabasePath(factoryRoot))) {
    io.err(`No factory in ${factoryRoot}: there is no state database yet.`);
    return 1;
  }
  const db = openStateDatabase(factoryRoot, { readOnly: true });
  // One look at the processes for every ticket.
  const processes = await (deps.processes ?? listProcesses)();
  const outcomes: Array<CleanupOutcome> = [];
  try {
    const tickets = completedTickets(db);
    for (const snapshot of tickets) {
      const outcome = await cleanUpTicket({
        dryRun,
        processes: () => Promise.resolve(processes),
        pullRequestCommits: pullRequestCommits(db, snapshot.execution.id),
        snapshot,
        wait: NO_WAIT,
      });
      outcomes.push(outcome);
      const line = outcomeLine(outcome);
      if (line !== null) {
        io.out(line);
      }
    }
    if (outcomes.every((outcome) => outcomeLine(outcome) === null)) {
      io.out(
        `Nothing to clean up: ${tickets.length} completed ticket${tickets.length === 1 ? '' : 's'} checked.`,
      );
    } else if (outcomes.some(needsAttention)) {
      io.out('Resolve what was kept, then run factory cleanup again.');
    }
  } finally {
    db.close();
  }
  return outcomes.some((outcome) =>
    [outcome.worktree, outcome.branch].some((item) => item.kind === 'failed'),
  )
    ? 1
    : 0;
}
