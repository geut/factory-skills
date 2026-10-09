import { child, NOW } from '../stories/fixtures.ts';
import { otherTicket, planRunning, working } from '../stories/scenarios.ts';
import { story, type Component } from '../stories/story.ts';
import { renderFactoryAgents } from './agents-view.ts';
import type { WidgetChild } from './widget.ts';

type Args = { children: Array<WidgetChild>; height: number; now: string; selected: number };

function view(name: string, description: string, children: () => Array<WidgetChild>, selected = 0) {
  return story<Args>({
    args: () => ({ children: children(), height: 18, now: new Date(NOW).toISOString(), selected }),
    description,
    name,
    render: (args, { theme, width }) =>
      renderFactoryAgents({ ...args, now: Date.parse(args.now), theme, width }),
  });
}

export const component: Component = {
  description:
    'Fullscreen list of every running subagent (`/factory agents` or Alt+S), across tickets: pane name, task, activity, elapsed time, tool uses, context, and session file.',
  id: 'agents-view',
  name: 'Agents View',
  stories: [
    view('no agents running', 'Nothing is running.', () => []),
    view('one worker on task 03/06', 'A single worker on task 03.', () => {
      const scenario = working();
      return scenario.run === null ? [] : [child(scenario.snapshot, scenario.run)];
    }),
    view(
      'worker and reviewer, reviewer selected',
      'Two tickets at once; the second row is selected and has no context reading yet.',
      () => {
        const first = working();
        const other = otherTicket();
        const reviewer = other.runs.at(-1);
        return [
          ...(first.run === null ? [] : [child(first.snapshot, first.run)]),
          ...(reviewer === undefined
            ? []
            : [child(other, reviewer, { context: null, toolUses: 0 })]),
        ];
      },
      1,
    ),
    view(
      'plan child without a task',
      'A planner has no task, so the row shows the ticket title instead.',
      () => {
        const scenario = planRunning();
        return scenario.run === null ? [] : [child(scenario.snapshot, scenario.run)];
      },
    ),
  ],
};
