import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { ansiToHtml } from './ansi-html.ts';
import { componentById, components } from './index.ts';
import { componentPage, indexPage, notFoundPage } from './page.ts';
import { slug, WIDTHS, type Component } from './story.ts';
import { loadThemes, type LoadedTheme, type ThemeName } from './themes.ts';

// The live component gallery: `npm run gallery`, then open the printed URL.

const assets: Record<string, string> = {
  '/assets/gallery.css': 'text/css; charset=utf-8',
  '/assets/gallery.js': 'text/javascript; charset=utf-8',
};

const maxBody = 1_000_000;

type RenderRequest = {
  args?: unknown;
  component?: unknown;
  story?: unknown;
  theme?: unknown;
  widths?: unknown;
};

function send(response: http.ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': type });
  response.end(body);
}

function sendJson(response: http.ServerResponse, status: number, value: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value));
}

async function readBody(request: http.IncomingMessage): Promise<string> {
  let size = 0;
  const chunks: Array<Buffer> = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.length;
    if (size > maxBody) {
      throw new Error('The request body is too large.');
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function componentData(component: Component) {
  return {
    description: component.description,
    id: component.id,
    name: component.name,
    stories: component.stories.map((story) => ({
      args: story.args(),
      description: story.description,
      id: slug(story.name),
      name: story.name,
    })),
  };
}

// Renders one story at several widths. Errors in edited args come back as
// a message, not a crash.
export function renderStory(
  themes: Record<ThemeName, LoadedTheme>,
  input: RenderRequest,
): { error: string } | { renders: Array<{ html: string; width: number }> } {
  const component = typeof input.component === 'string' ? componentById(input.component) : null;
  if (component === null) {
    return { error: 'Unknown component.' };
  }
  const story = component.stories.find((item) => slug(item.name) === input.story) ?? null;
  if (story === null) {
    return { error: 'Unknown scenario.' };
  }
  const theme = themes[input.theme === 'light' ? 'light' : 'dark'];
  const widths = Array.isArray(input.widths)
    ? input.widths.filter(
        (value): value is number => Number.isInteger(value) && value > 0 && value <= 400,
      )
    : [...WIDTHS];
  const args = input.args === undefined ? story.args() : input.args;
  try {
    return {
      renders: widths.map((width) => ({
        html: story
          .render(args, { theme: theme.theme, width })
          .map((line) => ansiToHtml(line))
          .join('\n'),
        width,
      })),
    };
  } catch (error: unknown) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function createGalleryServer(themes: Record<ThemeName, LoadedTheme>): http.Server {
  const boot = randomUUID();
  const palette = {
    dark: { page: themes.dark.page, text: themes.dark.text },
    light: { page: themes.light.page, text: themes.light.text },
  };
  const nav = components.map((item) => ({ id: item.id, name: item.name }));
  return http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://gallery.local');
      const route = url.pathname;
      if (request.method === 'GET' && route === '/') {
        send(
          response,
          200,
          'text/html; charset=utf-8',
          indexPage({ boot, components, nav, palette }),
        );
        return;
      }
      const match = /^\/component\/([a-z0-9-]+)\/?$/.exec(route);
      if (request.method === 'GET' && match !== null) {
        const component = componentById(match[1] ?? '');
        if (component === null) {
          send(response, 404, 'text/html; charset=utf-8', notFoundPage({ boot, nav, palette }));
          return;
        }
        send(
          response,
          200,
          'text/html; charset=utf-8',
          componentPage({
            boot,
            component: componentData(component),
            nav,
            palette,
            widths: [...WIDTHS],
          }),
        );
        return;
      }
      if (request.method === 'GET' && route === '/api/components') {
        sendJson(
          response,
          200,
          components.map((item) => componentData(item)),
        );
        return;
      }
      if (request.method === 'POST' && route === '/api/render') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(request));
        } catch (error: unknown) {
          sendJson(response, 400, {
            error: error instanceof Error ? error.message : 'Bad request.',
          });
          return;
        }
        const result = renderStory(
          themes,
          typeof parsed === 'object' && parsed !== null ? parsed : {},
        );
        sendJson(response, 'error' in result ? 422 : 200, result);
        return;
      }
      if (request.method === 'GET' && route === '/api/events') {
        // A restarted server has a new boot id; the page reloads when it sees one.
        response.writeHead(200, {
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'content-type': 'text/event-stream',
        });
        response.write(`event: boot\ndata: ${boot}\n\n`);
        const ping = setInterval(() => response.write(': ping\n\n'), 15_000);
        request.on('close', () => clearInterval(ping));
        return;
      }
      const type = assets[route];
      if (request.method === 'GET' && type !== undefined) {
        const file = path.join(import.meta.dirname, 'assets', path.basename(route));
        send(response, 200, type, await readFile(file, 'utf8'));
        return;
      }
      send(response, 404, 'text/html; charset=utf-8', notFoundPage({ boot, nav, palette }));
    })().catch((error: unknown) => {
      if (!response.headersSent) {
        sendJson(response, 500, { error: error instanceof Error ? error.message : String(error) });
      }
    });
  });
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      host: { default: '127.0.0.1', type: 'string' },
      port: { default: '5180', type: 'string' },
    },
  });
  const server = createGalleryServer(await loadThemes());
  server.listen(Number(values.port), values.host, () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : values.port;
    const host = values.host === '0.0.0.0' ? 'localhost' : values.host;
    process.stdout.write(`Factory TUI gallery: http://${host}:${port}/\n`);
  });
}
