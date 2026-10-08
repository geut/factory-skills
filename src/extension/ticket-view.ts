import { readFileSync } from 'node:fs';
import {
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type TUI,
} from '@earendil-works/pi-tui';
import type { TicketDetail, TicketRunRow } from '../controller/service.ts';
import { runAssistantText } from '../runtime/session-activity.ts';
import type { AgentsViewTheme } from './agents-view.ts';

function fitLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width));
  const gap = Math.max(0, width - visibleWidth(clipped));
  return gap === 0 ? clipped : `${clipped}${' '.repeat(gap)}`;
}

export function runMessage(run: TicketRunRow | undefined): string {
  if (run === undefined || run.sessionFile === null) {
    return 'This run has no message yet.';
  }
  try {
    const text = runAssistantText(readFileSync(run.sessionFile, 'utf8'), run.runId);
    return text.length > 0 ? text : 'This run has no message yet.';
  } catch {
    return 'This run has no message yet.';
  }
}

export function renderTicketDetail(input: {
  detail: TicketDetail;
  height: number;
  message: string;
  scroll: number;
  selected: number;
  theme: AgentsViewTheme;
  width: number;
}): Array<string> {
  const { detail, height, theme, width } = input;
  const rule = fitLine(theme.fg('accent', '─'.repeat(Math.max(1, width))), width);
  const header = [
    rule,
    fitLine(` ${theme.bold(theme.fg('accent', detail.displayRef))}`, width),
    fitLine('', width),
  ];
  const footer = [
    fitLine('', width),
    fitLine(
      ` ${theme.fg('dim', '↑↓ run')}  ${theme.fg('dim', 'pgup/pgdn message')}  ${theme.fg('dim', 'q close')}`,
      width,
    ),
    rule,
  ];
  const bodyBudget = Math.max(1, height - header.length - footer.length);
  const runRows =
    detail.runs.length === 0
      ? [fitLine(`  ${theme.fg('text', 'This ticket has no runs yet.')}`, width)]
      : detail.runs.map((run, index) => {
          const row = fitLine(`  ${run.label}`, width);
          return index === input.selected ? theme.bg('selectedBg', row) : row;
        });
  const messageRows = wrapTextWithAnsi(input.message, Math.max(1, width - 2)).map((row) =>
    fitLine(`  ${row}`, width),
  );
  const room = Math.max(1, bodyBudget - runRows.length - 1);
  const scroll = Math.max(0, Math.min(input.scroll, Math.max(0, messageRows.length - room)));
  const visibleMessage = messageRows.slice(scroll, scroll + room);
  const body = [...runRows, fitLine('', width), ...visibleMessage];
  while (body.length < bodyBudget) {
    body.push(fitLine('', width));
  }
  return [...header, ...body.slice(0, bodyBudget), ...footer];
}

export class FactoryTicketView implements Component {
  private scroll = 0;
  private selected = 0;
  private readonly closeView: () => void;
  private readonly load: () => TicketDetail | null;
  private readonly theme: AgentsViewTheme;
  private readonly tui: TUI;

  constructor(
    load: () => TicketDetail | null,
    theme: AgentsViewTheme,
    tui: TUI,
    closeView: () => void,
  ) {
    this.closeView = closeView;
    this.load = load;
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
    const detail = this.load();
    const count = detail?.runs.length ?? 0;
    if (detail === null || count === 0) {
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.selected = (this.selected - 1 + count) % count;
      this.scroll = 0;
      return;
    }
    if (matchesKey(data, 'down') || data === 'j') {
      this.selected = (this.selected + 1) % count;
      this.scroll = 0;
      return;
    }
    const page = Math.max(1, this.tui.terminal.rows - count - 8);
    if (matchesKey(data, 'pageDown')) {
      this.scroll += page;
    } else if (matchesKey(data, 'pageUp')) {
      this.scroll = Math.max(0, this.scroll - page);
    }
  }

  render(width: number): Array<string> {
    const detail = this.load();
    const height = Math.max(12, this.tui.terminal.rows);
    if (detail === null) {
      return renderTicketDetail({
        detail: { displayRef: 'factory', runs: [] },
        height,
        message: 'This ticket is no longer current.',
        scroll: 0,
        selected: 0,
        theme: this.theme,
        width,
      });
    }
    const selected = Math.min(this.selected, Math.max(0, detail.runs.length - 1));
    this.selected = selected;
    return renderTicketDetail({
      detail,
      height,
      message: runMessage(detail.runs[selected]),
      scroll: this.scroll,
      selected,
      theme: this.theme,
      width,
    });
  }
}
