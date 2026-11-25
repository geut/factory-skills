import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { WrapupBaseline } from '../domain.ts';
import { syncWorktreeRefs, ticketBase, unreadableHistory } from './bases.ts';
import { refSha, remoteRefs } from './wrapup.ts';

// Carries a paused wrap-up pass over to its branch after a person rebased it
// onto a newer target: `/factory retry <ticket> --rebased`. The pass keeps
// what it must: the hashes of the files it started with, so a product change
// wrap-up made is still caught, and its start, mapped to the rebased
// history. Only what the rebase brought in goes: the paths whose content is
// the target's own. A commit the rebase changed is refused, never carried:
// its conflict resolution is a change no one reviewed.

export type CarriedPass = {
  baseline: WrapupBaseline;
  // The paths dropped as the target's own, and those kept.
  dropped: Array<string>;
  kept: Array<string>;
  // The feedback round's start on the rebased branch, or null before a
  // round: the round's diff and its pull-request comment compare against it.
  roundStart: string | null;
};

export type CarryResult =
  | { kind: 'carried'; pass: CarriedPass }
  | { kind: 'refused'; message: string };

type Git = { code: number; stderr: string; stdout: string };

function git(cwd: string, args: Array<string>, input?: string): Git {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    ...(input === undefined ? {} : { input }),
  });
  return {
    code: result.status ?? 1,
    stderr: (result.stderr ?? '').trim() || result.error?.message || '',
    stdout: result.stdout ?? '',
  };
}

// Each commit of `range` that changes something, oldest first, with its
// patch-id: what the commit changes, whitespace included, whatever it sits
// on. Merges carry none.
function patchIds(worktree: string, range: string): Array<{ commit: string; id: string }> | string {
  const log = git(worktree, ['log', '--reverse', '-p', '--no-color', '--format=commit %H', range]);
  if (log.code !== 0) {
    return log.stderr || `git log ${range} failed`;
  }
  // Verbatim: a change in indentation alone, which can change what Python
  // code does, is a different patch.
  const ids = git(worktree, ['patch-id', '--verbatim'], log.stdout);
  if (ids.code !== 0) {
    return ids.stderr || 'git patch-id failed';
  }
  return ids.stdout
    .split('\n')
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      const [id, commit] = line.split(' ');
      return id === undefined || commit === undefined ? [] : [{ commit, id }];
    });
}

function subject(worktree: string, commit: string): string {
  return git(worktree, ['log', '-1', '--format=%s', commit]).stdout.trim();
}

// Where the pass started, in the rebased history: the same commit when the
// rebase kept it, else the rebased copy of its last commit, found by
// patch-id, in order. Null with why when a commit has no copy with the same
// patch.
function mappedStart(input: {
  compareBase: string;
  from: string;
  start: string;
  worktree: string;
}): { commit: string } | { message: string } {
  const { worktree } = input;
  if (git(worktree, ['merge-base', '--is-ancestor', input.start, 'HEAD']).code === 0) {
    return { commit: input.start };
  }
  if (git(worktree, ['cat-file', '-e', `${input.start}^{commit}`]).code !== 0) {
    return {
      message: `The commit the pass started from, ${input.start.slice(0, 12)}, is no longer in the repository, so the pass cannot be mapped onto the rebased branch.`,
    };
  }
  const before = patchIds(worktree, `${input.from}..${input.start}`);
  const after = patchIds(worktree, `${input.compareBase}..HEAD`);
  if (typeof before === 'string' || typeof after === 'string') {
    return {
      message: `Cannot compare the commits before and after the rebase: ${String(typeof before === 'string' ? before : after)}`,
    };
  }
  // The pass started before any ticket commit: it starts at the new base.
  if (before.length === 0) {
    return { commit: input.compareBase };
  }
  let at = 0;
  let last = input.compareBase;
  for (const old of before) {
    const index = after.findIndex((entry, position) => position >= at && entry.id === old.id);
    if (index === -1) {
      return {
        message: `The rebase changed ${old.commit.slice(0, 12)} "${subject(worktree, old.commit)}": no commit on the rebased branch makes the same change, so a conflict resolution changed it. It needs a review before the pass can carry over.`,
      };
    }
    at = index + 1;
    last = after[index]?.commit ?? last;
  }
  return { commit: last };
}

