import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { type FingerprintInput, SCRIPTS_DIR, workFingerprint } from './fingerprint.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

function git(cwd: string, args: Array<string>): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_EMAIL: 'factory@example.com',
      GIT_AUTHOR_NAME: 'Factory',
      GIT_COMMITTER_EMAIL: 'factory@example.com',
      GIT_COMMITTER_NAME: 'Factory',
    },
  });
  if (result.status !== 0) {
    throw new Error(result.stderr);
  }
  return result.stdout.trim();
}

// A worktree with a change in progress, and a factory root with a script.
function setup(): FingerprintInput {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-fingerprint-'));
  dirs.push(root);
  const worktree = path.join(root, 'tree');
  mkdirSync(worktree);
  git(worktree, ['init', '-qb', 'main']);
  writeFileSync(path.join(worktree, 'a.ts'), 'one\n');
  writeFileSync(path.join(worktree, 'gone.ts'), 'gone\n');
  writeFileSync(path.join(worktree, '.gitignore'), 'node_modules/\n');
  git(worktree, ['add', '.']);
  git(worktree, ['commit', '-qm', 'base']);
  writeFileSync(path.join(worktree, 'a.ts'), 'two\n');
  const factoryRoot = path.join(root, 'factory');
  mkdirSync(path.join(factoryRoot, SCRIPTS_DIR), { recursive: true });
  writeFileSync(path.join(factoryRoot, SCRIPTS_DIR, 'validate.sh'), 'npm test\n');
  return {
    base: git(worktree, ['rev-parse', 'HEAD']),
    commands: [{ argv: ['npm', 'test'], name: 'tests', timeoutMs: 1000 }],
    executionId: 'execution-1',
    factoryRoot,
    selection: [],
    validatorVersion: 'work.v1',
    version: '0.6.11',
    worktree,
  };
}

function print(input: FingerprintInput): string {
  const found = workFingerprint(input);
  assert.ok('fingerprint' in found, JSON.stringify(found));
  return found.fingerprint;
}

test('the same inputs hash the same; staging a change does not change what the commands see', () => {
  const input = setup();
  const first = print(input);
  assert.equal(print(input), first);
  git(input.worktree, ['add', 'a.ts']);
  assert.equal(print(input), first);
});

test('every input the commands depend on changes the hash', () => {
  const input = setup();
  const first = print(input);
  const changes: Array<[string, () => FingerprintInput]> = [
    [
      'an edit',
      () => {
        writeFileSync(path.join(input.worktree, 'a.ts'), 'three\n');
        return input;
      },
    ],
    [
      'a new untracked file',
      () => {
        writeFileSync(path.join(input.worktree, 'new.ts'), 'new\n');
        return input;
      },
    ],
    [
      'a deletion',
      () => {
        unlinkSync(path.join(input.worktree, 'gone.ts'));
        return input;
      },
    ],
    [
      "a change to the factory root's scripts",
      () => {
        writeFileSync(path.join(input.factoryRoot, SCRIPTS_DIR, 'validate.sh'), 'npm run all\n');
        return input;
      },
    ],
    [
      'another selection',
      () => ({ ...input, selection: [{ path: 'a.test.ts', reason: 'covers it' }] }),
    ],
    [
      'other commands',
      () => ({
        ...input,
        commands: [{ argv: ['npm', 'run', 'all'], name: 'tests', timeoutMs: 1000 }],
      }),
    ],
    ['another base', () => ({ ...input, base: 'f'.repeat(40) })],
    ['another validator', () => ({ ...input, validatorVersion: 'work.v2' })],
    ['another factory version', () => ({ ...input, version: '0.7.0' })],
    ['another execution', () => ({ ...input, executionId: 'execution-2' })],
  ];
  let previous = first;
  for (const [what, change] of changes) {
    const now = print(change());
    assert.notEqual(now, previous, what);
    previous = now;
  }
});

test('ignored files are not inputs; a worktree git cannot read has no fingerprint', () => {
  const input = setup();
  const first = print(input);
  mkdirSync(path.join(input.worktree, 'node_modules'));
  writeFileSync(path.join(input.worktree, 'node_modules', 'dep.js'), 'x\n');
  assert.equal(print(input), first);
  assert.ok(
    'error' in workFingerprint({ ...input, worktree: path.join(input.factoryRoot, 'none') }),
  );
});
