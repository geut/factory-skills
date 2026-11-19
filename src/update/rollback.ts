import {
  copyFileSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { upgradeBackupPath } from '../state/database.ts';
import { previousPath } from './install.ts';

// Rolling back an update: swap factory.previous back into place and restart
// on it. An update whose server upgraded the database schema left a backup of
// the database from before; the older version needs it back, so rolling back
// restores it, losing what was recorded since.

// What factory.previous is, written beside it when an update replaces the
// binary: without it, a rollback cannot know which database it needs.
export const PreviousRecord = z.object({
  schema: z.number().int().positive(),
  version: z.string(),
});

export type PreviousRecord = z.infer<typeof PreviousRecord>;

export function previousRecordPath(binary: string): string {
  return `${previousPath(binary)}.json`;
}

export function writePreviousRecord(binary: string, record: PreviousRecord): void {
  writeFileSync(previousRecordPath(binary), `${JSON.stringify(record, null, 2)}\n`);
}

export function readPreviousRecord(binary: string): PreviousRecord | null {
  try {
    const parsed = PreviousRecord.safeParse(
      JSON.parse(readFileSync(previousRecordPath(binary), 'utf8')),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// What restoring a backup loses: the events recorded after it was made, and
// the tickets they belong to.
export type Loss = { events: number; tickets: Array<string> };

// The schema the database at `databasePath` is on, or null when there is
// none yet. Read as a plain SQLite file, as the factory's own open would
// refuse or upgrade an older one.
export function storedSchemaVersion(databasePath: string): number | null {
  if (!existsSync(databasePath)) {
    return null;
  }
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = db.prepare('SELECT schema_version FROM schema_meta WHERE singleton = 1').get();
    return row === undefined ? null : Number(row['schema_version']);
  } finally {
    db.close();
  }
}

// Reads both databases as plain SQLite files: either may be on a schema the
// factory's own open would refuse or upgrade.
export function lossSince(input: { backup: string; databasePath: string }): Loss {
  const backup = new DatabaseSync(input.backup, { readOnly: true });
  let revision: number;
  try {
    const row = backup.prepare('SELECT coalesce(max(revision), 0) AS revision FROM events').get();
    revision = Number(row?.['revision'] ?? 0);
  } finally {
    backup.close();
  }
  const db = new DatabaseSync(input.databasePath, { readOnly: true });
  try {
    return lostIn(db, revision);
  } finally {
    db.close();
  }
}

function lostIn(db: DatabaseSync, revision: number): Loss {
  const counted = db.prepare('SELECT count(*) AS n FROM events WHERE revision > ?').get(revision);
  const tickets = db
    .prepare(
      `SELECT DISTINCT coalesce(t.source_ref, t.id) AS ref
       FROM events AS e
       JOIN ticket_executions AS x ON x.id = e.execution_id
       JOIN tickets AS t ON t.id = x.ticket_id
       WHERE e.revision > ?
       ORDER BY ref`,
    )
    .all(revision);
  return {
    events: Number(counted?.['n'] ?? 0),
    tickets: tickets.map((row) => String(row['ref'])),
  };
}

export type RollbackPlan =
  | { kind: 'refused'; message: string }
  | {
      kind: 'ready';
      previous: PreviousRecord;
      // The backup to put back, when the update upgraded the database.
      restore: { backup: string; loss: Loss; madeAt: string } | null;
    };

export function planRollback(input: {
  binary: string;
  current: PreviousRecord;
  databasePath: string;
  loss: (backup: string) => Loss;
  // The schema the database is on now: an update that replaced the binary
  // with no server running never upgraded it.
  storedSchema: number | null;
}): RollbackPlan {
  const { binary, current } = input;
  if (!existsSync(previousPath(binary))) {
    return {
      kind: 'refused',
      message: `There is no ${previousPath(binary)} to roll back to: no update has replaced this binary.`,
    };
  }
  const previous = readPreviousRecord(binary);
  if (previous === null) {
    return {
      kind: 'refused',
      message: `${previousPath(binary)} was not put there by factory update, so which database it needs is unknown. Swap it in by hand with the server stopped.`,
    };
  }
  const { storedSchema } = input;
  if (storedSchema === null || storedSchema <= previous.schema) {
    // A database the older binary opens as it is (or upgrades itself).
    return { kind: 'ready', previous, restore: null };
  }
  const backup = upgradeBackupPath(input.databasePath, previous.schema);
  if (!existsSync(backup)) {
    return {
      kind: 'refused',
      message: `The database was upgraded from schema ${previous.schema} to ${storedSchema}, and the backup the upgrade made, ${backup}, is gone, so factory ${previous.version} cannot open it. Going back from ${current.version} is not possible.`,
    };
  }
  return {
    kind: 'ready',
    previous,
    restore: {
      backup,
      loss: input.loss(backup),
      madeAt: statSync(backup).mtime.toISOString(),
    },
  };
}

// What the owner confirms before a rollback restores the database.
export function rollbackQuestion(input: {
  current: string;
  plan: Extract<RollbackPlan, { kind: 'ready' }>;
}): string {
  const { previous, restore } = input.plan;
  if (restore === null) {
    return `Roll back to factory ${previous.version}.`;
  }
  const { loss } = restore;
  const lost =
    loss.events === 0
      ? 'Nothing was recorded since.'
      : `Everything recorded since is lost: ${loss.events} event${loss.events === 1 ? '' : 's'}${loss.tickets.length === 0 ? '' : ` for ${loss.tickets.join(', ')}`}.`;
  return `Rolling back from factory ${input.current} to ${previous.version} restores ${restore.backup}, the database as it was at ${restore.madeAt}, before it was upgraded. ${lost}`;
}

// Swaps factory.previous and the binary, so rolling back again goes forward,
// and records what factory.previous now is.
export function swapBack(input: { binary: string; current: PreviousRecord }): void {
  const { binary } = input;
  const aside = `${binary}.rollback`;
  renameSync(binary, aside);
  try {
    renameSync(previousPath(binary), binary);
  } catch (error: unknown) {
    renameSync(aside, binary);
    throw error;
  }
  renameSync(aside, previousPath(binary));
  writePreviousRecord(binary, input.current);
}

// Puts the backup in place of the database, with no server running. The
// write-ahead log and its index belong to the database being replaced.
export function restoreDatabase(input: { backup: string; databasePath: string }): void {
  const partial = `${input.databasePath}.restore`;
  copyFileSync(input.backup, partial);
  rmSync(`${input.databasePath}-wal`, { force: true });
  rmSync(`${input.databasePath}-shm`, { force: true });
  renameSync(partial, input.databasePath);
}
