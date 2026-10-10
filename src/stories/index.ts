import { component as agentsView } from '../extension/agents-view.stories.ts';
import { component as statusMessage } from '../extension/status-message.stories.ts';
import { component as ticketView } from '../extension/ticket-view.stories.ts';
import { component as widget } from '../extension/widget.stories.ts';
import type { Component } from './story.ts';

export const components: Array<Component> = [statusMessage, widget, ticketView, agentsView];

export function componentById(id: string): Component | null {
  return components.find((item) => item.id === id) ?? null;
}
