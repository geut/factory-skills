import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, test } from 'node:test';
import { openStateDatabase } from '../state/database.ts';
import {
  acquireServerLease,
  LEASE_TTL_MS,
  readServerLease,
  releaseServerLease,
  renewServerLease,
} from './lease.ts';

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
  const root = mkdtempSync(path.join(tmpdir(), 'factory-lease-'));
  roots.push(root);
  const db = openStateDatabase(root, { create: true });
  dbs.push(db);
  return db;
}

const t0 = '2026-10-15T10:00:00.000Z';
const later = (ms: number) => new Date(Date.parse(t0) + ms).toISOString();
const alive = () => true;
const first = { alive, instanceId: 'a', now: t0, pid: 100, url: 'http://127.0.0.1:7731' };

test('the first server takes the lease and publishes its url', () => {
  const db = database();
  assert.deepEqual(acquireServerLease(db, first), { kind: 'acquired' });
  assert.equal(readServerLease(db)?.url, 'http://127.0.0.1:7731');
});

test('a second server is refused while the first one is alive', () => {
  const db = database();
  acquireServerLease(db, first);
  const second = acquireServerLease(db, { ...first, instanceId: 'b', now: later(1000), pid: 200 });
  assert.equal(second.kind, 'held');
  assert.equal(readServerLease(db)?.instanceId, 'a');
});

test('a lease whose heartbeat is too old is taken over', () => {
  const db = database();
  acquireServerLease(db, first);
  const second = acquireServerLease(db, {
    ...first,
    instanceId: 'b',
    now: later(LEASE_TTL_MS + 1),
    pid: 200,
  });
  assert.equal(second.kind, 'acquired');
  assert.equal(readServerLease(db)?.instanceId, 'b');
});

test('a lease whose process is gone is taken over at once', () => {
  const db = database();
  acquireServerLease(db, first);
  const second = acquireServerLease(db, {
    ...first,
    alive: () => false,
    instanceId: 'b',
    now: later(1000),
    pid: 200,
  });
  assert.equal(second.kind, 'acquired');
});

test('only the owner renews or releases the lease', () => {
  const db = database();
  acquireServerLease(db, first);
  assert.equal(renewServerLease(db, 'b', later(1000)), false);
  assert.equal(renewServerLease(db, 'a', later(1000)), true);
  assert.equal(readServerLease(db)?.heartbeatAt, later(1000));
  releaseServerLease(db, 'b');
  assert.notEqual(readServerLease(db), null);
  releaseServerLease(db, 'a');
  assert.equal(readServerLease(db), null);
});
