import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changedPaths, diffFiles, diffPaths } from './diff.ts';

test('a diff’s files come from its headers, both sides of a rename', () => {
  const diff = [
    'diff --git a/AGENTS.md b/AGENTS.md',
    'index 1..2 100644',
    '--- a/AGENTS.md',
    '+++ b/AGENTS.md',
    '@@ -1 +1 @@',
    '-diff --git a/not/a/header b/not/a/header',
    'diff --git a/CLAUDE.md b/docs/CLAUDE.md',
    'similarity index 100%',
    'rename from CLAUDE.md',
    'rename to docs/CLAUDE.md',
    'diff --git a/src/a.ts b/src/a.ts',
  ].join('\n');
  assert.deepEqual(diffFiles(diff), [
    { from: 'AGENTS.md', to: 'AGENTS.md' },
    { from: 'CLAUDE.md', to: 'docs/CLAUDE.md' },
    { from: 'src/a.ts', to: 'src/a.ts' },
  ]);
  assert.deepEqual(diffPaths(diff), ['AGENTS.md', 'CLAUDE.md', 'docs/CLAUDE.md', 'src/a.ts']);
  assert.deepEqual(changedPaths(diff), ['AGENTS.md', 'docs/CLAUDE.md', 'src/a.ts']);
});

test('a path holding " b/" is read whole', () => {
  const diff = [
    'diff --git a/notes/a b/c.md b/notes/a b/c.md',
    'diff --git a/x b/y.md b/z b/w.md',
    'rename from x b/y.md',
    'rename to z b/w.md',
  ].join('\n');
  assert.deepEqual(diffFiles(diff), [
    { from: 'notes/a b/c.md', to: 'notes/a b/c.md' },
    { from: 'x b/y.md', to: 'z b/w.md' },
  ]);
});
