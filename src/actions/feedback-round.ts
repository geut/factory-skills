import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FactorySnapshot, FeedbackRound } from '../domain.ts';
import type { CodeHost } from '../ports/code-host.ts';
import type { PullRequestFeedback } from '../ports/pull-request-feedback.ts';
import {
  candidateOf,
  type FeedbackCandidate,
  feedbackRoundRefusal,
  feedbackRounds,
  feedbackTaskFile,
  renderFeedbackTask,
  roundItems,
  roundRecord,
  type RoundRewrite,
  seenComments,
  selectFeedback,
} from '../stages/feedback.ts';
import { stageEnabled } from '../stages/flow.ts';
import { fetchTarget, targetRefFor } from '../validation/bases.ts';
import { findRewrite, reflogHead } from '../validation/rewrite.ts';

// Prepares a feedback round on a ticket's open pull request: reads the
// feedback posted since the factory's last push and renders the round's task
// file. Nothing changes here, so a refusal leaves the ticket as it was; the
// caller writes the file once the controller has accepted the round.

export type PreparedRound = {
  // What the controller keeps about the round.
  feedback: FeedbackRound;
  // Why the target could not be fetched, or null: the round goes on, and
  // its checks compare against the target as last fetched.
  fetchFailure: string | null;
  round: number;
  startHead: string;
  // Where the task file goes, relative to the ticket directory, and its text.
  taskFile: string;
  taskText: string;
  title: string;
};

export type FeedbackRefusal = {
  message: string;
  reason: 'code_host_unavailable' | 'invalid_state';
};

function refuse(message: string): FeedbackRefusal {
  return { message, reason: 'invalid_state' };
}

