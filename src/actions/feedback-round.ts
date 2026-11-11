import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FactorySnapshot, FeedbackRound } from '../domain.ts';
import type { CodeHost } from '../ports/code-host.ts';
import {
  feedbackRoundRefusal,
  feedbackRounds,
  feedbackTaskFile,
  renderFeedbackTask,
  roundItems,
  roundRecord,
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

function readFeedback(codeHost: CodeHost, url: string) {
  try {
    const pullRequest = codeHost.pullRequest(url);
    if (pullRequest === null || pullRequest.state !== 'open') {
      return refuse(`${url} is ${pullRequest?.state ?? 'gone'}, not open.`);
    }
    return { feedback: codeHost.pullRequestFeedback(pullRequest), pullRequest };
  } catch (error: unknown) {
    const failed: FeedbackRefusal = {
      message: `Cannot read ${url}: ${error instanceof Error ? error.message : String(error)}`,
      reason: 'code_host_unavailable',
    };
    return failed;
  }
}

export function prepareFeedbackRound(input: {
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
  const read = readFeedback(input.codeHost, input.pullRequestUrl);
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
  const items = roundItems(feedback, input.note);
  if (items.length === 0) {
    const skipped =
      feedback.skipped.length === 0
        ? ''
        : ` (${feedback.skipped.length} skipped: not from collaborators or codeHost.feedback.authors)`;
    const truncated = feedback.truncated
      ? ' GitHub had more than one page, so only the newest 100 of each list were read.'
      : '';
    return refuse(
      `No new feedback on ${input.pullRequestUrl} since the last push${skipped}.${truncated} Add a note to start a round anyway.`,
    );
  }
  const round = feedbackRounds(input.snapshot.tasks) + 1;
  return {
    feedback: roundRecord({ feedback, items, pullRequestUrl: input.pullRequestUrl, round }),
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
