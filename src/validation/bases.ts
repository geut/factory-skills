import { spawn, spawnSync } from 'node:child_process';
import type { FactorySnapshot } from '../domain.ts';
import { feedbackRounds } from '../stages/feedback.ts';
import type { ValidationCheck } from './report.ts';

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

// The remote a ticket's target comes from, as worktree preparation chooses
// it: `origin`, or the only remote. Null without one, or among several with
// no `origin`.
export function targetRemote(names: ReadonlyArray<string>): string | null {
  return names.includes('origin') ? 'origin' : names.length === 1 ? (names[0] ?? null) : null;
}

// The fetch that brings `remote`'s `branch` into its remote-tracking ref:
// worktree preparation's and a feedback round's.
export function targetFetchArgs(remote: string, branch: string): Array<string> {
  return ['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`];
}

function remotesOf(worktree: string): Array<string> {
  return git(worktree, ['remote'])
    .stdout.split('\n')
    .filter((name) => name.length > 0);
}

// The remote the worktree's target ref names, as written when the ticket's
// first run started, or null when there is none yet.
// Branch and remote names may both hold slashes (`fork` and
// `release/stable`), so the remote is what sits between `refs/remotes/` and
// the known branch.
function recordedRemote(worktree: string, branch: string): string | null {
  const current = git(worktree, ['symbolic-ref', '--quiet', TARGET_REF]);
  const prefix = 'refs/remotes/';
  const suffix = `/${branch}`;
  const ref = current.stdout;
  if (
    current.code !== 0 ||
    !ref.startsWith(prefix) ||
    !ref.endsWith(suffix) ||
    ref.length <= prefix.length + suffix.length
  ) {
    return null;
  }
  return ref.slice(prefix.length, -suffix.length);
}

// The ref the worktree's target ref names, or would name once written,
// without writing it: what a read compares against. Null when no remote can
// be chosen among several, none of them origin, so a check falls back to its
// own default.
export function targetRefFor(worktree: string, targetBranch: string): string | null {
  const current = git(worktree, ['symbolic-ref', '--quiet', TARGET_REF]);
  if (current.code === 0 && current.stdout.length > 0) {
    return current.stdout;
  }
  const remotes = remotesOf(worktree);
  const remote = targetRemote(remotes);
  if (remote === null && remotes.length > 0) {
    return null;
  }
  return remote === null ? `refs/heads/${targetBranch}` : `refs/remotes/${remote}/${targetBranch}`;
}

// Points the worktree's refs at the ticket's current state; repeating it
// changes nothing. The target ref is written once, from the remote the
// repository has then, and kept: a remote added later never moves it to
// another. Null on success, or why it failed.
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
  if (git(input.worktree, ['symbolic-ref', '--quiet', TARGET_REF]).code === 0) {
    return null;
  }
  const target = targetRefFor(input.worktree, input.targetBranch);
  if (target === null) {
    return null;
  }
  const pointed = git(input.worktree, ['symbolic-ref', TARGET_REF, target]);
  return pointed.code === 0
    ? null
    : `Cannot record the target branch in ${input.worktree}: ${pointed.stderr}`;
}

// Whether HEAD is still the round's start, as work and QA leave it: their
// changes stay uncommitted on it. A commit, a rebase, or a reset is a check
// that fails, for the stage's agent to correct.
export function headCheck(worktree: string, base: string): ValidationCheck | { message: string } {
  const head = git(worktree, ['rev-parse', 'HEAD']);
  if (head.code !== 0) {
    return { message: head.stderr || 'cannot read HEAD' };
  }
  const moved = head.stdout !== base;
  return {
    command: null,
    details: moved
      ? `HEAD is at ${head.stdout}, not the round's start ${base}: leave the work uncommitted on ${base}, without committing, rebasing, or resetting the branch`
      : `HEAD matches ${base}`,
    durationMs: null,
    exitCode: null,
    kind: 'policy',
    name: 'uncommitted',
    outputExcerpt: null,
    status: moved ? 'failed' : 'passed',
  };
}

