import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { FactorySnapshot } from '../domain.ts';
import type { CodeHost } from '../ports/code-host.ts';
import {
  feedbackRounds,
  feedbackTaskFile,
  renderFeedbackTask,
  roundItems,
} from '../stages/feedback.ts';
import { stageEnabled } from '../stages/flow.ts';

// Prepares a feedback round on a ticket's open pull request: reads the
// feedback posted since the factory's last push, writes the round's task file,
// and says what the `feedback` event carries. Nothing in the controller changes
// here, so a refusal leaves the ticket as it was.

export type FeedbackRound = {
  items: number;
  round: number;
  skipped: number;
  startHead: string;
  taskFile: string;
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

export function prepareFeedbackRound(input: {
  codeHost: CodeHost;
  note: string | null;
  // The pull request recorded at handoff, and when the ticket last got there.
  pullRequestUrl: string | null;
  since: string | null;
  snapshot: FactorySnapshot;
}): FeedbackRound | FeedbackRefusal {
  const { execution, ticket } = input.snapshot;
  const ref = ticket.displayRef;
  if (execution.status !== 'ready_for_handoff') {
    return refuse(`${ref} is ${execution.stage}/${execution.status}, not ready for handoff.`);
  }
  const rounds = feedbackRounds(input.snapshot.tasks);
  if (rounds >= execution.policy.limits.feedbackRounds) {
    return refuse(
      `${ref} has had ${rounds} feedback round${rounds === 1 ? '' : 's'}, the limit (limits.feedbackRounds).`,
    );
  }
  if (input.pullRequestUrl === null) {
    return refuse(`${ref} has no pull request to take feedback from.`);
  }
  const worktree = execution.worktreePath;
  const head = worktree === null ? null : headOf(worktree);
  if (worktree === null || head === null) {
    return refuse(`${ref} has no worktree to work in.`);
  }
  let pullRequest;
  let feedback;
  try {
    pullRequest = input.codeHost.pullRequest(input.pullRequestUrl);
    feedback =
      pullRequest === null || pullRequest.state !== 'open'
        ? null
        : input.codeHost.pullRequestFeedback(
            pullRequest,
            input.since ?? pullRequest.openedAt ?? '',
          );
  } catch (error: unknown) {
    return {
      message: `Cannot read ${input.pullRequestUrl}: ${error instanceof Error ? error.message : String(error)}`,
      reason: 'code_host_unavailable',
    };
  }
  if (pullRequest === null || pullRequest.state !== 'open') {
    return refuse(`${input.pullRequestUrl} is ${pullRequest?.state ?? 'gone'}, not open.`);
  }
  // The round commits on top of what the pull request shows; a commit pushed
  // there from elsewhere would make wrap-up's push fail.
  if (pullRequest.headSha !== null && pullRequest.headSha !== head) {
    return refuse(
      `${input.pullRequestUrl} is at ${pullRequest.headSha.slice(0, 7)}, the worktree at ${head.slice(0, 7)}. Bring the worktree to the pull request's head first.`,
    );
  }
  const items = roundItems(feedback ?? { items: [], skipped: [], truncated: false }, input.note);
  if (items.length === 0 || feedback === null) {
    const skipped = feedback?.skipped.length ?? 0;
    return refuse(
      `No new feedback on ${input.pullRequestUrl} since the last push${skipped === 0 ? '' : ` (${skipped} skipped: not from collaborators or codeHost.feedback.authors)`}. Add a note to start a round anyway.`,
    );
  }
  const round = rounds + 1;
  const taskFile = feedbackTaskFile(round);
  const file = path.join(execution.factoryDir, taskFile);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    renderFeedbackTask({
      feedback,
      items,
      pullRequestUrl: input.pullRequestUrl,
      qa: stageEnabled(execution.policy, 'qa'),
      round,
    }),
  );
  return {
    items: items.length,
    round,
    skipped: feedback.skipped.length,
    startHead: head,
    taskFile,
    title: `Feedback round ${round}`,
  };
}
