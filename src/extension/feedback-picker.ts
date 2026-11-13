import {
  getCapabilities,
  hyperlink,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';
import type { FeedbackCandidate } from '../stages/feedback.ts';
import type { AgentsViewTheme } from './agents-view.ts';

// The picker for a feedback round (`/factory feedback <ticket> --list`): the
// pull request's pending comments in a scrolling window, each with a tick;
// enter starts a round on the ticked ones.

export type FeedbackPickerState = {
  candidates: Array<FeedbackCandidate>;
  cursor: number;
  displayRef: string;
  // A line under the list: why enter did nothing, or that a round is starting.
  message: string | null;
  // The note the command carried, added to the round as its own item.
  note: string | null;
  pullRequestUrl: string;
  // Comments read but left out: not from collaborators or listed authors.
  skipped: number;
  ticked: Array<string>;
  truncated: boolean;
};

// All the picker reads of Pi's TUI: the terminal's height.
type Rows = { terminal: { rows: number } };

// The most rows the list shows at once; a short terminal shows fewer.
const WINDOW = 8;

function fitLine(text: string, width: number): string {
  const clipped = truncateToWidth(text, Math.max(1, width));
  const gap = Math.max(0, width - visibleWidth(clipped));
  return gap === 0 ? clipped : `${clipped}${' '.repeat(gap)}`;
}

// The first row the window shows, keeping the cursor inside it.
function windowStart(input: { count: number; cursor: number; rows: number }): number {
  const last = Math.max(0, input.count - input.rows);
  return Math.max(0, Math.min(input.cursor - Math.floor(input.rows / 2), last));
}

// What enter starts: the ticked refs as `--only`, or every pending comment
// (no `only`) when all are ticked. Null when there is nothing to start.
export function pickedFeedback(
  state: Pick<FeedbackPickerState, 'candidates' | 'note' | 'ticked'>,
): { only: Array<string> | null } | null {
  const ticked = new Set(state.ticked);
  const only = state.candidates.map((item) => item.ref).filter((ref) => ticked.has(ref));
  if (only.length === state.candidates.length) {
    return only.length > 0 || state.note !== null ? { only: null } : null;
  }
  return only.length > 0 ? { only } : null;
}

// Makes text open a URL in terminals that follow OSC 8 links; plain text
// where the link would print as noise.
export type Link = (text: string, url: string) => string;

const plainLink: Link = (text) => text;

export function terminalLink(): Link {
  return getCapabilities().hyperlinks ? hyperlink : plainLink;
}

export function renderFeedbackPicker(
  input: FeedbackPickerState & {
    height: number;
    link?: Link;
    theme: AgentsViewTheme;
    width: number;
  },
): Array<string> {
  const link = input.link ?? plainLink;
  const { candidates, height, theme, width } = input;
  const rule = fitLine(theme.fg('accent', '─'.repeat(Math.max(1, width))), width);
  const ticked = new Set(input.ticked);
  const pending =
    candidates.length === 1 ? '1 pending comment' : `${candidates.length} pending comments`;
  const notes = [
    input.skipped > 0 ? `${input.skipped} skipped (not collaborators)` : null,
    input.truncated ? 'only the newest 100 read' : null,
  ].filter((text) => text !== null);
  const header = [
    rule,
    fitLine(
      ` ${theme.bold(theme.fg('accent', input.displayRef))} ${theme.fg('muted', `· feedback · ${pending}`)}`,
      width,
    ),
    fitLine(` ${theme.fg('dim', input.pullRequestUrl)}`, width),
    ...(notes.length === 0 ? [] : [fitLine(` ${theme.fg('dim', notes.join(' · '))}`, width)]),
    ...(input.note === null ? [] : [fitLine(` ${theme.fg('text', `Note: ${input.note}`)}`, width)]),
    fitLine('', width),
  ];
  const footer = [
    fitLine('', width),
    fitLine(
      ` ${theme.fg('dim', '↑↓ move')}  ${theme.fg('dim', 'space tick')}  ${theme.fg('dim', 'a all/none')}  ${theme.fg('dim', 'enter start round')}  ${theme.fg('dim', 'q close')}`,
      width,
    ),
    rule,
  ];
  const budget = Math.max(1, height - header.length - footer.length);
  const body: Array<string> = [];
  if (candidates.length === 0) {
    body.push(
      fitLine(
        `  ${theme.fg('text', 'No pending feedback: earlier rounds took or dismissed every comment.')}`,
        width,
      ),
    );
  } else {
    const cursor = Math.max(0, Math.min(input.cursor, candidates.length - 1));
    // Leave room for the position line, a gap, and three lines of detail.
    const rows = Math.max(1, Math.min(WINDOW, candidates.length, budget - 5));
    const start = windowStart({ count: candidates.length, cursor, rows });
    for (const [offset, item] of candidates.slice(start, start + rows).entries()) {
      const index = start + offset;
      const box = ticked.has(item.ref) ? theme.fg('success', '[x]') : theme.fg('dim', '[ ]');
      const place = item.location === null ? '' : ` · ${item.location}`;
      const row = fitLine(
        ` ${index === cursor ? '▶' : ' '} ${box} ${theme.fg('accent', item.url === null ? item.ref : link(item.ref, item.url))} ${theme.fg('muted', `${item.author}${place}`)} · ${item.summary}`,
        width,
      );
      body.push(index === cursor ? theme.bg('selectedBg', row) : row);
    }
    const count = `${ticked.size === 0 ? 'none' : candidates.filter((item) => ticked.has(item.ref)).length} ticked`;
    const shown =
      rows < candidates.length ? `${start + 1}–${start + rows} of ${candidates.length} · ` : '';
    body.push(fitLine(`   ${theme.fg('dim', `${shown}${count}`)}`, width), fitLine('', width));
    const selected = candidates[cursor];
    if (selected !== undefined) {
      const detail = [
        `${selected.kind} by ${selected.author}${selected.location === null ? '' : ` on ${selected.location}`}`,
        selected.summary,
        ...(selected.url === null ? [] : [link(selected.url, selected.url)]),
      ];
      for (const [index, text] of detail.entries()) {
        for (const line of wrapTextWithAnsi(text, Math.max(1, width - 4))) {
          body.push(
            fitLine(`  ${index === 1 ? theme.fg('text', line) : theme.fg('dim', line)}`, width),
          );
        }
      }
    }
  }
  if (input.message !== null) {
    // The message stays in view: it explains what the last key did.
    const message = wrapTextWithAnsi(input.message, Math.max(1, width - 4)).map((line) =>
      fitLine(`  ${theme.fg('warning', line)}`, width),
    );
    body.splice(Math.max(0, budget - message.length - 1), Infinity, fitLine('', width), ...message);
  }
  while (body.length < budget) {
    body.push(fitLine('', width));
  }
  return [...header, ...body.slice(0, budget), ...footer];
}

export class FactoryFeedbackPicker implements Component {
  private state: FeedbackPickerState;
  private started = false;
  private readonly closeView: () => void;
  private readonly start: (choice: { only: Array<string> | null }) => void;
  private readonly theme: AgentsViewTheme;
  private readonly tui: Rows;

  constructor(input: {
    closeView: () => void;
    start: (choice: { only: Array<string> | null }) => void;
    state: Omit<FeedbackPickerState, 'cursor' | 'message' | 'ticked'>;
    theme: AgentsViewTheme;
    tui: Rows;
  }) {
    this.closeView = input.closeView;
    this.start = input.start;
    this.theme = input.theme;
    this.tui = input.tui;
    // Every comment starts ticked: untick what the round should leave.
    this.state = {
      ...input.state,
      cursor: 0,
      message: null,
      ticked: input.state.candidates.map((item) => item.ref),
    };
  }

  invalidate(): void {
    return undefined;
  }

  handleInput(data: string): void {
    if (data === 'q' || matchesKey(data, 'escape')) {
      this.closeView();
      return;
    }
    if (this.started) {
      return;
    }
    const { candidates, cursor, ticked } = this.state;
    const count = candidates.length;
    if (matchesKey(data, 'enter')) {
      const choice = pickedFeedback(this.state);
      if (choice === null) {
        this.state = {
          ...this.state,
          message:
            this.state.candidates.length === 0
              ? 'Nothing to start: add a note to the command to start a round anyway.'
              : 'Tick at least one comment to start a round.',
        };
        return;
      }
      this.started = true;
      this.start(choice);
      return;
    }
    if (count === 0) {
      return;
    }
    if (matchesKey(data, 'up') || data === 'k') {
      this.state = { ...this.state, cursor: (cursor - 1 + count) % count, message: null };
    } else if (matchesKey(data, 'down') || data === 'j') {
      this.state = { ...this.state, cursor: (cursor + 1) % count, message: null };
    } else if (data === ' ' || matchesKey(data, 'space')) {
      const ref = candidates[cursor]?.ref;
      if (ref !== undefined) {
        this.state = {
          ...this.state,
          message: null,
          ticked: ticked.includes(ref) ? ticked.filter((item) => item !== ref) : [...ticked, ref],
        };
      }
    } else if (data === 'a') {
      this.state = {
        ...this.state,
        message: null,
        ticked: ticked.length === count ? [] : candidates.map((item) => item.ref),
      };
    }
  }

  render(width: number): Array<string> {
    return renderFeedbackPicker({
      ...this.state,
      height: Math.max(12, this.tui.terminal.rows),
      link: terminalLink(),
      theme: this.theme,
      width,
    });
  }
}
