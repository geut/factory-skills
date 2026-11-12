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
  seenComments,
  selectFeedback,
} from '../stages/feedback.ts';
import { stageEnabled } from '../stages/flow.ts';

// Prepares a feedback round on a ticket's open pull request: reads the
// feedback posted since the factory's last push and renders the round's task
// file. Nothing changes here, so a refusal leaves the ticket as it was; the
// caller writes the file once the controller has accepted the round.

export type PreparedRound = {
  // What the controller keeps about the round.
  feedback: FeedbackRound;
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

function readFeedback(codeHost: CodeHost, url: string, seen: ReadonlySet<string>) {
  try {
    const pullRequest = codeHost.pullRequest(url);
    if (pullRequest === null || pullRequest.state !== 'open') {
      return refuse(`${url} is ${pullRequest?.state ?? 'gone'}, not open.`);
    }
    return { feedback: codeHost.pullRequestFeedback(pullRequest, seen), pullRequest };
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
export function listFeedback(input: {
  codeHost: CodeHost;
  pullRequestUrl: string | null;
  snapshot: FactorySnapshot;
}):
  | {
      candidates: Array<FeedbackCandidate>;
      pullRequestUrl: string;
      skipped: PullRequestFeedback['skipped'];
      truncated: boolean;
    }
  | FeedbackRefusal {
  if (input.pullRequestUrl === null) {
    return refuse(`${input.snapshot.ticket.displayRef} has no pull request to take feedback from.`);
  }
  const read = readFeedback(
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

export function prepareFeedbackRound(input: {
  choice?: FeedbackChoice;
  codeHost: CodeHost;
  note: string | null;
  // The pull request recorded for the ticket, if any.
  pullRequestUrl: string | null;
  snapshot: FactorySnapshot;
}): PreparedRound | FeedbackRefusal {
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
  const read = readFeedback(
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
  const items = roundItems(chosen.items, input.note);
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
