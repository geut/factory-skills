import type { Component } from './story.ts';
import type { ThemeName } from './themes.ts';

// Server-rendered shells for the gallery. The scenarios render in the
// browser through /api/render, so edits re-render without a reload.

type Nav = Array<{ id: string; name: string }>;
type Palette = Record<ThemeName, { page: string; text: string }>;

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

// Inline code in descriptions: `text` becomes <code>text</code>.
function prose(text: string): string {
  return escapeHtml(text).replaceAll(/`([^`]+)`/g, '<code>$1</code>');
}

// JSON inside a <script> tag must not be able to close it.
function embed(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', String.raw`\u003c`);
}

function shell(input: {
  active: string | null;
  boot: string;
  data: Record<string, unknown>;
  main: string;
  nav: Nav;
  palette: Palette;
  title: string;
}): string {
  const links = input.nav
    .map(
      (item) =>
        `<li><a href="/component/${item.id}"${item.id === input.active ? ' aria-current="page"' : ''}>${escapeHtml(item.name)}</a></li>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en" data-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(input.title)}</title>
<link rel="stylesheet" href="/assets/gallery.css">
<script>try { document.documentElement.dataset.theme = localStorage.getItem('gallery:theme') || 'dark'; } catch {}</script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">Factory TUI gallery</a>
  <label class="theme-select">Theme
    <select id="theme">
      <option value="dark">Pi dark</option>
      <option value="light">Pi light</option>
    </select>
  </label>
</header>
<div class="layout">
  <nav class="sidebar" aria-label="Components">
    <h2>Components</h2>
    <ul>${links}</ul>
  </nav>
  <main>${input.main}</main>
</div>
<script id="gallery-data" type="application/json">${embed({ ...input.data, boot: input.boot, palette: input.palette })}</script>
<script type="module" src="/assets/gallery.js"></script>
</body>
</html>
`;
}

export function indexPage(input: {
  boot: string;
  components: Array<Component>;
  nav: Nav;
  palette: Palette;
}): string {
  const cards = input.components
    .map(
      (item) => `<a class="card" href="/component/${item.id}">
  <h2>${escapeHtml(item.name)}</h2>
  <p>${prose(item.description)}</p>
  <span class="meta">${item.stories.length} scenario${item.stories.length === 1 ? '' : 's'}</span>
</a>`,
    )
    .join('');
  return shell({
    active: null,
    boot: input.boot,
    data: { page: 'index' },
    main: `<h1>Components</h1>
<p class="lede">The factory extension’s TUI components, rendered with Pi’s own themes from scenario data. Open a component to see its states, change the width, and edit a scenario’s state live.</p>
<div class="cards">${cards}</div>`,
    nav: input.nav,
    palette: input.palette,
    title: 'Factory TUI gallery',
  });
}

export function componentPage(input: {
  boot: string;
  component: {
    description: string;
    id: string;
    name: string;
    stories: Array<{ args: unknown; description: string; id: string; name: string }>;
  };
  nav: Nav;
  palette: Palette;
  widths: Array<number>;
}): string {
  const { component } = input;
  const toc = component.stories
    .map(
      (item, index) => `<li><a href="#${item.id}">${index + 1}. ${escapeHtml(item.name)}</a></li>`,
    )
    .join('');
  const scenarios = component.stories
    .map(
      (item, index) => `<article class="scenario" id="${item.id}" data-story="${item.id}">
  <header class="scenario-head">
    <div>
      <h2><span class="index">${index + 1}</span> ${escapeHtml(item.name)} <span class="edited" hidden>edited</span></h2>
      <p>${prose(item.description)}</p>
    </div>
    <div class="actions">
      <button type="button" class="toggle-editor" aria-expanded="false">Edit state</button>
      <button type="button" class="reset" hidden>Reset</button>
      <a class="anchor" href="#${item.id}" aria-label="Link to this scenario">#</a>
    </div>
  </header>
  <div class="scenario-body">
    <div class="frames" aria-live="polite"></div>
    <div class="editor" hidden>
      <label for="state-${item.id}">State (JSON) — edits re-render as you type</label>
      <textarea id="state-${item.id}" spellcheck="false"></textarea>
      <p class="error" role="alert" hidden></p>
    </div>
  </div>
</article>`,
    )
    .join('');
  const widths = input.widths
    .map(
      (width) =>
        `<label class="chip"><input type="checkbox" name="width" value="${width}"> ${width} cols</label>`,
    )
    .join('');
  return shell({
    active: component.id,
    boot: input.boot,
    data: { component, page: 'component' },
    main: `<div class="component-head">
  <h1>${escapeHtml(component.name)}</h1>
  <p class="lede">${prose(component.description)}</p>
  <div class="toolbar">
    <fieldset class="widths"><legend>Width</legend>${widths}</fieldset>
    <span class="count">${component.stories.length} scenarios</span>
  </div>
  <details class="toc"><summary>Scenarios</summary><ol>${toc}</ol></details>
</div>
<div class="scenarios">${scenarios}</div>`,
    nav: input.nav,
    palette: input.palette,
    title: `${component.name} · Factory TUI gallery`,
  });
}

export function notFoundPage(input: { boot: string; nav: Nav; palette: Palette }): string {
  return shell({
    active: null,
    boot: input.boot,
    data: { page: 'missing' },
    main: '<h1>Not found</h1><p class="lede">No component has that name. Pick one from the list.</p>',
    nav: input.nav,
    palette: input.palette,
    title: 'Not found · Factory TUI gallery',
  });
}
