import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { createGalleryServer } from './server.ts';
import { loadThemes } from './themes.ts';

let base = '';
let close: () => Promise<void> = async () => undefined;

before(async () => {
  const server = createGalleryServer(await loadThemes());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
});

after(() => close());

async function render(body: unknown): Promise<{ json: Record<string, unknown>; status: number }> {
  const response = await fetch(`${base}/api/render`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  });
  return { json: (await response.json()) as Record<string, unknown>, status: response.status };
}

test('the index lists every component by name with its description', async () => {
  const html = await (await fetch(`${base}/`)).text();
  for (const name of ['Status Message', 'Widget', 'Ticket View', 'Agents View']) {
    assert.match(html, new RegExp(`>${name}<`));
  }
  assert.match(html, /Live status above the editor/);
  assert.match(html, /<select id="theme">/);
});

test('a component page lists its scenarios with the width selector', async () => {
  const response = await fetch(`${base}/component/status-message`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>Status Message<\/h1>/);
  assert.match(html, /aria-current="page">Status Message</);
  assert.match(html, /data-story="plan-ready-6-tasks-with-dependencies"/);
  for (const width of [40, 60, 80, 120]) {
    assert.match(html, new RegExp(`name="width" value="${width}"`));
  }
  assert.equal((await fetch(`${base}/component/nope`)).status, 404);
});

test('render returns themed HTML per width and accepts edited state', async () => {
  const defaults = await render({
    component: 'status-message',
    story: 'task-03-06-approved-next-task-queued',
    theme: 'dark',
    widths: [40, 80],
  });
  assert.equal(defaults.status, 200);
  const renders = defaults.json['renders'] as Array<{ html: string; width: number }>;
  assert.deepEqual(
    renders.map((item) => item.width),
    [40, 80],
  );
  assert.match(renders[1]?.html ?? '', /<span style="color:#[0-9a-f]{6}">✓<\/span>/);

  const edited = await render({
    args: {
      card: {
        body: 'Edited in the gallery.',
        displayRef: 'proj-1',
        items: [],
        next: null,
        outcome: 'approved',
        progress: '1/1 done',
        round: 1,
        stage: 'review',
        task: '01/01 Edited',
        tone: 'done',
      },
      expanded: false,
    },
    component: 'status-message',
    story: 'task-03-06-approved-next-task-queued',
    theme: 'light',
    widths: [60],
  });
  const html = (edited.json['renders'] as Array<{ html: string }>)[0]?.html ?? '';
  assert.match(html, /proj-1/);
  assert.match(html, /Edited in the gallery\./);
});

test('bad state and unknown scenarios return a message, not a crash', async () => {
  const broken = await render({
    args: { children: 'not a list' },
    component: 'widget',
    story: 'task-03-06-working-round-1',
    widths: [80],
  });
  assert.equal(broken.status, 422);
  assert.equal(typeof broken.json['error'], 'string');
  assert.equal((await render({ component: 'widget', story: 'nope' })).status, 422);
  const invalid = await fetch(`${base}/api/render`, { body: '{', method: 'POST' });
  assert.equal(invalid.status, 400);
});

test('the client assets are served', async () => {
  const script = await fetch(`${base}/assets/gallery.js`);
  assert.equal(script.status, 200);
  assert.match(script.headers.get('content-type') ?? '', /javascript/);
  assert.equal((await fetch(`${base}/assets/gallery.css`)).status, 200);
});
