import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { findRewrite, reflogHead } from './rewrite.ts';

const dirs: Array<string> = [];
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_EMAIL: 'factory@example.com',
  GIT_AUTHOR_NAME: 'Factory',
  GIT_COMMITTER_EMAIL: 'factory@example.com',
  GIT_COMMITTER_NAME: 'Factory',
  GIT_EDITOR: 'true',
};

function git(cwd: string, args: Array<string>, allowFail = false): string {
  const result = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
    env: gitEnv,
  });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function commit(cwd: string, file: string, text: string, message: string): string {
  writeFileSync(path.join(cwd, file), text);
  git(cwd, ['add', file]);
  git(cwd, ['commit', '-qm', message]);
  return git(cwd, ['rev-parse', 'HEAD']);
}

// A repository whose main has a file, and a ticket branch, handed off with
// one commit that edits its second line.
function handedOff() {
  const cwd = mkdtempSync(path.join(tmpdir(), 'factory-rewrite-'));
  dirs.push(cwd);
  git(cwd, ['init', '-qb', 'main']);
  commit(cwd, 'a.py', 'one\ntwo\nthree\n', 'base');
  git(cwd, ['checkout', '-qb', 'factory/t']);
  const handoff = commit(cwd, 'a.py', 'one\nticket\nthree\n', 'Ticket work');
  return { cwd, handoff };
}

// The target moves on: `file` with `text`.
function upstream(cwd: string, file: string, text: string): void {
  git(cwd, ['checkout', '-q', 'main']);
  commit(cwd, file, text, 'upstream');
  git(cwd, ['checkout', '-q', 'factory/t']);
}

test('commits on top of the handoff, as a round adds, are no rewrite', () => {
  const { cwd, handoff } = handedOff();
  commit(cwd, 'b.py', 'round\n', 'Round 1');
  assert.deepEqual(findRewrite({ previous: handoff, target: 'main', worktree: cwd }), {
    kind: 'none',
  });
});

test('a clean rebase onto a newer target, every commit the same change, is no rewrite', () => {
  const { cwd, handoff } = handedOff();
  upstream(cwd, 'other.py', 'other\n');
  git(cwd, ['rebase', '-q', 'main']);
  assert.notEqual(git(cwd, ['rev-parse', 'HEAD']), handoff);
  assert.deepEqual(findRewrite({ previous: handoff, target: 'main', worktree: cwd }), {
    kind: 'none',
  });
});

test('a rebase whose conflict was resolved by hand shows what the resolution changed', () => {
  const { cwd, handoff } = handedOff();
  upstream(cwd, 'a.py', 'one\nupstream\nthree\n');
  git(cwd, ['rebase', '-q', 'main'], true);
  writeFileSync(path.join(cwd, 'a.py'), 'one\nticket and upstream\nthree\n');
  git(cwd, ['add', 'a.py']);
  git(cwd, ['rebase', '--continue']);
  const found = findRewrite({ previous: handoff, target: 'main', worktree: cwd });
  assert.equal(found.kind, 'changed');
  if (found.kind !== 'changed') {
    return;
  }
  assert.match(
    found.summary,
    /the branch was rebased, and the rebase changed a commit: "Ticket work"\./,
  );
  assert.match(found.detail, /1:\s+[0-9a-f]+ ! 1:\s+[0-9a-f]+ Ticket work/);
  assert.match(found.detail, /ticket and upstream/);
});

test('a rebase that only re-indented a line is a rewrite too', () => {
  const { cwd, handoff } = handedOff();
  upstream(cwd, 'other.py', 'other\n');
  git(cwd, ['rebase', '-q', 'main']);
  writeFileSync(path.join(cwd, 'a.py'), 'one\n    ticket\nthree\n');
  git(cwd, ['commit', '-q', '--amend', '-a', '--no-edit']);
  assert.equal(findRewrite({ previous: handoff, target: 'main', worktree: cwd }).kind, 'changed');
});