// The SHA-256 of each path's content at `commit`, as the baseline hashes
// files (`deleted` when the commit has none), in one git process.
function contentHashes(
  worktree: string,
  commit: string,
  paths: Array<string>,
): Record<string, string> | string {
  if (paths.length === 0) {
    return {};
  }
  const result = spawnSync('git', ['cat-file', '--batch'], {
    cwd: worktree,
    input: paths.map((file) => `${commit}:${file}\n`).join(''),
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== 0) {
    return result.stderr.toString('utf8').trim() || 'git cat-file failed';
  }
  const out = result.stdout;
  const hashes: Record<string, string> = {};
  let offset = 0;
  for (const file of paths) {
    const end = out.indexOf(0x0a, offset);
    const header = out.subarray(offset, end).toString('utf8');
    offset = end + 1;
    if (header.endsWith(' missing')) {
      hashes[file] = 'deleted';
      continue;
    }
    const size = Number(header.split(' ')[2]);
    if (header.split(' ')[1] !== 'blob' || !Number.isInteger(size)) {
      // A directory or submodule at that path: not the file the pass hashed.
      hashes[file] = `not a file: ${header}`;
      offset += Number.isInteger(size) ? size + 1 : 0;
      continue;
    }
    hashes[file] = createHash('sha256')
      .update(out.subarray(offset, offset + size))
      .digest('hex');
    offset += size + 1;
  }
  return hashes;
}

// The pass carried over to the rebased branch, or why it cannot be. It
// changes nothing but the worktree's refs, so a dry run is the same call.
export function carryPassOver(input: {
  baseBranch: string | null;
  baseline: WrapupBaseline;
  // Where the ticket branched.
  branched: string;
  codeRoot: string;
  // The feedback round's start, or null before a round.
  roundStart: string | null;
  worktree: string;
}): CarryResult {
  const { baseline, worktree } = input;
  const roundBase = input.roundStart ?? input.branched;
  const synced = syncWorktreeRefs({
    roundBase,
    targetBranch: input.baseBranch,
    worktree,
  });
  if (synced !== null) {
    return { kind: 'refused', message: synced };
  }
  const unreadable = unreadableHistory(worktree, roundBase);
  if (unreadable !== null) {
    return { kind: 'refused', message: unreadable };
  }
  const compareBase = ticketBase(worktree, input.branched);
  const start = mappedStart({
    compareBase,
    from: baseline.compareBase ?? input.branched,
    start: baseline.head,
    worktree,
  });
  if ('message' in start) {
    return { kind: 'refused', message: start.message };
  }
  // The round's start moves with the rebase as the pass's does, so the
  // round's diff never holds what the target gained.
  const round =
    input.roundStart === null
      ? null
      : mappedStart({
          compareBase,
          from: baseline.compareBase ?? input.branched,
          start: input.roundStart,
          worktree,
        });
  if (round !== null && 'message' in round) {
    return { kind: 'refused', message: round.message };
  }
  const roundStart = round?.commit ?? null;
  const resynced = syncWorktreeRefs({
    roundBase: roundStart ?? input.branched,
    targetBranch: input.baseBranch,
    worktree,
  });
  if (resynced !== null) {
    return { kind: 'refused', message: resynced };
  }
  const paths = Object.keys(baseline.worktree).sort();
  const target = contentHashes(worktree, compareBase, paths);
  if (typeof target === 'string') {
    return { kind: 'refused', message: `Cannot read the target's files: ${target}` };
  }
  // A path whose content at pass start was the target's own came with the
  // rebase; any other keeps its hash, so wrap-up changing it is still seen.
  const dropped = paths.filter((file) => target[file] === baseline.worktree[file]);
  const kept = paths.filter((file) => target[file] !== baseline.worktree[file]);
  // When the rebase moved the pass's start, a file the pass started with as
  // committed is now as the rebased start commit has it: a clean rebase may
  // have brought the target's own hunks into it. A file that differed from
  // its commit, uncommitted then, keeps its hash.
  const carried: Record<string, string> = Object.fromEntries(
    kept.map((file) => [file, baseline.worktree[file] ?? 'deleted']),
  );
  if (start.commit !== baseline.head) {
    const before = contentHashes(worktree, baseline.head, kept);
    const after = contentHashes(worktree, start.commit, kept);
    if (typeof before === 'string' || typeof after === 'string') {
      return {
        kind: 'refused',
        message: `Cannot read the pass's files before and after the rebase: ${String(typeof before === 'string' ? before : after)}`,
      };
    }
    for (const file of kept) {
      if (before[file] === baseline.worktree[file] && after[file] !== undefined) {
        carried[file] = after[file];
      }
    }
  }
  return {
    kind: 'carried',
    pass: {
      baseline: {
        ...baseline,
        // The person rebased and pushed with the base branch where it is now.
        baseHead:
          input.baseBranch === null
            ? baseline.baseHead
            : refSha(input.codeRoot, `refs/heads/${input.baseBranch}`),
        compareBase,
        head: start.commit,
        remotes: remoteRefs(worktree, baseline.branch),
        worktree: carried,
      },
      dropped,
      kept,
      roundStart,
    },
  };
}
