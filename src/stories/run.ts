import { parseArgs } from 'node:util';
import { components } from './index.ts';
import { plainTheme, renderDefault, WIDTHS, type GalleryTheme, type Story } from './story.ts';
import { loadThemes } from './themes.ts';

// Prints stories to the terminal. `npm run gallery` serves the live app.
// npm run stories [-- --width 60] [--theme light] [--story plan] [--plain]

const { values } = parseArgs({
  options: {
    plain: { type: 'boolean' },
    story: { type: 'string' },
    theme: { type: 'string' },
    width: { type: 'string' },
  },
});

const needle = values.story?.toLowerCase();
const selected = components.flatMap((component) =>
  component.stories
    .filter(
      (story) =>
        needle === undefined ||
        story.name.toLowerCase().includes(needle) ||
        component.id.includes(needle) ||
        component.name.toLowerCase().includes(needle),
    )
    .map((story) => ({ component: component.id, story })),
);

function print(entries: Array<{ component: string; story: Story }>, theme: GalleryTheme) {
  const widths = values.width === undefined ? [...WIDTHS] : [Number(values.width)];
  for (const { component, story } of entries) {
    for (const width of widths) {
      const label = ` ${component} · ${story.name} · ${width} cols `;
      process.stdout.write(
        `\n\u001B[2m──${label}${'─'.repeat(Math.max(0, width - label.length - 2))}\u001B[22m\n`,
      );
      for (const line of renderDefault(story, { theme, width })) {
        process.stdout.write(`${line}\u001B[0m\n`);
      }
    }
  }
}

if (selected.length === 0) {
  process.stderr.write(`No story matches "${values.story ?? ''}".\n`);
  process.exitCode = 1;
} else {
  const theme =
    values.plain === true
      ? plainTheme
      : (await loadThemes())[values.theme === 'light' ? 'light' : 'dark'].theme;
  print(selected, theme);
}
