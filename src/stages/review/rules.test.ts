import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  changedRules,
  isRulePath,
  outsideDirectories,
  ruleCandidates,
  ruleDirectories,
  rulesSource,
} from './rules.ts';

// A worktree where the factory puts it: inside the code root's factory root.
const nested = { codeRoot: '/home/me/app', worktree: '/home/me/app/.factory/worktrees/eng-42' };
// A worktree beside the code root, outside it.
const beside = { codeRoot: '/home/me/app', worktree: '/home/me/trees/eng-42' };

test('the rules inside the code root are the repository root’s and those of the directories down to the worktree', () => {
  assert.deepEqual(ruleDirectories(nested), ['', '.factory', '.factory/worktrees']);
  assert.deepEqual(ruleDirectories(beside), ['']);
  assert.deepEqual(outsideDirectories(nested), ['/', '/home', '/home/me']);
  assert.deepEqual(outsideDirectories(beside), ['/', '/home', '/home/me', '/home/me/trees']);
  assert.deepEqual(ruleCandidates(beside), [
    'AGENTS.override.md',
    'AGENTS.md',
    'AGENTS.MD',
    'CLAUDE.md',
    'CLAUDE.MD',
  ]);
});

test('a changed rule file is any context file name Pi would read, nested ones aside, or a .pi prompt file', () => {
  assert.deepEqual(
    changedRules(nested, [
      'src/filter.ts',
      'CLAUDE.md',
      'AGENTS.override.md',
      '.factory/AGENTS.md',
      'docs/AGENTS.md',
      '.pi/APPEND_SYSTEM.md',
      '.pi/settings.json',
    ]),
    ['.pi/APPEND_SYSTEM.md', 'AGENTS.override.md', 'CLAUDE.md', '.factory/AGENTS.md'],
  );
  assert.deepEqual(changedRules(nested, ['src/filter.ts']), []);
  assert.ok(isRulePath('docs/AGENTS.md'));
  assert.ok(isRulePath('.pi/SYSTEM.md'));
  assert.ok(!isRulePath('docs/.pi/SYSTEM.md'));
  assert.ok(!isRulePath('src/filter.ts'));
});

test('the rules’ source names the base branch and short SHA', () => {
  const sha = '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b';
  assert.equal(rulesSource({ branch: 'main', sha }), 'main at 1a2b3c4');
  assert.equal(rulesSource({ branch: null, sha }), 'the base commit 1a2b3c4');
});
