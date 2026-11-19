import type { MessageRenderer } from '@earendil-works/pi-coding-agent';
import { wrapTextWithAnsi, type Component } from '@earendil-works/pi-tui';
import { z } from 'zod';
import { versionOf } from '../update/releases.ts';
import type { StatusTheme } from './status-message.ts';

// Pi keeps the operator extension it loaded at its start, so after the server
// restarts on another version (an update) the session asks for /reload.

export const ReloadNotice = z.object({ pi: z.string(), server: z.string() });

export type ReloadNotice = z.infer<typeof ReloadNotice>;

// The two versions when they are different releases; null when they match or
// either cannot be read. Builds of one release (`0.5.0+1ddf4f6` and
// `0.5.0+1ddf4f6-dirty`, a checkout someone is working on) count as matching.
export function reloadNeeded(input: { pi: string; server: string }): ReloadNotice | null {
  const pi = versionOf(input.pi);
  const server = versionOf(input.server);
  return pi === null || server === null || pi === server ? null : { pi, server };
}

// When to ask the server its version: once per server instance (a restart
// is a new one), one ask at a time, and after an ask that failed, again only
// once `askAgainMs` has passed, not on every poll.
export function createVersionAsks(input: { askAgainMs: number; now: () => number }): {
  answered: (ok: boolean) => void;
  reset: () => void;
  shouldAsk: (instance: string | null) => boolean;
} {
  let seen: string | null | undefined;
  let asking = false;
  let askAgainAt: number | null = null;
  return {
    answered: (ok) => {
      asking = false;
      askAgainAt = ok ? null : input.now() + input.askAgainMs;
    },
    reset: () => {
      seen = undefined;
      askAgainAt = null;
    },
    shouldAsk: (instance) => {
      if (asking) {
        return false;
      }
      const retrying = askAgainAt !== null && input.now() >= askAgainAt;
      if (instance === seen && !retrying) {
        return false;
      }
      seen = instance;
      askAgainAt = null;
      asking = instance !== null;
      return asking;
    },
  };
}

export function reloadNoticeText(notice: ReloadNotice): string {
  return `The factory server is on ${notice.server}; this Pi runs ${notice.pi}. Run /reload`;
}

export function renderReloadNotice(input: {
  notice: ReloadNotice;
  theme: StatusTheme;
  width: number;
}): Array<string> {
  const { notice, theme } = input;
  const width = Math.max(1, input.width);
  return [
    ...wrapTextWithAnsi(
      `${theme.fg('warning', '⟳')} ${theme.bold(theme.fg('customMessageLabel', `The factory server is on ${notice.server}`))}${theme.fg('muted', `; this Pi runs ${notice.pi}`)}`,
      width,
    ),
    ...wrapTextWithAnsi(
      `${theme.fg('warning', '→')} ${theme.fg('text', '/reload')}${theme.fg('muted', ' loads the extension that matches it')}`,
      Math.max(1, width - 2),
    ).map((row) => `  ${row}`),
  ];
}

// `⟳ /reload for factory 0.5.0`, until the session reloads.
export function renderReloadFooter(input: { notice: ReloadNotice; theme: StatusTheme }): string {
  return input.theme.fg('warning', `⟳ /reload for factory ${input.notice.server}`);
}

export const reloadNoticeRenderer: MessageRenderer<ReloadNotice> = (
  message,
  options,
  theme,
): Component => ({
  invalidate() {
    return undefined;
  },
  render(width) {
    const notice = ReloadNotice.safeParse(message.details);
    return notice.success
      ? renderReloadNotice({
          notice: notice.data,
          theme: {
            bold: (text) => theme.bold(text),
            fg: (color, text) => theme.fg(color, text),
          },
          width: Math.max(1, width - Math.max(0, options.outputPad)),
        })
      : [];
  },
});
