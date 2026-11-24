import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { ROUND_BASE_ENV, TARGET_BRANCH_ENV, TICKET_BASE_ENV } from './bases.ts';
import {
  commandEnv,
  ensureValidationLogs,
  VALIDATION_LOGS,
  VALIDATION_LOGS_ENV,
} from './command-env.ts';
import { SELECTION_ENV } from './selection.ts';

const dirs: Array<string> = [];
const bases = { roundBase: 'b'.repeat(40), targetBranch: 'main', ticketBase: 'a'.repeat(40) };
after(() => {
  for (const dir of dirs) {
    rmSync(dir, { force: true, recursive: true });
  }
});

test('each command gets a fresh environment: where to log, and the selection only when there is one', () => {
  const before = process.env[SELECTION_ENV];
  // Set when Factory validates this repository: the server may run in a
  // validation command itself.
  const inheritedLogs = process.env[VALIDATION_LOGS_ENV];
  process.env[SELECTION_ENV] = 'left over from the server';
  try {
    const tests = [{ path: 'tests/a.test.ts', reason: 'covers it' }];
    const env = commandEnv({ bases, factoryRoot: '/repo/.factory', tests });
    assert.notEqual(env, process.env);
    assert.deepEqual(JSON.parse(env[SELECTION_ENV] ?? ''), { tests, version: 1 });
    assert.equal(env[VALIDATION_LOGS_ENV], `/repo/.factory/${VALIDATION_LOGS}`);
    assert.equal(env['PATH'], process.env['PATH']);
    const without = commandEnv({ bases, factoryRoot: '/repo/.factory', tests: null });
    assert.equal(SELECTION_ENV in without, false);
    assert.equal(without[VALIDATION_LOGS_ENV], `/repo/.factory/${VALIDATION_LOGS}`);
    assert.equal(
      SELECTION_ENV in commandEnv({ bases, factoryRoot: '/repo/.factory', tests: [] }),
      false,
    );
    // The server's own environment is never changed.
    assert.equal(process.env[VALIDATION_LOGS_ENV], inheritedLogs);
  } finally {
    if (before === undefined) {
      delete process.env[SELECTION_ENV];
    } else {
      process.env[SELECTION_ENV] = before;
    }
  }
});

test("each command gets its own ticket's comparison commits, never the server's", () => {
  const saved = Object.fromEntries(
    [TICKET_BASE_ENV, ROUND_BASE_ENV, TARGET_BRANCH_ENV].map((name) => [name, process.env[name]]),
  );
  // The server may run inside a pane or command that has them already.
  process.env[TICKET_BASE_ENV] = 'from the server';
  process.env[TARGET_BRANCH_ENV] = 'from the server';
  try {
    const env = commandEnv({ bases, factoryRoot: '/repo/.factory', tests: null });
    assert.equal(env[TICKET_BASE_ENV], bases.ticketBase);
    assert.equal(env[ROUND_BASE_ENV], bases.roundBase);
    assert.equal(env[TARGET_BRANCH_ENV], 'main');
    // A ticket whose target branch is unknown gets none, not the server's.
    const unknown = commandEnv({
      bases: { ...bases, targetBranch: null },
      factoryRoot: '/repo/.factory',
      tests: null,
    });
    assert.equal(TARGET_BRANCH_ENV in unknown, false);
    // Two tickets at once: each object holds only its own.
    const other = commandEnv({
      bases: { roundBase: 'd'.repeat(40), targetBranch: 'release', ticketBase: 'c'.repeat(40) },
      factoryRoot: '/repo/.factory',
      tests: null,
    });
    assert.equal(env[TICKET_BASE_ENV], bases.ticketBase);
    assert.equal(other[TICKET_BASE_ENV], 'c'.repeat(40));
    assert.equal(other[TARGET_BRANCH_ENV], 'release');
    assert.equal(process.env[TICKET_BASE_ENV], 'from the server');
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  }
});

test('the logs directory is made private in a factory root that exists, and nowhere else', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-logs-'));
  dirs.push(root);
  ensureValidationLogs(root);
  assert.equal(statSync(path.join(root, VALIDATION_LOGS)).mode & 0o777, 0o700);
  // One a validator made first keeps its mode.
  const shared = mkdtempSync(path.join(tmpdir(), 'factory-logs-'));
  dirs.push(shared);
  mkdirSync(path.join(shared, VALIDATION_LOGS));
  chmodSync(path.join(shared, VALIDATION_LOGS), 0o750);
  ensureValidationLogs(shared);
  assert.equal(statSync(path.join(shared, VALIDATION_LOGS)).mode & 0o777, 0o750);
  const missing = path.join(root, 'no-such-root');
  ensureValidationLogs(missing);
  assert.equal(existsSync(missing), false);
});
