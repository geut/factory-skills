import assert from 'node:assert/strict';
import { test } from 'node:test';
import { runUpdateCommand } from './update-cli.ts';

async function run(args: Array<string>, gh: () => Promise<unknown>) {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const code = await runUpdateCommand(
    args,
    { err: (line) => err.push(line), out: (line) => out.push(line) },
    { current: '0.4.0+1ddf4f6', gh },
  );
  return { code, err, out };
}

const one = async () => [
  {
    draft: false,
    html_url: 'https://github.com/geut/factory-skills/releases/tag/v0.5.0',
    name: 'v0.5.0',
    prerelease: false,
    tag_name: 'v0.5.0',
  },
];

test('factory update --check says what is newer and where to read about it', async () => {
  assert.deepEqual(await run(['--check'], one), {
    code: 0,
    err: [],
    out: [
      'factory 0.5.0 is available (you run 0.4.0).',
      "What's new: https://github.com/geut/factory-skills/releases/tag/v0.5.0",
    ],
  });
  assert.deepEqual((await run(['--check'], async () => [])).out, [
    'factory 0.4.0 is the newest release.',
  ]);
});

test('a check that fails exits 1 with why, and other arguments print the usage', async () => {
  const failed = await run(['--check'], () => Promise.reject(new Error('gh: not found')));
  assert.equal(failed.code, 1);
  assert.match(failed.err.join('\n'), /gh: not found/);
  assert.equal((await run(['--now'], one)).code, 2);
  assert.equal((await run([], one)).code, 1);
});
