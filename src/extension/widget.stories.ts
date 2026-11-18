import { ticketProgress, type TicketProgress } from '../controller/progress.ts';
import { controllerStep, type TicketStep } from '../controller/steps.ts';
import { actionId, type ActionRecord, type FactorySnapshot } from '../domain.ts';
import { stages } from '../stages/index.ts';
import { blank, child, NOW } from '../stories/fixtures.ts';
import {
  approvedNext,
  askingUser,
  changesRequested,
  diffKeepsChanging,
  feedbackRoundWorking,
  handoffReady,
  otherTicket,
  planRunning,
  readyForReview,
  roundLimit,
  working,
  wrapupRunning,
  type Scenario,
} from '../stories/scenarios.ts';
import { story, type Component } from '../stories/story.ts';
import { renderFactoryWidget, type WidgetChild } from './widget.ts';

// `now` is an ISO time, so elapsed times can be edited as text.
type Args = {
  children: Array<WidgetChild>;
  frame: number;
  now: string;
  steps: Array<TicketStep>;
  tickets: Array<TicketProgress>;
};

function widget(
  name: string,
  description: string,
  build: () => {
    children: Array<WidgetChild>;
    steps?: Array<TicketStep>;
    tickets: Array<FactorySnapshot>;
  },
) {
  return story<Args>({
    args: () => {
      const { children, steps, tickets } = build();
      return {
        children,
        frame: 0,
        now: new Date(NOW).toISOString(),
        steps: steps ?? [],
        tickets: tickets.map((snapshot) => ticketProgress(snapshot)),
      };
    },
    description,
    name,
    render: (args, { theme, width }) =>
      renderFactoryWidget({
        children: args.children,
        frame: args.frame,
        now: Date.parse(args.now),
        steps: args.steps,
        theme,
        tickets: args.tickets,
        width,
      }),
  });
}

// The ticket's controller step once `action` is running, or queued, since
// `secondsAgo`.
function stepOf(
  snapshot: FactorySnapshot,
  action: ActionRecord,
  secondsAgo: number,
): Array<TicketStep> {
  snapshot.actions.push(action);
  const since = new Date(NOW - secondsAgo * 1000).toISOString();
  const step = controllerStep(
    snapshot,
    new Map([[action.id, { createdAt: since, updatedAt: since }]]),
  );
  return step === null ? [] : [{ displayRef: snapshot.ticket.displayRef, step, ticket: 'demo' }];
}

const actionBase = {
  attempts: 0,
  attentionReplyId: null,
  attentionRequestId: null,
  idempotencyKey: 'story',
  lastError: null,
  maxAttempts: 3,
  retryOfActionId: null,
} as const;

function running(scenario: Scenario): Array<WidgetChild> {
  return scenario.run === null ? [] : [child(scenario.snapshot, scenario.run)];
}

function latest(scenario: Scenario): Array<WidgetChild> {
  const last = scenario.snapshot.runs.at(-1);
  return last === undefined ? [] : [child(scenario.snapshot, last)];
}