test('the target merged in needs review only where the merge was resolved by hand', () => {
  const clean = handedOff();
  upstream(clean.cwd, 'other.py', 'other\n');
  git(clean.cwd, ['merge', '-q', '--no-edit', 'main']);
  assert.deepEqual(findRewrite({ previous: clean.handoff, target: 'main', worktree: clean.cwd }), {
    kind: 'none',
  });

  const resolved = handedOff();
  upstream(resolved.cwd, 'a.py', 'one\nupstream\nthree\n');
  git(resolved.cwd, ['merge', '-q', '--no-edit', 'main'], true);
  writeFileSync(path.join(resolved.cwd, 'a.py'), 'one\nboth\nthree\n');
  git(resolved.cwd, ['add', 'a.py']);
  git(resolved.cwd, ['commit', '-q', '--no-edit']);
  const found = findRewrite({ previous: resolved.handoff, target: 'main', worktree: resolved.cwd });
  assert.equal(found.kind, 'changed');
  if (found.kind !== 'changed') {
    return;
  }
  assert.match(found.summary, /a merge into the branch \(".*"\) changed the code by hand/);
  assert.match(found.detail, /\+both/);
});

test('a handoff commit the repository no longer has is a rewrite that cannot be shown', () => {
  const { cwd } = handedOff();
  const found = findRewrite({ previous: 'f'.repeat(40), target: 'main', worktree: cwd });
  assert.equal(found.kind, 'unknown');
});

test('for a ticket handed off before its head was kept, the reflog gives where the branch was', () => {
  const { cwd, handoff } = handedOff();
  upstream(cwd, 'other.py', 'other\n');
  git(cwd, ['rebase', '-q', 'main']);
  assert.equal(reflogHead(cwd, 'factory/t'), handoff);
});

test('with no target to read, a rebase cannot be compared, and is never reported as other commits', () => {
  const { cwd, handoff } = handedOff();
  upstream(cwd, 'other.py', 'other\n');
  git(cwd, ['rebase', '-q', 'main']);
  const found = findRewrite({ previous: handoff, target: null, worktree: cwd });
  assert.equal(found.kind, 'unknown');
  assert.match(found.kind === 'unknown' ? found.summary : '', /no remote can be chosen/);
  // Commits on top need no target, and stay no rewrite.
  commit(cwd, 'b.py', 'round\n', 'Round 1');
  const onTop = git(cwd, ['rev-parse', 'HEAD~1']);
  assert.deepEqual(findRewrite({ previous: onTop, target: null, worktree: cwd }), {
    kind: 'none',
  });
});

test('a merge git cannot show, as on a git without --remerge-diff, is never taken as clean', () => {
  const resolved = handedOff();
  upstream(resolved.cwd, 'a.py', 'one\nupstream\nthree\n');
  git(resolved.cwd, ['merge', '-q', '--no-edit', 'main'], true);
  writeFileSync(path.join(resolved.cwd, 'a.py'), 'one\nboth\nthree\n');
  git(resolved.cwd, ['add', 'a.py']);
  git(resolved.cwd, ['commit', '-q', '--no-edit']);
  // A git that does not know --remerge-diff, as before 2.36.
  const shims = mkdtempSync(path.join(tmpdir(), 'factory-git-shim-'));
  dirs.push(shims);
  const real = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(
    path.join(shims, 'git'),
    `#!/bin/sh\ncase " $* " in *" --remerge-diff "*) echo "fatal: unrecognized argument: --remerge-diff" >&2; exit 128;; esac\nexec ${JSON.stringify(real)} "$@"\n`,
    { mode: 0o755 },
  );
  const saved = process.env['PATH'];
  process.env['PATH'] = `${shims}${path.delimiter}${saved ?? ''}`;
  try {
    const found = findRewrite({
      previous: resolved.handoff,
      target: 'main',
      worktree: resolved.cwd,
    });
    assert.equal(found.kind, 'unknown');
    assert.match(
      found.kind === 'unknown' ? found.summary : '',
      /git cannot show what the merge changed by hand: fatal: unrecognized argument: --remerge-diff/,
    );
  } finally {
    process.env['PATH'] = saved;
  }
});
