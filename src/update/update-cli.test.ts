import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { Download } from './install.ts';
import { runUpdateCommand, type ServerUpdate } from './update-cli.ts';
import { SOURCE_RUN_MESSAGE } from './updater.ts';

const one = async () => [
  {
    draft: false,
    html_url: 'https://github.com/geut/factory-skills/releases/tag/v0.5.0',
    name: 'v0.5.0',
    prerelease: false,
    tag_name: 'v0.5.0',
  },
];

const download: Download = async ({ asset, dir }) => {
  writeFileSync(path.join(dir, asset), 'new binary');
  const sum = createHash('sha256').update('new binary').digest('hex');
  writeFileSync(path.join(dir, `${asset}.sha256`), `${sum}  ${asset}\n`);
};

async function run(
  args: Array<string>,
  input: {
    binary?: string | null;
    gh?: () => Promise<unknown>;
    server?: ServerUpdate | null;
  } = {},
) {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const code = await runUpdateCommand(
    args,
    { err: (line) => err.push(line), out: (line) => out.push(line) },
    {
      arch: 'x64',
      binary: input.binary ?? null,
      current: '0.4.0+1ddf4f6',
      download,
      gh: input.gh ?? one,
      platform: 'linux',
      server: input.server ?? null,
    },
  );
  return { code, err, out };
}

test('factory update --check says what is newer and where to read about it', async () => {
  assert.deepEqual(await run(['--check']), {
    code: 0,
    err: [],
    out: [
      'factory 0.5.0 is available (you run 0.4.0).',
      "What's new: https://github.com/geut/factory-skills/releases/tag/v0.5.0",
    ],
  });
  assert.deepEqual((await run(['--check'], { gh: async () => [] })).out, [
    'factory 0.4.0 is the newest release.',
  ]);
});

test('a check that fails exits 1 with why, and other arguments print the usage', async () => {
  const failed = await run(['--check'], { gh: () => Promise.reject(new Error('gh: not found')) });
  assert.equal(failed.code, 1);
  assert.match(failed.err.join('\n'), /gh: not found/);
  assert.equal((await run(['--now'])).code, 2);
});

test('with a server running, factory update hands off to it', async () => {
  const asked: Array<string> = [];
  const server: ServerUpdate = async (mode) => {
    asked.push(mode);
    return { kind: 'text', text: 'Installed factory 0.5.0; a new server starts on it.' };
  };
  assert.deepEqual(await run([], { server }), {
    code: 0,
    err: [],
    out: ['Installed factory 0.5.0; a new server starts on it.'],
  });
  await run(['--when-idle'], { server });
  assert.deepEqual(asked, ['install', 'when-idle']);
  const refused = await run([], { server: async () => ({ kind: 'problem', text: 'busy' }) });
  assert.deepEqual({ code: refused.code, err: refused.err }, { code: 1, err: ['busy'] });
});

test('with no server, factory update swaps the binary for the next factory serve', async () => {
  const binary = path.join(mkdtempSync(path.join(tmpdir(), 'factory-cli-')), 'factory');
  writeFileSync(binary, 'old binary');
  chmodSync(binary, 0o755);
  const result = await run([], { binary });
  assert.equal(result.code, 0);
  assert.equal(result.out[0], 'Installed factory 0.5.0; the next factory serve runs it.');
  assert.equal(readFileSync(binary, 'utf8'), 'new binary');
  assert.equal(readFileSync(`${binary}.previous`, 'utf8'), 'old binary');
});

test('a source run with no server says to use git pull', async () => {
  assert.deepEqual(await run([]), { code: 1, err: [SOURCE_RUN_MESSAGE], out: [] });
});
