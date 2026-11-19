import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { GhJson } from '../ports/gh.ts';
import { createUpdateChecker } from './checker.ts';
import { readUpdateState } from './state.ts';

const listing =
  (tags: Array<string>): GhJson =>
  async () =>
    tags.map((tag) => ({
      draft: false,
      html_url: `https://github.com/geut/factory-skills/releases/tag/${tag}`,
      name: tag,
      prerelease: false,
      tag_name: tag,
    }));

// A checker over one factory root, with GitHub and the clock swappable.
function setUp() {
  const factoryRoot = mkdtempSync(path.join(tmpdir(), 'factory-update-'));
  const world = { enabled: true, gh: listing(['v0.5.0']), now: '2026-11-19T10:00:00.000Z' };
  const checker = createUpdateChecker({
    current: '0.4.0',
    enabled: () => world.enabled,
    factoryRoot,
    gh: (args) => world.gh(args),
    now: () => world.now,
  });
  return { checker, factoryRoot, world };
}

test('a release is announced when first found, and keeps that announcement on later checks', async () => {
  const { checker, factoryRoot, world } = setUp();
  await checker.check();
  assert.equal(readUpdateState(factoryRoot).announcedAt, '2026-11-19T10:00:00.000Z');
  assert.equal(readUpdateState(factoryRoot).current, '0.4.0');

  world.now = '2026-11-20T10:00:00.000Z';
  await checker.check();
  assert.equal(readUpdateState(factoryRoot).announcedAt, '2026-11-19T10:00:00.000Z');
  assert.equal(readUpdateState(factoryRoot).checkedAt, '2026-11-20T10:00:00.000Z');

  world.gh = listing(['v0.6.0', 'v0.5.0']);
  world.now = '2026-11-21T10:00:00.000Z';
  await checker.check();
  assert.equal(readUpdateState(factoryRoot).announcedAt, '2026-11-21T10:00:00.000Z');
});

test('later holds for its release only; a newer one is offered again', async () => {
  const { checker, world } = setUp();
  await checker.check();
  assert.equal(checker.later()?.later, true);
  assert.equal(checker.view()?.later, true);

  world.gh = listing(['v0.6.0']);
  const outcome = await checker.check();
  assert.deepEqual(outcome.kind === 'checked' ? outcome.update?.later : null, false);
});

test('a failed check keeps what the last one found', async () => {
  const { checker, world } = setUp();
  await checker.check();
  world.gh = () => Promise.reject(new Error('gh: HTTP 503'));
  assert.deepEqual(await checker.check(), { kind: 'failed', message: 'gh: HTTP 503' });
  assert.equal(checker.view()?.latest, '0.5.0');
});

test('turning checks off asks GitHub nothing and drops what an earlier check found', async () => {
  const { checker, factoryRoot, world } = setUp();
  await checker.check();
  world.enabled = false;
  world.gh = () => Promise.reject(new Error('asked GitHub'));
  assert.deepEqual(await checker.check(), { kind: 'off' });
  assert.equal(checker.view(), null);
  assert.equal(readUpdateState(factoryRoot).announcedAt, null);
});