function headOf(worktree: string): string | null {
  const result = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: worktree, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

async function readFeedback(codeHost: CodeHost, url: string, seen: ReadonlySet<string>) {
  try {
    const pullRequest = await codeHost.pullRequest(url);
    if (pullRequest === null || pullRequest.state !== 'open') {
      return refuse(`${url} is ${pullRequest?.state ?? 'gone'}, not open.`);
    }
    return { feedback: await codeHost.pullRequestFeedback(pullRequest, seen), pullRequest };
  } catch (error: unknown) {
    const failed: FeedbackRefusal = {
      message: `Cannot read ${url}: ${error instanceof Error ? error.message : String(error)}`,
      reason: 'code_host_unavailable',
    };
    return failed;
  }
}

// Which pending comments a round takes: all of them by default, only the
// refs in `only`, or all but the refs in `skip`, which are dismissed for good.
export type FeedbackChoice = { only: Array<string> | null; skip: Array<string> };

const ALL: FeedbackChoice = { only: null, skip: [] };

function noneLeft(url: string, feedback: PullRequestFeedback): string {
  const skipped =
    feedback.skipped.length === 0
      ? ''
      : ` (${feedback.skipped.length} skipped: not from collaborators or codeHost.feedback.authors)`;
  const truncated = feedback.truncated
    ? ' GitHub had more than one page, so only the newest 100 of each list were read.'
    : '';
  return `No pending feedback on ${url}${skipped}.${truncated} Add a note to start a round anyway.`;
}

// The pull request's pending feedback, for the operator to pick from: what
// `/factory feedback --list` and the API's feedback read show. Nothing changes.
export async function listFeedback(input: {
  codeHost: CodeHost;
  pullRequestUrl: string | null;
  snapshot: FactorySnapshot;
}): Promise<
  | {
      candidates: Array<FeedbackCandidate>;
      pullRequestUrl: string;
      skipped: PullRequestFeedback['skipped'];
      truncated: boolean;
    }
  | FeedbackRefusal
> {
  if (input.pullRequestUrl === null) {
    return refuse(`${input.snapshot.ticket.displayRef} has no pull request to take feedback from.`);
  }
  const read = await readFeedback(
    input.codeHost,
    input.pullRequestUrl,
    seenComments(input.snapshot.tasks),
  );
  if ('reason' in read) {
    return read;
  }
  return {
    candidates: read.feedback.items.map((item) => candidateOf(item)),
    pullRequestUrl: input.pullRequestUrl,
    skipped: read.feedback.skipped,
    truncated: read.feedback.truncated,
  };
}

// What changed in the branch's history since the ticket was last handed off,
// besides commits on top, as the round's item, or null when nothing did. The
// handoff's head is the one the factory kept; a ticket handed off before it
// kept them uses the branch's reflog.
function rewriteSinceHandoff(snapshot: FactorySnapshot, worktree: string): RoundRewrite | null {
  const { execution } = snapshot;
  const previous =
    snapshot.runs.findLast((run) => run.handoffHead !== null)?.handoffHead ??
    (execution.worktreeBranch === null ? null : reflogHead(worktree, execution.worktreeBranch));
  if (previous === null) {
    return null;
  }
  const target =
    (execution.worktreeBaseBranch === null
      ? null
      : targetRefFor(worktree, execution.worktreeBaseBranch)) ??
    execution.worktreeBaseSha ??
    'HEAD';
  const found = findRewrite({ previous, target, worktree });
  switch (found.kind) {
    case 'none':
      return null;
    case 'changed':
      return { detail: found.detail, summary: found.summary };
    case 'unknown':
      return { detail: null, summary: found.summary };
    default: {
      const _exhaustive: never = found;
      return _exhaustive;
    }
  }
}

export async function prepareFeedbackRound(input: {
  choice?: FeedbackChoice;
  codeHost: CodeHost;
  note: string | null;
  // The pull request recorded for the ticket, if any.
  pullRequestUrl: string | null;
  snapshot: FactorySnapshot;
}): Promise<PreparedRound | FeedbackRefusal> {
  const { execution, ticket } = input.snapshot;
  const refusal = feedbackRoundRefusal(input.snapshot);
  if (refusal !== null) {
    return refuse(refusal);
  }
  if (input.pullRequestUrl === null) {
    return refuse(`${ticket.displayRef} has no pull request to take feedback from.`);
  }
  const worktree = execution.worktreePath;
  const head = worktree === null ? null : headOf(worktree);
  if (worktree === null || head === null) {
    return refuse(`${ticket.displayRef} has no worktree to work in.`);
  }
  const read = await readFeedback(
    input.codeHost,
    input.pullRequestUrl,
    seenComments(input.snapshot.tasks),
  );
  if ('reason' in read) {
    return read;
  }
  const { feedback, pullRequest } = read;
  // The round commits on top of what the pull request shows; a commit pushed
  // there from elsewhere would make wrap-up's push fail.
  if (pullRequest.headSha !== null && pullRequest.headSha !== head) {
    return refuse(
      `${input.pullRequestUrl} is at ${pullRequest.headSha.slice(0, 7)}, the worktree at ${head.slice(0, 7)}. Bring the worktree to the pull request's head first.`,
    );
  }
  const chosen = selectFeedback(feedback, input.choice ?? ALL);
  if ('unknown' in chosen) {
    const pending = feedback.items.map((item) => item.ref);
    return refuse(
      `${chosen.unknown.join(', ')} ${chosen.unknown.length === 1 ? 'is' : 'are'} not pending feedback on ${input.pullRequestUrl}. Pending: ${pending.length === 0 ? 'none' : pending.join(', ')}.`,
    );
  }
  // The pull request has sat in review while the target moved, and may have
  // been rebased onto it: the target is fetched, so the round's checks find
  // the merge-base the branch has now.
  const fetchFailure =
    execution.worktreeBaseBranch === null
      ? null
      : await fetchTarget({ targetBranch: execution.worktreeBaseBranch, worktree });
  const rewrite = rewriteSinceHandoff(input.snapshot, worktree);
  const items = roundItems(chosen.items, input.note, rewrite);
  if (items.length === 0) {
    return refuse(noneLeft(input.pullRequestUrl, feedback));
  }
  const round = feedbackRounds(input.snapshot.tasks) + 1;
  return {
    feedback: roundRecord({
      dismissed: chosen.dismissed,
      feedback,
      items,
      pullRequestUrl: input.pullRequestUrl,
      round,
    }),
    fetchFailure,
    round,
    startHead: head,
    taskFile: feedbackTaskFile(round),
    taskText: renderFeedbackTask({
      feedback,
      items,
      pullRequestUrl: input.pullRequestUrl,
      qa: stageEnabled(execution.policy, 'qa'),
      round,
    }),
    title: `Feedback round ${round}`,
  };
}

// Writes an accepted round's task file into the ticket directory, unless it is
// there already: a repeated command must not change a round that is running.
export function writeFeedbackTask(factoryDir: string, round: PreparedRound): void {
  const file = path.join(factoryDir, round.taskFile);
  mkdirSync(path.dirname(file), { recursive: true });
  try {
    writeFileSync(file, round.taskText, { flag: 'wx' });
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) {
      throw error;
    }
  }
}
