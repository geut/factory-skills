import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  allowsEmptyDiff,
  DEFAULT_COMMAND_TIMEOUT_MS,
  DEFAULT_SERVER,
  DEFAULT_SETUP_TIMEOUT_MS,
  parseFactoryConfig,
  pullRequestsAllowed,
  readFactoryConfig,
  writeCommunication,
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
  // Feedback rounds take collaborators' feedback, and listed authors' too.
  assert.deepEqual(parsed.config.codeHost?.feedbackAuthors, []);
  const listed = parseFactoryConfig({
    codeHost: {
      feedback: { authors: [' coderabbitai ', 'copilot-pull-request-reviewer'] },
      kind: 'github',
      owner: 'geut',
      repo: 'factory-skills',
    },
    models,
  });
  assert.deepEqual(listed.kind === 'ok' ? listed.config.codeHost?.feedbackAuthors : null, [
    'coderabbitai',
    'copilot-pull-request-reviewer',
  ]);

  const bare = parseFactoryConfig({ models });
  assert.equal(bare.kind === 'ok' && pullRequestsAllowed(bare.config), true);

  for (const bad of [
    { tracker: { kind: 'jira', owner: 'a', repo: 'b' } },
    { tracker: { kind: 'github', owner: 'a' } },
    { tracker: { kind: 'github', owner: 'a', repo: 'b', status: { done: { label: 'x' } } } },
    { codeHost: { kind: 'github', owner: 'a', pullRequests: 'yes', repo: 'b' } },
    { codeHost: { kind: 'github', owner: 'a', repo: 'b', webhookSecretEnv: 'lower case' } },
    { codeHost: { feedback: { authors: 'coderabbitai' }, kind: 'github', owner: 'a', repo: 'b' } },
    { codeHost: { feedback: { authors: [''] }, kind: 'github', owner: 'a', repo: 'b' } },
    { codeHost: { feedback: [], kind: 'github', owner: 'a', repo: 'b' } },
  ]) {
    assert.equal(parseFactoryConfig({ models, ...bad }).kind, 'error', JSON.stringify(bad));
  }
});

test('codeHost takes a pull request title template, unset by default', () => {
  const place = { kind: 'github', owner: 'geut', repo: 'factory-skills' };
  const codeHostOf = (extra: Record<string, unknown>) => {
    const parsed = parseFactoryConfig({ codeHost: { ...place, ...extra }, models });
    return parsed.kind === 'ok' ? parsed.config.codeHost : parsed.message;
  };
  const bare = codeHostOf({});
  assert.equal(typeof bare === 'object' && bare?.pullRequestTitle, null);
  // GitHub trims titles, so the template is trimmed too.
  const set = codeHostOf({ pullRequestTitle: ' {ref} | {summary} ' });
  assert.equal(typeof set === 'object' && set?.pullRequestTitle, '{ref} | {summary}');
  // A template without {summary} names the setting.
  assert.match(
    String(codeHostOf({ pullRequestTitle: '{ref}' })),
    /codeHost\.pullRequestTitle .*\{summary\} once/,
  );
  assert.match(String(codeHostOf({ pullRequestTitle: '{key}: {summary}' })), /\{key\}/);
  assert.match(String(codeHostOf({ pullRequestTitle: 7 })), /codeHost\.pullRequestTitle/);
});

test('tracker updates default to on, each can be turned off, and anything else is refused', () => {
  const github = { kind: 'github', owner: 'geut', repo: 'factory-skills' };
  const updatesOf = (updates?: unknown) => {
    const parsed = parseFactoryConfig({
      models,
      tracker: updates === undefined ? github : { ...github, updates },
    });
    return parsed.kind === 'ok' ? parsed.config.tracker?.updates : parsed.message;
  };
  assert.deepEqual(updatesOf(), { checklist: true, comments: true });
  assert.deepEqual(updatesOf({}), { checklist: true, comments: true });
  assert.deepEqual(updatesOf({ comments: false }), { checklist: true, comments: false });
  assert.deepEqual(updatesOf({ checklist: false }), { checklist: false, comments: true });
  for (const bad of [true, [], { comments: 'no' }, { status: false }]) {
    assert.match(
      String(updatesOf(bad)),
      /tracker.updates takes comments and checklist, each true or false/,
      JSON.stringify(bad),
    );
  }
});

// What FACTORY.json's `updates` block parses to, or why it is refused.
function checkOf(updates?: unknown) {
  const parsed = parseFactoryConfig(updates === undefined ? { models } : { models, updates });
  return parsed.kind === 'ok' ? parsed.config.updates.check : parsed.message;
}

test('update checks default to on, turn off with check false, and refuse anything else', () => {
  assert.equal(checkOf(), true);
  assert.equal(checkOf({}), true);
  assert.equal(checkOf({ check: false }), false);
  for (const bad of [false, { check: 'no' }, { channel: 'beta' }]) {
    assert.match(String(checkOf(bad)), /updates takes only check/, JSON.stringify(bad));
  }
});

