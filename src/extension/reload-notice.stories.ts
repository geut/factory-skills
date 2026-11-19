import { story, type Component } from '../stories/story.ts';
import { renderReloadFooter, renderReloadNotice, type ReloadNotice } from './reload-notice.ts';

export const component: Component = {
  description:
    'What Pi shows when the server restarted on another version, as after an update, while this session still runs the extension it loaded at its start: one card per server version, and a footer line until /reload.',
  id: 'reload-notice',
  name: 'Reload Notice',
  stories: [
    story<ReloadNotice>({
      args: () => ({ pi: '0.5.0', server: '0.6.0' }),
      description: 'The server updated to 0.6.0; this session loaded the 0.5.0 extension.',
      name: 'card',
      render: (notice, view) =>
        renderReloadNotice({ notice, theme: view.theme, width: view.width }),
    }),
    story<ReloadNotice>({
      args: () => ({ pi: '0.5.0', server: '0.6.0' }),
      description: 'In Pi’s footer until the session reloads.',
      name: 'footer line',
      render: (notice, view) => [renderReloadFooter({ notice, theme: view.theme })],
    }),
  ],
};
