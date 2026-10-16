import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  allowsEmptyDiff,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_SERVER,
  DEFAULT_SETUP_TIMEOUT_MS,
  parseFactoryConfig,
  pullRequestsAllowed,
} from './config.ts';

const models = { review: 'review-model', work: 'work-model' };

test('work commands default to 60 seconds and keep a longer timeout', () => {
  const parsed = parseFactoryConfig({
    models,
    validation: {
      work: {
        commands: [
          { argv: ['npm', 'test'], name: 'tests' },
          { argv: ['npm', 'run', 'lint'], name: 'lint', timeoutMs: 300_000 },
        ],
      },
    },
  });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.equal(parsed.config.validation.work.commands[0]?.timeoutMs, DEFAULT_COMMAND_TIMEOUT_MS);
  assert.equal(parsed.config.validation.work.commands[1]?.timeoutMs, 300_000);
  assert.equal(parsed.config.limits.workCorrections, 3);
});

test('label map accepts investigation and rejects unknown internal labels', () => {
  const parsed = parseFactoryConfig({
    labels: { map: { spike: 'investigation' } },
    models,
  });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.equal(allowsEmptyDiff(['spike'], parsed.config.labels.map), true);
  assert.equal(allowsEmptyDiff(['investigation'], {}), true);
  assert.equal(allowsEmptyDiff(['bug'], parsed.config.labels.map), false);
  assert.equal(parseFactoryConfig({ labels: { map: { spike: 'feature' } }, models }).kind, 'error');
});

test('review limits default to 3 and reviewRounds needs at least one round', () => {
  const parsed = parseFactoryConfig({ limits: { reviewCorrections: 0 }, models });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.equal(parsed.config.limits.reviewRounds, 3);
  assert.equal(parsed.config.limits.reviewCorrections, 0);
  assert.equal(parseFactoryConfig({ limits: { reviewRounds: 0 }, models }).kind, 'error');
  assert.equal(parseFactoryConfig({ limits: { reviewRounds: 1.5 }, models }).kind, 'error');
});

test('server defaults to loopback and accepts a published host and port', () => {
  const defaults = parseFactoryConfig({ models });
  assert.equal(defaults.kind, 'ok');
  if (defaults.kind !== 'ok') {
    return;
  }
  assert.deepEqual(defaults.config.server, DEFAULT_SERVER);

  const published = parseFactoryConfig({ models, server: { host: '0.0.0.0', port: 8080 } });
  assert.equal(published.kind, 'ok');
  if (published.kind !== 'ok') {
    return;
  }
  assert.deepEqual(published.config.server, { host: '0.0.0.0', port: 8080 });

  for (const server of [{ port: 0 }, { port: '8080' }, { host: ' ' }, 'localhost']) {
    assert.equal(parseFactoryConfig({ models, server }).kind, 'error');
  }
});

test('the old github and keys blocks point to tracker and codeHost', () => {
  for (const legacy of [{ github: { owner: 'geut', repo: 'x' } }, { keys: { PROJ: {} } }]) {
    const parsed = parseFactoryConfig({ models, ...legacy });
    assert.equal(parsed.kind, 'error');
    assert.match(parsed.kind === 'error' ? parsed.message : '', /replaced by tracker and codeHost/);
  }
});

test('tracker and codeHost parse, and pull requests default to on', () => {
  const parsed = parseFactoryConfig({
    codeHost: { kind: 'github', owner: 'geut', repo: 'factory-skills' },
    models,
    tracker: {
      backlog: { labels: ['factory'] },
      kind: 'github',
      owner: 'geut',
      repo: 'factory-skills',
      status: { in_progress: { label: 'factory:in-progress' } },
    },
  });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.deepEqual(parsed.config.tracker?.backlog, { labels: ['factory'], milestone: null });
  assert.deepEqual(parsed.config.tracker?.status, {
    in_progress: { label: 'factory:in-progress' },
  });
  assert.equal(parsed.config.codeHost?.pullRequests, true);
  assert.equal(pullRequestsAllowed(parsed.config), true);

  const bare = parseFactoryConfig({ models });
  assert.equal(bare.kind === 'ok' && pullRequestsAllowed(bare.config), true);

  for (const bad of [
    { tracker: { kind: 'linear', owner: 'a', repo: 'b' } },
    { tracker: { kind: 'github', owner: 'a' } },
    { tracker: { kind: 'github', owner: 'a', repo: 'b', status: { done: { label: 'x' } } } },
    { codeHost: { kind: 'github', owner: 'a', pullRequests: 'yes', repo: 'b' } },
    { codeHost: { kind: 'github', owner: 'a', repo: 'b', webhookSecretEnv: 'lower case' } },
  ]) {
    assert.equal(parseFactoryConfig({ models, ...bad }).kind, 'error', JSON.stringify(bad));
  }
});

test('worktree setup takes commands with a ten-minute default timeout', () => {
  const parsed = parseFactoryConfig({
    models,
    worktree: { setup: [{ argv: ['pnpm', 'install', '--frozen-lockfile'], name: 'install' }] },
  });
  assert.equal(parsed.kind, 'ok');
  if (parsed.kind !== 'ok') {
    return;
  }
  assert.deepEqual(parsed.config.worktree.setup, [
    {
      argv: ['pnpm', 'install', '--frozen-lockfile'],
      name: 'install',
      timeoutMs: DEFAULT_SETUP_TIMEOUT_MS,
    },
  ]);
  const none = parseFactoryConfig({ models });
  assert.deepEqual(none.kind === 'ok' ? none.config.worktree.setup : null, []);
  for (const worktree of [{ setup: [{ argv: [], name: 'x' }] }, { setup: 'pnpm install' }, 'x']) {
    assert.equal(parseFactoryConfig({ models, worktree }).kind, 'error', JSON.stringify(worktree));
  }
});
