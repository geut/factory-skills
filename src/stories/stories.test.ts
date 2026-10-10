import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui';
import { components } from './index.ts';
import { plainTheme, renderDefault, slug, WIDTHS, type Component } from './story.ts';

// Every story at every width, as plain text. `npm run stories:update`
// rewrites the snapshots after an intended UI change.

const directory = path.join(import.meta.dirname, 'snapshots');
const update = process.env['STORIES_UPDATE'] === '1';

function rendered(component: Component): string {
  const blocks: Array<string> = [];
  for (const story of component.stories) {
    for (const width of WIDTHS) {
      const lines = renderDefault(story, { theme: plainTheme, width }).map((line) =>
        stripTerminalSequences(line).trimEnd(),
      );
      blocks.push(`== ${story.name} · ${width} cols ==\n${lines.join('\n')}`);
    }
  }
  return `${blocks.join('\n\n')}\n`;
}

test('every story fits its width', () => {
  const overflows: Array<string> = [];
  for (const component of components) {
    for (const story of component.stories) {
      for (const width of WIDTHS) {
        for (const [index, line] of renderDefault(story, { theme: plainTheme, width }).entries()) {
          const size = visibleWidth(line);
          if (size > width) {
            overflows.push(
              `${component.id} · ${story.name} · ${width} cols, line ${index + 1}: ${size}`,
            );
          }
        }
      }
    }
  }
  assert.deepEqual(overflows, []);
});

test('components and scenarios have names, descriptions, and unique ids', () => {
  const ids = components.map((component) => component.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const component of components) {
    assert.ok(component.name.length > 0 && component.description.length > 0, component.id);
    const stories = component.stories.map((story) => slug(story.name));
    assert.equal(new Set(stories).size, stories.length, component.id);
    for (const story of component.stories) {
      assert.ok(story.description.length > 0, `${component.id} · ${story.name}`);
    }
  }
});

test('scenario state is plain JSON that renders the same after a round trip', () => {
  for (const component of components) {
    for (const story of component.stories) {
      // The gallery sends state as JSON text, so go through text, not structuredClone.
      const text = JSON.stringify(story.args());
      const args: unknown = JSON.parse(text);
      assert.deepEqual(
        story.render(args, { theme: plainTheme, width: 80 }),
        renderDefault(story, { theme: plainTheme, width: 80 }),
        `${component.id} · ${story.name}`,
      );
    }
  }
});

for (const component of components) {
  test(`${component.id} stories match their snapshot`, () => {
    const file = path.join(directory, `${component.id}.txt`);
    const actual = rendered(component);
    if (update || !existsSync(file)) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(file, actual);
      return;
    }
    assert.equal(actual, readFileSync(file, 'utf8'), 'run npm run stories:update to accept');
  });
}