test('a Linear tracker takes a team, backlog state types, and workflow state names', () => {
  const parsed = parseFactoryConfig({
    models,
    tracker: {
      backlog: { labels: ['factory'], project: 'Catalog' },
      kind: 'linear',
      status: { in_review: { state: 'In Review' } },
      team: 'ENG',
    },
  });
  assert.equal(parsed.kind, 'ok');
  assert.deepEqual(parsed.kind === 'ok' ? parsed.config.tracker : null, {
    apiKeyEnv: 'LINEAR_API_KEY',
    backlog: { labels: ['factory'], project: 'Catalog', states: ['backlog', 'unstarted'] },
    kind: 'linear',
    status: { in_review: { state: 'In Review' } },
    team: 'ENG',
    updates: { checklist: true, comments: true },
  });
  const custom = parseFactoryConfig({
    models,
    tracker: {
      apiKeyEnv: 'ACME_LINEAR',
      backlog: { states: ['triage'] },
      kind: 'linear',
      team: 'ENG',
    },
  });
  assert.equal(
    custom.kind === 'ok' &&
      custom.config.tracker?.kind === 'linear' &&
      custom.config.tracker.apiKeyEnv,
    'ACME_LINEAR',
  );

  for (const [bad, message] of [
    [{ kind: 'linear' }, /needs team/],
    [{ kind: 'jira', team: 'ENG' }, /tracker.kind must be github or linear/],
    [{ apiKeyEnv: 'lower case', kind: 'linear', team: 'ENG' }, /apiKeyEnv must name/],
    [{ backlog: { states: ['open'] }, kind: 'linear', team: 'ENG' }, /workflow state types/],
    [{ backlog: { states: [] }, kind: 'linear', team: 'ENG' }, /workflow state types/],
    [
      { kind: 'linear', status: { in_review: { label: 'x' } }, team: 'ENG' },
      /"state": "<workflow state name>"/,
    ],
  ] as const) {
    const result = parseFactoryConfig({ models, tracker: bad });
    assert.match(result.kind === 'error' ? result.message : 'parsed', message, JSON.stringify(bad));
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

test('FACTORY.json communication reads with defaults, and a bad value stops the config', () => {
  const read = parseFactoryConfig({ models });
  assert.deepEqual(read.kind === 'ok' ? read.config.communication : read.message, {
    tone: 'succinct, technical, to the point',
    verbosity: 'full',
    voice: 'factory',
  });
  const bad = parseFactoryConfig({ communication: { voice: 'robot' }, models });
  assert.equal(
    bad.kind === 'error' ? bad.message : 'parsed',
    'FACTORY.json communication.voice must be one of factory, developer.',
  );
});

const minimal = { tone: 'dry', verbosity: 'minimal', voice: 'developer' } as const;

function factoryRoot(text: string) {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-config-'));
  const file = path.join(root, 'FACTORY.json');
  writeFileSync(file, text);
  return { file, root };
}

test('writing communication changes only that block; every other byte stays', () => {
  const { file, root } = factoryRoot(
    '{\n\t"name": "catalog",\n\t"communication": {\n\t\t"verbosity": "full"\n\t},\n\t"server": { "host": "127.0.0.1", "port": 7731 },\n\t"models": { "review": "review-model", "work": "work-model" }\n}\n',
  );
  assert.equal(writeCommunication(root, minimal).kind, 'ok');
  assert.equal(
    readFileSync(file, 'utf8'),
    '{\n\t"name": "catalog",\n\t"communication": { "verbosity": "minimal", "voice": "developer", "tone": "dry" },\n\t"server": { "host": "127.0.0.1", "port": 7731 },\n\t"models": { "review": "review-model", "work": "work-model" }\n}\n',
  );
  const reread = readFactoryConfig(root);
  assert.equal(reread.kind === 'ok' ? reread.config.communication.voice : null, 'developer');
  assert.deepEqual(readdirSync(root), ['FACTORY.json']);
  rmSync(root, { force: true, recursive: true });
});

test('a FACTORY.json without communication gets it as its last key', () => {
  const { file, root } = factoryRoot(
    '{\n  "name": "a \\"communication\\": {} name",\n  "models": { "review": "r", "work": "w" }\n}\n',
  );
  assert.equal(writeCommunication(root, minimal).kind, 'ok');
  assert.equal(
    readFileSync(file, 'utf8'),
    '{\n  "name": "a \\"communication\\": {} name",\n  "models": { "review": "r", "work": "w" },\n  "communication": { "verbosity": "minimal", "voice": "developer", "tone": "dry" }\n}\n',
  );
  rmSync(root, { force: true, recursive: true });
});

test('refused settings, or a FACTORY.json that would not parse, change nothing', () => {
  const broken = '{ "models": { "work": "same", "review": "same" } }\n';
  const { file, root } = factoryRoot(broken);
  assert.equal(writeCommunication(root, minimal).kind, 'error');
  assert.equal(readFileSync(file, 'utf8'), broken);
  const refused = writeCommunication(root, { ...minimal, voice: 'robot' });
  assert.match(refused.kind === 'error' ? refused.message : '', /Invalid communication settings/);
  assert.equal(readFileSync(file, 'utf8'), broken);
  rmSync(root, { force: true, recursive: true });
});

test('a write that fails throws, leaves FACTORY.json as it was, and no temporary file', () => {
  const original = '{ "models": { "review": "r", "work": "w" } }\n';
  const { file, root } = factoryRoot(original);
  chmodSync(root, 0o555);
  try {
    assert.throws(() => writeCommunication(root, minimal), /EACCES/);
  } finally {
    chmodSync(root, 0o755);
  }
  assert.equal(readFileSync(file, 'utf8'), original);
  assert.deepEqual(readdirSync(root), ['FACTORY.json']);
  rmSync(root, { force: true, recursive: true });
});
