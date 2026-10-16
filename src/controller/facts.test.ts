import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { openStateDatabase } from '../state/database.ts';
import { factoryIdentity, recordCommit, recordPullRequest, recordReview } from './facts.ts';

const roots: Array<string> = [];
const dbs: Array<DatabaseSync> = [];

afterEach(() => {
  for (const db of dbs.splice(0)) {
    db.close();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function database(): DatabaseSync {
  const root = mkdtempSync(path.join(tmpdir(), 'factory-facts-'));
  roots.push(root);
  const db = openStateDatabase(root, { create: true });
  dbs.push(db);
  db.exec(`
    INSERT INTO tickets (id, title, source_kind) VALUES ('t1', 'Ticket', 'github');
    INSERT INTO ticket_executions (id, ticket_id, generation, stage, status, factory_dir)
      VALUES ('e1', 't1', 1, 'wrapup', 'ready_for_handoff', '/f/t1');
  `);
  return db;
}

test('every factory gets its own id when its database is created', () => {
  const first = factoryIdentity(database()).factoryId;
  const second = factoryIdentity(database()).factoryId;
  assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.notEqual(first, second);
});

test('pull request facts upsert by their ids and keep what a later write leaves out', () => {
  const db = database();
  const base = {
    author: 'dpaez',
    closedAt: null,
    executionId: 'e1',
    headBranch: 'factory/t1',
    mergedAt: null,
    number: 7,
    openedAt: '2026-10-15T10:00:00.000Z',
    state: 'open' as const,
    url: 'https://github.com/geut/factory-skills/pull/7',
  };
  recordPullRequest(db, base, '2026-10-15T10:00:00.000Z');
  recordPullRequest(
    db,
    { ...base, author: null, mergedAt: '2026-10-16T09:00:00.000Z', state: 'merged' },
    '2026-10-16T09:00:00.000Z',
  );
  assert.deepEqual(
    { ...db.prepare('SELECT author, state, merged_at FROM pull_requests').get() },
    { author: 'dpaez', merged_at: '2026-10-16T09:00:00.000Z', state: 'merged' },
  );

  const review = {
    author: 'coderabbit',
    authorType: 'bot' as const,
    commitSha: 'abc',
    executionId: 'e1',
    hasBody: true,
    reviewId: 'R_1',
    state: 'commented' as const,
    submittedAt: '2026-10-15T11:00:00.000Z',
  };
  recordReview(db, review);
  recordReview(db, { ...review, state: 'dismissed' });
  recordCommit(db, { committedAt: null, executionId: 'e1', sha: 'abc' });
  recordCommit(db, { committedAt: '2026-10-15T10:30:00.000Z', executionId: 'e1', sha: 'abc' });
  assert.equal(db.prepare('SELECT count(*) AS n FROM pull_request_reviews').get()?.['n'], 1);
  assert.equal(db.prepare('SELECT state FROM pull_request_reviews').get()?.['state'], 'dismissed');
  assert.equal(
    db.prepare('SELECT committed_at FROM pull_request_commits').get()?.['committed_at'],
    '2026-10-15T10:30:00.000Z',
  );
});