// Where the ticket's own changes begin: the merge-base of HEAD with the
// target, which follows the branch rebased onto a newer target or the target
// merged in. `branched` (where the ticket started) without a target, or when
// git finds none.
export function ticketBase(worktree: string, branched: string, target = TARGET_REF): string {
  if (git(worktree, ['rev-parse', '--verify', '--quiet', target]).code !== 0) {
    return branched;
  }
  const shared = git(worktree, ['merge-base', 'HEAD', target]);
  return shared.code === 0 && shared.stdout.length > 0 ? shared.stdout : branched;
}

// Why the worktree's history cannot answer what the ticket changed, or null
// when it can: the round base is not a commit git has, or HEAD shares no
// history with the target. Validation stops on it before any command, since
// a comparison then would count every file as the ticket's; it is never
// taken as a clean diff.
export function unreadableHistory(
  worktree: string,
  base: string,
  target = TARGET_REF,
): string | null {
  const known = git(worktree, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`]);
  if (known.code !== 0) {
    return `The round base ${base.slice(0, 12)} is not a commit in this repository. No project check ran.`;
  }
  if (git(worktree, ['rev-parse', '--verify', '--quiet', target]).code !== 0) {
    // No target recorded, as for a repository without a branch to target.
    return null;
  }
  const shared = git(worktree, ['merge-base', 'HEAD', target]);
  return shared.code === 0
    ? null
    : `HEAD shares no history with the target (${TARGET_REF}): ${shared.stderr || 'git merge-base found none'}. Comparing against it would count every file as the ticket's, so no project check ran.`;
}

// A fetch that waits on a password, a host-key prompt, or a host that never
// answers fails instead.
const FETCH_TIMEOUT_MS = 120_000;

// Brings the target's remote-tracking branch up to date in the worktree's
// repository, so the merge-base with it sees a branch rebased onto a newer
// target, or the target merged in. It fetches from the remote the target ref
// names. Awaited, so the server keeps answering; the fetch runs in a process
// group of its own, which the timeout ends whole, ssh included. Null when the
// target is current, or when the repository has no remote; else why not,
// which leaves the older ref in place.
export async function fetchTarget(input: {
  targetBranch: string;
  timeoutMs?: number;
  worktree: string;
}): Promise<string | null> {
  const branch = input.targetBranch;
  const remotes = remotesOf(input.worktree);
  const remote = recordedRemote(input.worktree, branch) ?? targetRemote(remotes);
  if (remote === null) {
    return remotes.length === 0
      ? null
      : `Cannot choose a remote to fetch ${branch} from among ${remotes.join(', ')}; name one origin.`;
  }
  const timeoutMs = input.timeoutMs ?? FETCH_TIMEOUT_MS;
  const result = await new Promise<Git>((resolve) => {
    const child = spawn('git', targetFetchArgs(remote, branch), {
      cwd: input.worktree,
      detached: true,
      env: {
        ...process.env,
        GIT_SSH_COMMAND: process.env['GIT_SSH_COMMAND'] ?? 'ssh -o BatchMode=yes',
        GIT_TERMINAL_PROMPT: '0',
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    const stderr: Array<Buffer> = [];
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // The whole group: git, and the ssh or helper it started.
        if (child.pid !== undefined) {
          process.kill(-child.pid, 'SIGKILL');
        }
      } catch {
        // Already gone.
      }
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stderr: error.message, stdout: '' });
    });
    // Exit, not close: a child that kept the pipe open never holds this up.
    child.on('exit', (code) => {
      clearTimeout(timer);
      const said = Buffer.concat(stderr).toString('utf8').trim();
      resolve({
        code: timedOut ? 1 : (code ?? 1),
        stderr: timedOut ? `timed out after ${Math.ceil(timeoutMs / 1000)}s` : said,
        stdout: '',
      });
    });
  });
  return result.code === 0
    ? null
    : `Cannot fetch ${remote}/${branch}: ${result.stderr || 'git fetch failed'}`;
}
