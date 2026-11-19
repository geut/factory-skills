import type { MessageRenderer } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { headline, namedApart, UpdateNotice } from '../update/notice.ts';
import { terminalLink, type Link } from './feedback-picker.ts';
import type { StatusTheme } from './status-message.ts';

// The card Pi posts once per newest release, and the footer line that stays
// until the factory runs it. Both say only the newest release, however many
// the factory skipped: the link covers everything between.

export function renderUpdateNotice(input: {
  link?: Link;
  notice: UpdateNotice;
  theme: StatusTheme;
  width: number;
}): Array<string> {
  const { notice, theme } = input;
  const width = Math.max(1, input.width);
  const link = input.link ?? ((text: string) => text);
  const wrap = (text: string): Array<string> =>
    wrapTextWithAnsi(text, Math.max(1, width - 2)).map((row) => `  ${row}`);
  const { running, state } = headline(notice);
  return [
    ...wrapTextWithAnsi(
      `${theme.fg('accent', '⬆')} ${theme.bold(theme.fg('customMessageLabel', `factory ${notice.latest}`))} ${theme.fg('customMessageText', state)}${theme.fg('muted', ` · ${running}`)}`,
      width,
    ),
    ...(namedApart(notice) ? wrap(theme.fg('customMessageText', notice.name)) : []),
    truncateToWidth(
      `  ${link(theme.fg('accent', `What's new in ${notice.latest}`), notice.notesUrl)}`,
      width,
      '…',
    ),
    // The plain address, for terminals that do not open links.
    ...wrap(theme.fg('dim', notice.notesUrl)),
    ...wrap(
      `${theme.fg('accent', '→')} ${theme.fg('text', '/factory update')}${theme.fg('muted', ' · later: /factory update --later')}`,
    ),
  ];
}

// `⬆ factory 0.5.0`, dimmed once the owner said later to it; `· restart`
// when the binary on disk has it, `· when idle` while it waits to install.
export function renderUpdateFooter(input: {
  installed: boolean;
  later: boolean;
  latest: string;
  pending: boolean;
  theme: StatusTheme;
}): string {
  const note = input.pending ? ' · when idle' : input.installed ? ' · restart' : '';
  return input.theme.fg(input.later ? 'dim' : 'accent', `⬆ factory ${input.latest}${note}`);
}

export const updateNoticeRenderer: MessageRenderer<UpdateNotice> = (
  message,
  options,
  theme,
): Component => ({
  invalidate() {
    return undefined;
  },
  render(width) {
    const notice = UpdateNotice.safeParse(message.details);
    const inner = Math.max(1, width - Math.max(0, options.outputPad));
    if (!notice.success) {
      return [];
    }
    return renderUpdateNotice({
      link: terminalLink(),
      notice: notice.data,
      theme: {
        bold: (text) => theme.bold(text),
        fg: (color, text) => theme.fg(color, text),
      },
      width: inner,
    });
  },
});
