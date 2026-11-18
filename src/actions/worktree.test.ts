import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setUpWorktree } from './worktree.ts';

test('worktree setup reports each command as it starts', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'factory-setup-report-'));
  const reported: Array<string> = [];
  const commands = ['install', 'build'].map((name) => ({
    argv: ['node', '-e', ''],
    name,
    timeoutMs: 10_000,
  }));
  assert.deepEqual(
    await setUpWorktree(commands, dir, (progress) => {
      reported.push(
        progress === null ? 'none' : `${progress.command} ${progress.index}/${progress.total}`,
      );
    }),
    { kind: 'ready' },
  );
  assert.deepEqual(reported, ['install 1/2', 'build 2/2']);
  rmSync(dir, { force: true, recursive: true });
});
