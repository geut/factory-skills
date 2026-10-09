import { ticketProgress, type TicketProgress } from '../controller/progress.ts';
import type { FactorySnapshot } from '../domain.ts';
import { stageEmoji } from '../runtime/policy.ts';
import { child, NOW } from '../stories/fixtures.ts';
import {
  approvedNext,
  askingUser,
  changesRequested,
  diffKeepsChanging,
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
  tickets: Array<TicketProgress>;
};

function widget(
  name: string,
  description: string,
  build: () => { children: Array<WidgetChild>; tickets: Array<FactorySnapshot> },
) {
  return story<Args>({
    args: () => {
      const { children, tickets } = build();
      return {
        children,
        frame: 0,
        now: new Date(NOW).toISOString(),
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
        theme,
        tickets: args.tickets,
        width,
      }),
  });
}

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
      'two tickets, three children',
      'Three tickets and three children: the widget caps both lists and points at /factory agents.',
      () => {
        const first = working();
        const other = otherTicket();
        const reviewer = other.runs.at(-1);
        const children = running(first);
        if (reviewer !== undefined) {
          children.push(child(other, reviewer), child(other, reviewer, { paneName: `${stageEmoji.plan} proj-9` }));
        }
        return { children, tickets: [first.snapshot, other, planRunning().snapshot] };
      },
    ),
    widget('nothing in progress', 'No ticket and no child: the widget is hidden.', () => ({
      children: [],
      tickets: [],
    })),
  ],
};
