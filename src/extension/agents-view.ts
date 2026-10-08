import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import { childProgress, formatElapsed, type WidgetChild } from './widget.ts';

export type AgentsViewTheme = {
  bg: (color: 'selectedBg', text: string) => string;
  bold: (text: string) => string;
  fg: (color: 'accent' | 'dim' | 'muted' | 'text', text: string) => string;
};

function fitLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width));
  const gap = Math.max(0, width - visibleWidth(clipped));
  return gap === 0 ? clipped : `${clipped}${' '.repeat(gap)}`;
}

function childRows(
  child: WidgetChild,
  now: number,
  theme: AgentsViewTheme,
  width: number,
): Array<string> {
  const details = [child.activity, formatElapsed(child.startedAt, now)];
  if (child.toolUses > 0) {
    details.push(`${child.toolUses} tool use${child.toolUses === 1 ? '' : 's'}`);
  }
  if (child.context !== null) {
    details.push(child.context);
  }
  const progress = childProgress(child);
  if (progress !== null) {
    details.push(progress);
  }
  const rows = [`  ${theme.bold(child.paneName ?? 'factory')}`];
  if (progress === null) {
    rows.push(`    ${theme.fg('muted', child.description ?? 'No description')}`);
  }
  rows.push(`    ${theme.fg('dim', details.join(' · '))}`);
  if (child.sessionFile !== null) {
    rows.push(`    ${theme.fg('dim', child.sessionFile)}`);
  }
  return rows.map((row) => fitLine(row, width));
}

export function renderFactoryAgents(input: {
  children: Array<WidgetChild>;
  height: number;
  now: number;
  selected: number;
  theme: AgentsViewTheme;
  width: number;
}): Array<string> {
  const { height, theme, width } = input;
  const rule = fitLine(theme.fg('accent', '─'.repeat(Math.max(1, width))), width);
  const header = [
    rule,
    fitLine(` ${theme.bold(theme.fg('accent', 'Factory agents'))}`, width),
    fitLine('', width),
  ];
  const footer = [
    fitLine('', width),
    fitLine(
      ` ${theme.fg('dim', '↑↓ navigate')}  ${theme.fg('dim', 'q close')}  ${theme.fg('dim', 'esc close')}`,
      width,
    ),
    rule,
  ];
  const bodyBudget = Math.max(1, height - header.length - footer.length);
  const body: Array<string> = [];
  if (input.children.length === 0) {
    body.push(
      fitLine(`  ${theme.fg('text', 'No factory agents are running.')}`, width),
      fitLine(
        `  ${theme.fg('muted', 'A plan, work, review, or wrap-up child will show up here.')}`,
        width,
      ),
    );
  } else {
    input.children.forEach((child, index) => {
      const rows = childRows(child, input.now, theme, width);
      const selected = index === input.selected;
      for (const row of rows) {
        body.push(selected ? theme.bg('selectedBg', row) : row);
      }
      body.push(fitLine('', width));
    });
  }
  const visible = body.slice(0, bodyBudget);
  while (visible.length < bodyBudget) {
    visible.push(fitLine('', width));
  }
  return [...header, ...visible, ...footer];
}

export class FactoryAgentsView implements Component {
  private selected = 0;
  private readonly children: () => Array<WidgetChild>;
  private readonly closeView: () => void;
  private readonly theme: AgentsViewTheme;
  private readonly tui: TUI;

  constructor(
    children: () => Array<WidgetChild>,
    theme: AgentsViewTheme,
    tui: TUI,
    closeView: () => void,
  ) {
    this.children = children;
    this.closeView = closeView;
    this.theme = theme;
    this.tui = tui;
  }

  invalidate(): void {
    return undefined;
  }

  handleInput(data: string): void {
    if (data === 'q' || matchesKey(data, 'q') || matchesKey(data, 'escape')) {
      this.closeView();
      return;
    }
    const count = this.children().length;
    if (count === 0) {
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.selected = (this.selected - 1 + count) % count;
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.selected = (this.selected + 1) % count;
    }
  }

  render(width: number): Array<string> {
    const rows = this.tui.terminal.rows;
    return renderFactoryAgents({
      children: this.children(),
      height: Math.max(12, rows),
      now: Date.now(),
      selected: this.selected,
      theme: this.theme,
      width,
    });
  }
}
