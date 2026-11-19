import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { binaryAsset, installRelease, previousPath, type Download } from './install.ts';

// A directory with a running "binary" in it.
function installedBinary(): { binary: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-install-'));
  const binary = path.join(dir, 'factory');
  writeFileSync(binary, 'old binary');
  chmodSync(binary, 0o755);
  return { binary, dir };
}

// A release whose asset holds `content`, and whose checksum is of `sumOf`.
function release(content: string, sumOf = content): { calls: Array<string>; download: Download } {
  const calls: Array<string> = [];
  return {
    calls,
    download: async ({ asset, dir, tag }) => {
      calls.push(`${tag} ${asset}`);
      writeFileSync(path.join(dir, asset), content);
      const sum = createHash('sha256').update(sumOf).digest('hex');
      writeFileSync(path.join(dir, `${asset}.sha256`), `${sum}  ${asset}\n`);
    },
  };
}

const machine = { arch: 'arm64', platform: 'linux' };

test('releases carry Linux arm64 and x64 binaries only', () => {
  assert.deepEqual(binaryAsset({ arch: 'x64', platform: 'linux' }), {
    asset: 'factory-linux-x64',
    kind: 'ok',
  });
  assert.equal(binaryAsset({ arch: 'arm64', platform: 'darwin' }).kind, 'error');
});

test('an update swaps the binary in and keeps the replaced one as factory.previous', async () => {
  const { binary, dir } = installedBinary();
  const { calls, download } = release('new binary');
  assert.deepEqual(await installRelease({ ...machine, binary, download, version: '0.6.0' }), {
    kind: 'installed',
  });
  assert.deepEqual(calls, ['v0.6.0 factory-linux-arm64']);
  assert.equal(readFileSync(binary, 'utf8'), 'new binary');
  assert.equal(readFileSync(previousPath(binary), 'utf8'), 'old binary');
  assert.equal(previousPath(binary), path.join(dir, 'factory.previous'));
  // The download directory is gone.
  assert.deepEqual(readdirSync(dir).toSorted(), ['factory', 'factory.previous']);
});

test('a binary that fails its checksum is refused and nothing changes', async () => {
  const { binary, dir } = installedBinary();
  const { download } = release('tampered binary', 'new binary');
  const result = await installRelease({ ...machine, binary, download, version: '0.6.0' });
  assert.equal(result.kind, 'error');
  assert.match(result.kind === 'error' ? result.message : '', /does not match its checksum/);
  assert.equal(readFileSync(binary, 'utf8'), 'old binary');
  assert.deepEqual(readdirSync(dir), ['factory']);
});

test('a failed download changes nothing', async () => {
  const { binary, dir } = installedBinary();
  const result = await installRelease({
    ...machine,
    binary,
    download: () => Promise.reject(new Error('HTTP 404')),
    version: '0.6.0',
  });
  assert.match(
    result.kind === 'error' ? result.message : '',
    /Cannot download factory 0\.6\.0: HTTP 404/,
  );
  assert.deepEqual(readdirSync(dir), ['factory']);
});