export const component: Component = {
  description:
    'Live status above the editor. It keeps every unfinished ticket’s progress on screen between runs and shows the subagents running now, with their activity, tool uses, and context.',
  id: 'widget',
  name: 'Widget',
  stories: [
    widget(
      'plan running, no tasks yet',
      'The planner is running; the ticket has no tasks yet.',
      () => {
        const scenario = planRunning();
        return { children: running(scenario), tickets: [scenario.snapshot] };
      },
    ),
    widget('task 03/06 working, round 1', 'A worker is on task 03, before any review.', () => {
      const scenario = working();
      return { children: running(scenario), tickets: [scenario.snapshot] };
    }),
    widget('task 03/06 in review', 'The reviewer is reading task 03 in round 1.', () => {
      const scenario = readyForReview();
      return { children: latest(scenario), tickets: [scenario.snapshot] };
    }),
    widget(
      'between runs: approved, next task queued',
      'No child is running. The progress line stays, showing task 04 next.',
      () => ({ children: [], tickets: [approvedNext().snapshot] }),
    ),
    widget(
      'fixing round 2 findings',
      'The worker is fixing the blocking findings from review round 2.',
      () => {
        const scenario = changesRequested();
        return { children: latest(scenario), tickets: [scenario.snapshot] };
      },
    ),
    widget(
      'paused at the review round limit',
      'The ticket waits on the user, who must reply to settle the findings.',
      () => ({ children: [], tickets: [roundLimit().snapshot] }),
    ),
    widget('waiting for an answer', 'The worker asked a question.', () => ({
      children: [],
      tickets: [askingUser().snapshot],
    })),
    widget(
      'diff keeps changing; retry',
      'The ticket paused because the worktree kept changing; the user must retry.',
      () => ({ children: [], tickets: [diffKeepsChanging().snapshot] }),
    ),
    widget('wrap-up running', 'Every task is done and the wrap-up agent is running.', () => {
      const scenario = wrapupRunning();
      return { children: latest(scenario), tickets: [scenario.snapshot] };
    }),
    widget(
      'ready for handoff',
      'Wrap-up passed. The ticket waits for the human to merge and run /factory complete.',
      () => ({ children: [], tickets: [handoffReady().snapshot] }),
    ),
    widget(
      'feedback round in work',
      'A feedback round took the ticket back to work. The task line names the round, its item count, and the first item, cut to the width.',
      () => {
        const scenario = feedbackRoundWorking();
        return { children: running(scenario), tickets: [scenario.snapshot] };
      },
    ),
    widget(
      'two tickets, three children',
      'Three tickets and three children: the widget caps both lists and points at /factory agents.',
      () => {
        const first = working();
        const other = otherTicket();
        const reviewer = other.runs.at(-1);
        const children = running(first);
        if (reviewer !== undefined) {
          children.push(
            child(other, reviewer),
            child(other, reviewer, { paneName: `${stages.plan.emoji} proj-9` }),
          );
        }
        return { children, tickets: [first.snapshot, other, planRunning().snapshot] };
      },
    ),
    widget(
      'between agents: validating a review',
      'No agent runs: the controller is validating task 03’s review, 41 seconds in. The step line, under its ticket, keeps the gap from looking idle.',
      () => {
        const { snapshot } = approvedNext();
        const last = snapshot.runs.at(-1);
        return {
          children: [],
          steps:
            last === undefined
              ? []
              : stepOf(
                  snapshot,
                  {
                    ...actionBase,
                    id: actionId('step-1'),
                    kind: 'validate_run',
                    runId: last.id,
                    status: 'leased',
                  },
                  41,
                ),
          tickets: [snapshot],
        };
      },
    ),
    widget(
      'between agents: preparing the worktree',
      'A new ticket: the controller is preparing its worktree, setup included, before the planner starts.',
      () => {
        const snapshot = blank({
          displayRef: 'geut/factory-skills#42',
          title: 'Remember the filter',
        });
        return {
          children: [],
          steps: stepOf(
            snapshot,
            {
              ...actionBase,
              id: actionId('step-1'),
              kind: 'prepare_worktree',
              runId: null,
              slug: 'demo',
              status: 'leased',
            },
            125,
          ),
          tickets: [snapshot],
        };
      },
    ),
    widget(
      'a step queued',
      'The controller is busy with another ticket; this ticket’s next action, opening its handoff panes, waits its turn, dimmed.',
      () => {
        const { snapshot } = handoffReady();
        return {
          children: [],
          steps: stepOf(
            snapshot,
            {
              ...actionBase,
              checklist: [],
              comment: 'Done.',
              commentKey: null,
              id: actionId('step-1'),
              issueStatus: 'in_review',
              kind: 'update_ticket_source',
              runId: null,
              status: 'pending',
              update: 'handoff',
            },
            3,
          ),
          tickets: [snapshot],
        };
      },
    ),
    widget(
      'two tickets: an agent on one, a controller step on the other',
      'A worker runs on the first ticket while the controller validates the other’s review; each shows under its own ticket.',
      () => {
        const first = working();
        const other = otherTicket();
        const reviewer = other.runs.at(-1);
        return {
          children: running(first),
          steps:
            reviewer === undefined
              ? []
              : stepOf(
                  other,
                  {
                    ...actionBase,
                    id: actionId('step-2'),
                    kind: 'validate_run',
                    runId: reviewer.id,
                    status: 'leased',
                  },
                  12,
                ),
          tickets: [first.snapshot, other],
        };
      },
    ),
    widget('nothing in progress', 'No ticket and no child: the widget is hidden.', () => ({
      children: [],
      tickets: [],
    })),
  ],
};
