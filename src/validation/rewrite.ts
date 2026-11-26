import { spawnSync } from 'node:child_process';

// What changed in the ticket's history since it was handed off, other than
// new commits on top: a rebase onto a newer target, or the target merged in.
// A person does either when the pull request conflicts with its target, and
// resolves the conflicts by hand. The next feedback round reviews only what
// it changes itself, from the commit it starts at, so a resolution made
// before that is reviewed by no one unless the round is told about it.

export type Rewrite =
  | { kind: 'none' }
  // The history changed: `summary` says how, in a line, and `detail` shows
  // each change, as git range-diff or a merge's remerge-diff has it.
  | { detail: string; kind: 'changed'; summary: string }
  // The history changed, and what it was before is gone.
  | { kind: 'unknown'; summary: string };

type Git = { code: number; stderr: string; stdout: string };

function git(cwd: string, args: Array<string>): Git {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return {
    code: result.status ?? 1,
    stderr: (result.stderr ?? '').trim() || result.error?.message || '',
    stdout: result.stdout ?? '',
  };
}

// Bounds the detail, so a large rewrite stays readable in the task file.
const DETAIL_LINES = 400;

function bounded(text: string): string {
  const lines = text.trimEnd().split('\n');
  return lines.length <= DETAIL_LINES
    ? lines.join('\n')
    : [
        ...lines.slice(0, DETAIL_LINES),
        `… ${lines.length - DETAIL_LINES} more lines; run git range-diff in the worktree for the rest.`,
      ].join('\n');
}

// Where the branch was before its latest change, from its reflog: the
// newest entry that is not HEAD. For a ticket handed off before the factory
// kept the handoff's head.
export function reflogHead(worktree: string, branch: string): string | null {
  const log = git(worktree, ['reflog', 'show', '--format=%H', `refs/heads/${branch}`]);
  if (log.code !== 0) {
    return null;
  }
  const head = git(worktree, ['rev-parse', 'HEAD']).stdout.trim();
  return (
    log.stdout
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0 && line !== head) ?? null
  );
}

function subjects(worktree: string, commits: Array<string>): string {
  return commits
    .map((commit) => `"${git(worktree, ['log', '-1', '--format=%s', commit]).stdout.trim()}"`)
    .join(', ');
}

// What changed between `previous`, where the ticket was handed off, and the
// worktree's HEAD, besides new commits on top. `target` is the ref the
// ticket's target branch is read from; null when none can be chosen, and a
// rebase then cannot be compared.
export function findRewrite(input: {
  previous: string;
  target: string | null;
  worktree: string;
}): Rewrite {
  const { previous, target, worktree } = input;
  const short = previous.slice(0, 12);
  if (git(worktree, ['cat-file', '-e', `${previous}^{commit}`]).code !== 0) {
    return {
      kind: 'unknown',
      summary: `The branch's history changed since it was handed off at ${short}, and that commit is no longer in the repository, so what changed cannot be shown. Review the whole pull request against its target.`,
    };
  }
  // Commits on top, the target merged in among them.
  if (git(worktree, ['merge-base', '--is-ancestor', previous, 'HEAD']).code === 0) {
    const merges = git(worktree, ['rev-list', '--merges', '--reverse', `${previous}..HEAD`])
      .stdout.split('\n')
      .filter((line) => line.length > 0);
    // A merge git would have made alone shows nothing past its header: only
    // a hand resolution, or a change made in the merge, remains. A merge git
    // cannot recreate, or a git without --remerge-diff, is never taken as
    // clean.
    const shown: Array<{ merge: string; text: string }> = [];
    for (const merge of merges) {
      const shownMerge = git(worktree, [
        'show',
        '--remerge-diff',
        '--no-color',
        '--format=commit %h %s',
        merge,
      ]);
      if (shownMerge.code !== 0) {
        return {
          kind: 'unknown',
          summary: `Since the handoff at ${short}, ${subjects(worktree, [merge])} merged into the branch, and git cannot show what the merge changed by hand: ${shownMerge.stderr || `git exited with ${shownMerge.code}`}. Review the merge against what git would have merged.`,
        };
      }
      const body = shownMerge.stdout.split('\n').slice(1).join('\n').trim();
      if (body.length > 0) {
        shown.push({ merge, text: shownMerge.stdout });
      }
    }
    if (shown.length === 0) {
      return { kind: 'none' };
    }
    return {
      detail: bounded(shown.map((item) => item.text).join('\n')),
      kind: 'changed',
      summary: `Since the handoff at ${short}, ${shown.length === 1 ? 'a merge' : `${shown.length} merges`} into the branch (${subjects(
        worktree,
        shown.map((item) => item.merge),
      )}) changed the code by hand, beyond what git would have merged alone.`,
    };
  }
  // Rewritten: compare each commit as it was with what it became, each range
  // from where it left the target.
  if (target === null) {
    return {
      kind: 'unknown',
      summary: `The branch's history changed since it was handed off at ${short}, and no remote can be chosen to read its target from, so the change cannot be compared. Review the whole pull request against its target.`,
    };
  }
  const before = git(worktree, ['merge-base', previous, target]).stdout.trim();
  const after = git(worktree, ['merge-base', 'HEAD', target]).stdout.trim();
  if (before.length === 0 || after.length === 0) {
    return {
      kind: 'unknown',
      summary: `The branch's history changed since it was handed off at ${short}, and it shares no history with the target to compare by. Review the whole pull request against its target.`,
    };
  }
  const ranges = git(worktree, [
    'range-diff',
    '--no-color',
    '--creation-factor=100',
    `${before}..${previous}`,
    `${after}..HEAD`,
  ]);
  if (ranges.code !== 0) {
    return {
      kind: 'unknown',
      summary: `The branch's history changed since it was handed off at ${short}, and git range-diff failed: ${ranges.stderr}. Review the whole pull request against its target.`,
    };
  }
  // `=` pairs a commit with an identical one; `!` a changed one; `<` and `>`
  // a commit dropped or added.
  const header = /^\s*(\d+|-):\s+([0-9a-f]+|-+)\s+([=!<>])\s+(\d+|-):\s+([0-9a-f]+|-+)\s+(.*)$/;
  const lines = ranges.stdout.split('\n');
  const changed = lines
    .map((line) => header.exec(line))
    .filter((match): match is RegExpExecArray => match !== null && match[3] !== '=');
  if (changed.length === 0) {
    return { kind: 'none' };
  }
  const detail = lines.filter((line) => {
    const match = header.exec(line);
    return match === null || match[3] !== '=';
  });
  return {
    detail: bounded(detail.join('\n')),
    kind: 'changed',
    summary: `Since the handoff at ${short}, the branch was rebased, and the rebase changed ${changed.length === 1 ? 'a commit' : `${changed.length} commits`}: ${changed.map((match) => `"${match[6] ?? ''}"`).join(', ')}.`,
  };
}
