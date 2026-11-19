import { story, type Component } from '../stories/story.ts';
import type { UpdateNotice } from '../update/notice.ts';
import { renderUpdateFooter, renderUpdateNotice } from './update-notice.ts';

type FooterArgs = { installed: boolean; later: boolean; latest: string; pending: boolean };

// The link opens in terminals that follow OSC 8 links; the gallery shows its
// text, as other terminals do.
function notice(name: string, description: string, args: () => UpdateNotice) {
  return story<UpdateNotice>({
    args,
    description,
    name,
    render: (value, view) =>
      renderUpdateNotice({ notice: value, theme: view.theme, width: view.width }),
  });
}

function footer(name: string, description: string, args: () => FooterArgs) {
  return story<FooterArgs>({
    args,
    description,
    name,
    render: (value, view) => [renderUpdateFooter({ ...value, theme: view.theme })],
  });
}

export const component: Component = {
  description:
    'What Pi shows when a newer factory release is out: a card, posted once per newest release in the session running when the server found it, and a footer line that stays until the factory runs it.',
  id: 'update-notice',
  name: 'Update Notice',
  stories: [
    notice(
      'one release newer',
      'The factory runs the release before the newest: the link opens that release’s notes.',
      () => ({
        current: '0.4.1',
        installed: false,
        latest: '0.5.0',
        name: 'v0.5.0',
        notesUrl: 'https://github.com/geut/factory-skills/releases/tag/v0.5.0',
      }),
    ),
    notice(
      'several releases newer',
      'The owner skipped releases: the card names only the newest, and the link compares the running version with it, so it covers every release between.',
      () => ({
        current: '0.3.0',
        installed: false,
        latest: '0.6.0',
        name: 'Factory updates itself',
        notesUrl: 'https://github.com/geut/factory-skills/compare/v0.3.0...v0.6.0',
      }),
    ),
    notice(
      'installed by another factory',
      'Another factory sharing the binary updated it: this server still runs the old version, and `/factory update` only restarts it.',
      () => ({
        current: '0.5.0',
        installed: true,
        latest: '0.6.0',
        name: 'v0.6.0',
        notesUrl: 'https://github.com/geut/factory-skills/releases/tag/v0.6.0',
      }),
    ),
    footer(
      'footer line',
      'In Pi’s footer, from the first check that finds the release until the factory runs it.',
      () => ({ installed: false, later: false, latest: '0.5.0', pending: false }),
    ),
    footer(
      'footer line, later',
      'After `/factory update --later`: no more cards for this release, and the line dims.',
      () => ({ installed: false, later: true, latest: '0.5.0', pending: false }),
    ),
    footer(
      'footer line, installed',
      'The binary on disk has the release; a restart runs it.',
      () => ({ installed: true, later: false, latest: '0.6.0', pending: false }),
    ),
    footer(
      'footer line, when idle',
      'After `/factory update --when-idle`, while agents run or actions are queued.',
      () => ({ installed: false, later: false, latest: '0.6.0', pending: true }),
    ),
  ],
};
