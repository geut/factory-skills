import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GalleryTheme } from './story.ts';

type PiTheme = GalleryTheme & {
  colors: Record<string, { b: number; g: number; r: number } | undefined>;
};

type ThemeModule = {
  getThemeExportColors: (name: string) => { pageBg?: string };
  loadThemeFromPath: (file: string, mode: string) => PiTheme;
};

export type ThemeName = 'dark' | 'light';

export type LoadedTheme = {
  name: ThemeName;
  // The terminal background and default text colour for this theme.
  page: string;
  text: string;
  theme: GalleryTheme;
};

// Pi's own dark and light themes, read from the installed package so the
// gallery shows the colours Pi will use.
export async function loadThemes(): Promise<Record<ThemeName, LoadedTheme>> {
  const entry = fileURLToPath(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const dir = path.join(path.dirname(entry), 'modes/interactive/theme');
  const module = (await import(path.join(dir, 'theme.js'))) as ThemeModule;
  const load = (name: ThemeName): LoadedTheme => {
    const theme = module.loadThemeFromPath(path.join(dir, `${name}.json`), 'truecolor');
    const text = theme.colors['text'];
    return {
      name,
      page: module.getThemeExportColors(name).pageBg ?? (name === 'dark' ? '#21252c' : '#efeeee'),
      text:
        text === undefined
          ? name === 'dark'
            ? '#e0e0e0'
            : '#333333'
          : `rgb(${text.r},${text.g},${text.b})`,
      theme,
    };
  };
  return { dark: load('dark'), light: load('light') };
}
