import { ticketDetailOf, type TicketDetail } from '../controller/view.ts';
import {
  askingUser,
  handoffReady,
  planRunning,
  readyForReview,
  roundLimit,
  type Scenario,
} from '../stories/scenarios.ts';
import { story, type Component } from '../stories/story.ts';
import { renderTicketDetail } from './ticket-view.ts';

type Args = {
  detail: TicketDetail;
  height: number;
  message: string;
  scroll: number;
  selected: number;
};

function view(
  name: string,
  description: string,
  scenario: () => Scenario,
  message: string,
  selected = 0,
) {
  return story<Args>({
    args: () => ({
      detail: ticketDetailOf(scenario().snapshot),
      height: 24,
      message,
      scroll: 0,
      selected,
    }),
    description,
    name,
    render: (args, { theme, width }) => renderTicketDetail({ ...args, theme, width }),
  });
}

export const component: Component = {
  description:
    'Fullscreen detail for one ticket (`/factory ticket`). The header shows progress and the current task; below it, every run in start order with its outcome, and the selected run’s full message.',
  id: 'ticket-view',
  name: 'Ticket View',
  stories: [
    view(
      'task 03/06 in review',
      'Two tasks done; the reviewer is on task 03. The worker’s message for task 03 is selected.',
      readyForReview,
      'All checks green. The overview page renders from the v2 read module.',
      5,
    ),
    view(
      'round limit with findings',
      'Task 03 went through three review rounds and paused. Only the last review reads as paused.',
      roundLimit,
      '## Verdict\n\nchanges_requested\n\n## Summary\n\nTwo blocking problems remain in the error path.',
      10,
    ),
    view(
      'worker asks a question',
      'The worker asked a question; the header names the reply command.',
      askingUser,
      'Should the overview hide done tickets?',
      6,
    ),
    view(
      'ready for handoff',
      'Every task approved and the handoff validated; the last run reads ready for handoff.',
      handoffReady,
      '## Outcome\n\nThe dashboard reads the factory schema v2 database, read-only.',
      13,
    ),
    view(
      'plan running',
      'The planner is running, so there are no tasks yet.',
      planRunning,
      'This run has no message yet.',
    ),
    story<Args>({
      args: () => ({
        detail: { displayRef: 'factory', progress: null, runs: [] },
        height: 24,
        message: 'This ticket is no longer current.',
        scroll: 0,
        selected: 0,
      }),
      description: 'The ticket was superseded while the view was open.',
      name: 'ticket is no longer current',
      render: (args, { theme, width }) => renderTicketDetail({ ...args, theme, width }),
    }),
  ],
};
