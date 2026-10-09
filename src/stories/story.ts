import type { AgentsViewTheme } from '../extension/agents-view.ts';
import type { StatusTheme } from '../extension/status-message.ts';
import type { AgentTheme } from '../extension/widget.ts';

// Every component theme is a slice of Pi's Theme, so one value serves all.
export type GalleryTheme = AgentsViewTheme & AgentTheme & StatusTheme;

export type View = { theme: GalleryTheme; width: number };

// A scenario: one state of a component. `args` is the component's input as
// plain JSON, so the gallery can show it, edit it, and render it again.
export type Story = {
  args: () => unknown;
  description: string;
  name: string;
  render: (args: unknown, view: View) => Array<string>;
};

export type Component = {
  description: string;
  id: string;
  name: string;
  stories: Array<Story>;
};

export function story<Args>(input: {
  args: () => Args;
  description: string;
  name: string;
  render: (args: Args, view: View) => Array<string>;
}): Story {
  return {
    args: input.args,
    description: input.description,
    name: input.name,
    // Edited args are only as well-formed as the person who typed them; a
    // render that throws is reported in the gallery.
    render: (args, view) => input.render(args as Args, view),
  };
}

export function renderDefault(value: Story, view: View): Array<string> {
  return value.render(value.args(), view);
}

export const WIDTHS = [40, 60, 80, 120] as const;

// No colours, for snapshots and width checks.
export const plainTheme: GalleryTheme = {
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

export function slug(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}
