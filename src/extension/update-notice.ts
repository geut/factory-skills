import type { MessageRenderer } from '@earendil-works/pi-coding-agent';
import { truncateToWidth, wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { z } from 'zod';
import { terminalLink, type Link } from './feedback-picker.ts';
import type { StatusTheme } from './status-message.ts';

// The card Pi posts once per newest release, and the footer line that stays
// until the factory runs it. Both say only the newest release, however many
// the factory skipped: the link covers everything between.

export const UpdateNotice = z.object({
  current: z.string(),
  latest: z.string(),
  name: z.string(),
  notesUrl: z.string(),
});

export type UpdateNotice = z.infer<typeof UpdateNotice>;

// A release named after its tag says nothing more than the version.
function namedApart(notice: UpdateNotice): boolean {
  const name = notice.name.trim();
  return name.length > 0 && name !== notice.latest && name !== `v${notice.latest}`;
}

export function updateNoticeText(notice: UpdateNotice): string {
  return [
    `factory ${notice.latest} is available · you run ${notice.current}`,
    ...(namedApart(notice) ? [notice.name] : []),
    `What's new in ${notice.latest}: ${notice.notesUrl}`,
    'Update: /factory update · later: /factory update --later',
  ].join('\n');
}

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
  return [
    ...wrapTextWithAnsi(
      `${theme.fg('accent', '⬆')} ${theme.bold(theme.fg('customMessageLabel', `factory ${notice.latest}`))} ${theme.fg('customMessageText', 'is available')}${theme.fg('muted', ` · you run ${notice.current}`)}`,
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

// `⬆ factory 0.5.0`, dimmed once the owner said later to it.
export function renderUpdateFooter(input: {
  later: boolean;
  latest: string;
  theme: StatusTheme;
}): string {
  return input.theme.fg(input.later ? 'dim' : 'accent', `⬆ factory ${input.latest}`);
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
