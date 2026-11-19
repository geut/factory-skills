import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { GhJson } from '../ports/gh.ts';
import { CHECK_EVERY_MS, createUpdateChecker, dueIn } from './checker.ts';
import { EMPTY_UPDATE_STATE, readUpdateState } from './state.ts';

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

const newest = listing(['v0.5.0']);

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

test('checks running at once share one call to GitHub', async () => {
  const { checker, world } = setUp();
  let calls = 0;
  world.gh = (args) => {
    calls += 1;
    return newest(args);
  };
  const [first, second] = await Promise.all([checker.check(), checker.check()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  await checker.check();
  assert.equal(calls, 2);
});

test('a check still running when the server closes records nothing', async () => {
  const { checker, factoryRoot, world } = setUp();
  const github = Promise.withResolvers<unknown>();
  world.gh = () => github.promise;
  const pending = checker.check();
  checker.close();
  github.resolve(await newest([]));
  assert.equal((await pending).kind, 'failed');
  assert.equal(readUpdateState(factoryRoot).checkedAt, null);
});

test('the next check is due a day after the last one, or now for a new version', () => {
  const checkedAt = '2026-11-19T10:00:00.000Z';
  const state = { ...EMPTY_UPDATE_STATE, checkedAt, current: '0.4.0' };
  const hour = 60 * 60 * 1000;
  assert.equal(dueIn({ current: '0.4.0', now: checkedAt, state }), CHECK_EVERY_MS);
  assert.equal(
    dueIn({ current: '0.4.0', now: '2026-11-19T15:00:00.000Z', state }),
    CHECK_EVERY_MS - 5 * hour,
  );
  assert.equal(dueIn({ current: '0.4.0', now: '2026-11-21T10:00:00.000Z', state }), 0);
  assert.equal(dueIn({ current: '0.5.0', now: checkedAt, state }), 0);
  assert.equal(dueIn({ current: '0.4.0', now: checkedAt, state: EMPTY_UPDATE_STATE }), 0);
  // A clock that went back waits at most a day.
  assert.equal(dueIn({ current: '0.4.0', now: '2026-11-18T10:00:00.000Z', state }), CHECK_EVERY_MS);
});

test('a restart soon after a check does not ask GitHub again', async () => {
  const { checker, factoryRoot, world } = setUp();
  await checker.check();
  let calls = 0;
  const restarted = createUpdateChecker({
    current: '0.4.0',
    enabled: () => true,
    factoryRoot,
    gh: () => {
      calls += 1;
      return Promise.resolve([]);
    },
    now: () => world.now,
  });
  restarted.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  restarted.close();
  assert.equal(calls, 0);
});

test('a check that throws anywhere is a failed check, so the daily timer never ends the server', async () => {
  const checker = createUpdateChecker({
    current: '0.4.0',
    enabled: () => {
      throw new Error('FACTORY.json is unreadable');
    },
    factoryRoot: mkdtempSync(path.join(tmpdir(), 'factory-update-')),
    gh: newest,
    now: () => '2026-11-19T10:00:00.000Z',
  });
  assert.deepEqual(await checker.check(), {
    kind: 'failed',
    message: 'FACTORY.json is unreadable',
  });
});
