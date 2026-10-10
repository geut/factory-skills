import type { MessageRenderer } from '@earendil-works/pi-coding-agent';
import {
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
} from '@earendil-works/pi-tui';
import { decodeCard, type CardTone, type FactoryCard } from '../controller/card.ts';

export type StatusColor =
  | 'accent'
  | 'customMessageLabel'
  | 'customMessageText'
  | 'dim'
  | 'error'
  | 'muted'
  | 'success'
  | 'text'
  | 'warning';

export type StatusTheme = {
  bold: (text: string) => string;
  fg: (color: StatusColor, text: string) => string;
};

export type FactoryStatusDetails = {
  text: string;
};

const toneStyle: Record<CardTone, { color: StatusColor; glyph: string }> = {
  attention: { color: 'warning', glyph: '▲' },
  done: { color: 'success', glyph: '✓' },
  failed: { color: 'error', glyph: '✗' },
  progress: { color: 'accent', glyph: '●' },
};

function bodyLines(value: FactoryCard): Array<string> {
  return value.body
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => !line.trim().startsWith('Run ended with '));
}

function summaryOf(value: FactoryCard): string {
  return (
    bodyLines(value)
      .find((line) => line.trim().length > 0)
      ?.trim() ?? ''
  );
}

// `03/06 Overview page · r1 · 3/6 done`
function contextLine(value: FactoryCard): string {
  return [value.task, value.round === null ? null : `r${value.round}`, value.progress]
    .filter((part) => part !== null && part.length > 0)
    .join(' · ');
}

function titleText(value: FactoryCard): string {
  return [value.displayRef, value.stage, value.outcome]
    .filter((part) => part.length > 0)
    .join(' · ');
}

export function factoryStatusPayload(text: string): {
  content: string;
  details: FactoryStatusDetails;
} {
  const value = decodeCard(text);
  const lines = [titleText(value), contextLine(value), summaryOf(value)];
  if (value.next !== null) {
    lines.push(`Next: ${value.next}`);
  }
  return {
    content: lines.filter((line) => line.length > 0).join('\n'),
    details: { text },
  };
}

// Wraps `text` under `first`, with later rows aligned under the text.
function wrapIndented(text: string, width: number, first: string, rest = first): Array<string> {
  const room = Math.max(1, width - Math.max(visibleWidth(first), visibleWidth(rest)));
  return wrapTextWithAnsi(text, room).map((row, index) => `${index === 0 ? first : rest}${row}`);
}

export function renderFactoryStatus(input: {
  expanded: boolean;
  text: string;
  theme: StatusTheme;
  width: number;
}): Array<string> {
  const { theme } = input;
  const width = Math.max(1, input.width);
  const value = decodeCard(input.text);
  const style = toneStyle[value.tone];
  const headed = value.stage.length > 0 || value.outcome.length > 0;
  const rows: Array<string> = [];

  const ref = theme.bold(theme.fg('customMessageLabel', value.displayRef));
  const parts = [ref];
  if (value.stage.length > 0) {
    parts.push(theme.fg('muted', value.stage));
  }
  if (value.outcome.length > 0) {
    parts.push(theme.fg(style.color, value.outcome));
  }
  const title = headed
    ? `${theme.fg(style.color, style.glyph)} ${parts.join(theme.fg('muted', ' · '))}`
    : ref;
  rows.push(...wrapIndented(title, width, '', headed ? '  ' : ''));

  const context = contextLine(value);
  if (context.length > 0) {
    rows.push(...wrapIndented(theme.fg('dim', context), width, '  '));
  }

  const lines = bodyLines(value);
  const summary = summaryOf(value);
  const indent = headed ? '  ' : '';
  let omitted = 0;
  // A notice that waits on the user is short, and every line of it matters.
  if (input.expanded || value.tone === 'attention') {
    // List lines hang under their text, not under the dash.
    for (const line of lines) {
      const hang = /^\s*[-*•] /.test(line) ? `${indent}  ` : indent;
      rows.push(...wrapIndented(theme.fg('customMessageText', line.trim()), width, indent, hang));
    }
  } else if (summary.length > 0) {
    rows.push(truncateToWidth(`${indent}${theme.fg('customMessageText', summary)}`, width, '…'));
    const total = wrapTextWithAnsi(lines.join('\n').trim(), Math.max(1, width - indent.length));
    omitted = Math.max(0, total.filter((row) => row.trim().length > 0).length - 1);
  }

  for (const item of value.items) {
    rows.push(...wrapIndented(theme.fg('text', item), width, '  • ', '    '));
  }
  if (value.next !== null) {
    rows.push(
      ...wrapIndented(
        theme.fg(style.color, value.next),
        width,
        `  ${theme.fg(style.color, '→')} `,
        '    ',
      ),
    );
  }
  if (omitted > 0) {
    rows.push(
      truncateToWidth(
        `${indent}${theme.fg('dim', `+${omitted} line${omitted === 1 ? '' : 's'} · expand to read`)}`,
        width,
      ),
    );
  }
  return rows.filter((row, index) => index === 0 || row.trim().length > 0);
}

function detailsText(details: unknown): string | null {
  if (typeof details !== 'object' || details === null || !('text' in details)) {
    return null;
  }
  return typeof details.text === 'string' ? details.text : null;
}

function textOf(content: string | ReadonlyArray<{ text?: string; type: string }>): string {
  if (typeof content === 'string') {
    return content;
  }
  return content
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('\n');
}

export const factoryStatusRenderer: MessageRenderer<FactoryStatusDetails> = (
  message,
  options,
  theme,
): Component => {
  return {
    invalidate() {
      return undefined;
    },
    render(width) {
      return renderFactoryStatus({
        expanded: options.expanded,
        text: detailsText(message.details) ?? textOf(message.content),
        theme: {
          bold: (text) => theme.bold(text),
          fg: (color, text) => theme.fg(color, text),
        },
        width: Math.max(1, width - Math.max(0, options.outputPad)),
      });
    },
  };
};
