import { z } from 'zod';

// An update as Pi's card shows it, and the card's plain text: for the
// message history, and for the command line, which carries no terminal UI.

export const UpdateNotice = z.object({
  current: z.string(),
  // The binary on disk has it already; updating restarts the server.
  installed: z.boolean().default(false),
  latest: z.string(),
  name: z.string(),
  notesUrl: z.string(),
});

export type UpdateNotice = z.infer<typeof UpdateNotice>;

// A release named after its tag says nothing more than the version.
export function namedApart(notice: UpdateNotice): boolean {
  const name = notice.name.trim();
  return name.length > 0 && name !== notice.latest && name !== `v${notice.latest}`;
}

export function headline(notice: UpdateNotice): { running: string; state: string } {
  return notice.installed
    ? { running: `restart to use it · this server runs ${notice.current}`, state: 'is installed' }
    : { running: `you run ${notice.current}`, state: 'is available' };
}

export function updateNoticeText(notice: UpdateNotice): string {
  const { running, state } = headline(notice);
  return [
    `factory ${notice.latest} ${state} · ${running}`,
    ...(namedApart(notice) ? [notice.name] : []),
    `What's new in ${notice.latest}: ${notice.notesUrl}`,
    `${notice.installed ? 'Restart' : 'Update'}: /factory update · later: /factory update --later`,
  ].join('\n');
}
