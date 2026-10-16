import type { DatabaseSync } from 'node:sqlite';
import { immediateTransaction } from '../state/database.ts';

// A server refreshes its lease every HEARTBEAT_MS. A lease whose heartbeat is
// older than LEASE_TTL_MS, or whose process is gone, belongs to nobody.
export const HEARTBEAT_MS = 5000;
export const LEASE_TTL_MS = 15_000;

export type ServerLease = {
  heartbeatAt: string;
  instanceId: string;
  pid: number;
  startedAt: string;
  url: string;
};

export type AcquireResult = { kind: 'acquired' } | { kind: 'held'; lease: ServerLease };

// Whether a process id is alive on this machine. The lease always lives next
// to the database, so its pid is local.
export type ProcessProbe = (pid: number) => boolean;

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    // EPERM means the process exists but belongs to someone else.
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

function leaseFromRow(value: Record<string, unknown>): ServerLease {
  return {
    heartbeatAt: String(value['heartbeat_at']),
    instanceId: String(value['instance_id']),
    pid: Number(value['pid']),
    startedAt: String(value['started_at']),
    url: String(value['url']),
  };
}

export function readServerLease(db: DatabaseSync): ServerLease | null {
  const found = db.prepare('SELECT * FROM server_lease WHERE singleton = 1').get();
  return found === undefined ? null : leaseFromRow(found);
}

export function leaseIsLive(
  lease: ServerLease,
  now: string,
  alive: ProcessProbe = processAlive,
): boolean {
  return Date.parse(now) - Date.parse(lease.heartbeatAt) <= LEASE_TTL_MS && alive(lease.pid);
}

export function acquireServerLease(
  db: DatabaseSync,
  input: { alive?: ProcessProbe; instanceId: string; now: string; pid: number; url: string },
): AcquireResult {
  return immediateTransaction(db, () => {
    const held = readServerLease(db);
    if (
      held !== null &&
      held.instanceId !== input.instanceId &&
      leaseIsLive(held, input.now, input.alive)
    ) {
      return { kind: 'held', lease: held };
    }
    db.prepare(
      `INSERT INTO server_lease (singleton, instance_id, url, pid, started_at, heartbeat_at)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT (singleton) DO UPDATE SET
         instance_id = excluded.instance_id, url = excluded.url, pid = excluded.pid,
         started_at = excluded.started_at, heartbeat_at = excluded.heartbeat_at`,
    ).run(input.instanceId, input.url, input.pid, input.now, input.now);
    return { kind: 'acquired' };
  });
}

// False when another server has taken the lease, so this one must stop.
export function renewServerLease(db: DatabaseSync, instanceId: string, now: string): boolean {
  const renewed = db
    .prepare('UPDATE server_lease SET heartbeat_at = ? WHERE singleton = 1 AND instance_id = ?')
    .run(now, instanceId);
  return renewed.changes === 1;
}

export function releaseServerLease(db: DatabaseSync, instanceId: string): void {
  db.prepare('DELETE FROM server_lease WHERE singleton = 1 AND instance_id = ?').run(instanceId);
}
