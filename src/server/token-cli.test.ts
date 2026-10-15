import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, test } from 'node:test';
import { openStateDatabase } from '../state/database.ts';
import { authenticate } from './clients.ts';
import { runTokenCommand } from './token-cli.ts';

const roots: Array<string> = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function repository(): string {
  const cwd = mkdtempSync(path.join(tmpdir(), 'factory-token-'));
  roots.push(cwd);
  mkdirSync(path.join(cwd, '.factory'));
  return cwd;
}

function run(cwd: string, ...args: Array<string>) {
  const out: Array<string> = [];
  const err: Array<string> = [];
  const code = runTokenCommand(args, cwd, {
    err: (line) => err.push(line),
    out: (line) => out.push(line),
  });
  return { code, err: err.join('\n'), out: out.join('\n') };
}

test('token create prints only the token, list shows it, and revoke ends it', () => {
  const cwd = repository();
  const created = run(cwd, 'create', 'dashboard', '--scope', 'act');
  assert.equal(created.code, 0);
  assert.match(created.out, /^fct_\S+$/);
  assert.match(created.err, /not shown again/);

  const listed = run(cwd, 'list');
  assert.match(listed.out, /^dashboard\tact\tcreated .*\tlast used never$/);

  assert.equal(run(cwd, 'revoke', 'dashboard').code, 0);
  assert.match(run(cwd, 'list').out, /\trevoked$/);
  const db = openStateDatabase(path.join(cwd, '.factory'));
  assert.equal(authenticate(db, created.out, new Date().toISOString()), null);
  db.close();
});

test('token commands explain bad input', () => {
  const cwd = repository();
  assert.equal(run(cwd, 'create', 'dashboard').code, 2);
  assert.equal(run(cwd, 'create', 'dashboard', '--scope', 'admin').code, 2);
  assert.equal(run(cwd, 'revoke', 'nobody').code, 1);
  assert.equal(run(cwd, 'create', 'stats', '--scope=read').code, 0);
  assert.match(run(cwd, 'create', 'stats', '--scope=read').err, /already has a token/);

  const elsewhere = mkdtempSync(path.join(tmpdir(), 'factory-token-'));
  roots.push(elsewhere);
  assert.match(run(elsewhere, 'list').err, /No factory root/);
});
