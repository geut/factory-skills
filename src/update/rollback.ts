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

// Reads the backup as a plain SQLite file: it is an older schema, which the
// factory's own open would refuse or upgrade.
export function lossSince(input: { backup: string; db: DatabaseSync }): Loss {
  const backup = new DatabaseSync(input.backup, { readOnly: true });
  let revision: number;
  try {
    const row = backup.prepare('SELECT coalesce(max(revision), 0) AS revision FROM events').get();
    revision = Number(row?.['revision'] ?? 0);
  } finally {
    backup.close();
  }
  const counted = input.db
    .prepare('SELECT count(*) AS n FROM events WHERE revision > ?')
    .get(revision);
  const tickets = input.db
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
  if (previous.schema >= current.schema) {
    // Same database, or a newer binary that upgrades it itself.
    return { kind: 'ready', previous, restore: null };
  }
  const backup = upgradeBackupPath(input.databasePath, previous.schema);
  if (!existsSync(backup)) {
    return {
      kind: 'refused',
      message: `factory ${current.version} upgraded the database from schema ${previous.schema} to ${current.schema}, and the backup it made, ${backup}, is gone, so factory ${previous.version} cannot open the database.`,
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
  return `Rolling back to factory ${previous.version} restores ${restore.backup}, the database as it was at ${restore.madeAt}, before factory ${input.current} upgraded it. ${lost}`;
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
