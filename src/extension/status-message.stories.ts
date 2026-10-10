import { decodeCard, encodeCard, type FactoryCard } from '../controller/card.ts';
import { detail } from '../controller/reduce.ts';
import { attentionCard, finishedRunCard } from '../controller/run-card.ts';
import { terminalSummary } from '../controller/service.ts';
import { formatStatus } from '../controller/store.ts';
import { terminalOf } from '../stories/fixtures.ts';
import {
  approvedNext,
  askingUser,
  blockedVerdict,
  changesRequested,
  completed,
  correctionLimit,
  crashedRetry,
  diffKeepsChanging,
  handoffReady,
  malformed,
  planReady,
  planRunning,
  readyForReview,
  roundLimit,
  staleDiff,
  workChecksFailed,
  wrapupCorrecting,
  wrapupQuestion,
  wrapupRunning,
  type Scenario,
} from '../stories/scenarios.ts';
import { story, type Component } from '../stories/story.ts';
import { renderFactoryStatus } from './status-message.ts';

type Args = { card: FactoryCard; expanded: boolean };

// The card Pi shows when a run finishes, built the way the service builds it.
function finished(scenario: Scenario): string {
  const { run, snapshot } = scenario;
  if (run === null) {
    throw new Error('scenario has no run');
  }
  const terminal = terminalOf(run, scenario.question);
  return finishedRunCard(snapshot, run, terminalSummary(snapshot, run.id, terminal));
}

function attention(scenario: Scenario): string {
  return attentionCard(scenario.snapshot, scenario.question ?? '');
}

function card(name: string, description: string, text: () => string, expanded = false) {
  return story<Args>({
    args: () => ({ card: decodeCard(text()), expanded }),
    description,
    name,
    render: (args, { theme, width }) =>
      renderFactoryStatus({ expanded: args.expanded, text: encodeCard(args.card), theme, width }),
  });
}

export const component: Component = {
  description:
    'Non-blocking feedback in the conversation. Each card says what the latest run or command led to: the ticket, the stage, the outcome, the task and round, and the command to run when the ticket waits on you.',
  id: 'status-message',
  name: 'Status Message',
  stories: [
    card(
      'plan ready: 6 tasks with dependencies',
      'Planning finished. The card lists every task with its dependencies and the tasks ready to start.',
      () => finished(planReady()),
    ),
    card(
      'plan ready: long titles',
      'The same plan with long task titles, to check wrapping at narrow widths.',
      () => finished(planReady(true)),
    ),
    card(
      'task 03/06 ready for review',
      'The worker finished task 03 and work validation passed. A reviewer is starting.',
      () => finished(readyForReview()),
    ),
    card(
      'task 03/06 approved; next task queued',
      'The reviewer approved task 03 in round 1. Task 04 is next.',
      () => finished(approvedNext()),
    ),
    card(
      'task 03/06 approved, expanded',
      'The approval card after the user expands it.',
      () => finished(approvedNext()),
      true,
    ),
    card(
      'changes requested, round 2 of 3',
      'Round 2 found blocking problems. They are listed under the card and go back to the worker.',
      () => finished(changesRequested()),
    ),
    card(
      'review round limit reached',
      'Round 3 of 3 still has blocking findings, so the ticket pauses on this review.',
      () => finished(roundLimit()),
    ),
    card(
      'review round limit notice',
      'The notice that follows the round limit, asking the user how to settle the findings.',
      () => attention(roundLimit()),
    ),
    card(
      'reviewer blocked the task',
      'The reviewer cannot judge the work and returns `blocked`.',
      () => finished(blockedVerdict()),
    ),
    card('reviewer blocked notice', 'The notice that follows a blocked verdict.', () =>
      attention(blockedVerdict()),
    ),
    card(
      'malformed review; correcting',
      'The review could not be parsed. The reviewer is resumed with the parse errors.',
      () => finished(malformed()),
    ),
    card(
      'review correction limit reached',
      'The reviewer kept returning unparseable results; the ticket pauses.',
      () => attention(correctionLimit()),
    ),
    card(
      'diff changed during review',
      'The worktree changed while the reviewer read it, so the verdict is not used and the work is validated again.',
      () => finished(staleDiff()),
    ),
    card(
      'diff keeps changing; paused',
      'The worktree changed again in the same round. The user must ignore generated files and retry.',
      () => attention(diffKeepsChanging()),
    ),
    card(
      'work checks failed; correcting',
      'A validation command failed. The worker is resumed with the failure.',
      () => finished(workChecksFailed()),
    ),
    card(
      'worker asks a question',
      'The worker called `caller_ping`. The ticket waits for `/factory reply`.',
      () => attention(askingUser()),
    ),
    card(
      'reviewer crashed; retrying',
      'The reviewer pane died. The controller relaunches it without spending a round.',
      () => finished(crashedRetry()),
    ),
    card(
      'last task approved; wrap-up running',
      'Task 06 is approved, every task is done, and wrap-up starts.',
      () => finished(wrapupRunning()),
    ),
    card(
      'wrap-up failed validation; correcting',
      'The handoff missed a changed path and the agent touched product code. The same wrap-up session is resumed with the failures; there is no correction limit.',
      () => finished(wrapupCorrecting()),
    ),
    card(
      'wrap-up asks a question',
      'The wrap-up agent called `caller_ping`; `/factory reply` resumes the same session.',
      () => attention(wrapupQuestion()),
    ),
    card('handoff passed validation', 'The run card when wrap-up validation passes.', () =>
      finished(handoffReady()),
    ),
    card(
      'ready for handoff notice',
      'The handoff notice: both panes are open, the all-stage usage table, and the command that completes the ticket.',
      () => attention(handoffReady()),
    ),
    card('/factory complete', 'The reply after the human completes the handoff.', () =>
      formatStatus(detail(completed().snapshot, 'dpaez/factory-dashboard#11 is complete.')),
    ),
    card('/factory status while reviewing', 'The reply to `/factory status` during a review.', () =>
      formatStatus(detail(readyForReview().snapshot, 'Launched 👀 dpaez/factory-dashboard#11.')),
    ),
    card(
      '/factory status while planning',
      'The reply to `/factory status` before any task exists.',
      () => formatStatus(detail(planRunning().snapshot, 'Launched 🗺 dpaez/factory-dashboard#11.')),
    ),
    card(
      'plain message without a card',
      'A command reply that is not about a ticket, such as an unknown ticket ref.',
      () => 'No factory execution matches proj-404.',
    ),
  ],
};
