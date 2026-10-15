import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { getAsset, isSea } from 'node:sea';
import { DatabaseSync } from 'node:sqlite';
import { OLDEST_UPGRADABLE_VERSION, upgrades } from './upgrades.ts';

export const APPLICATION_ID = 0x46_41_43_54; // "FACT"
export const SCHEMA_VERSION = 6;
export const STATE_DATABASE_RELATIVE_PATH = path.join('db', 'state.sqlite');

// The single executable carries schema.sql as an asset; source runs read it
// from next to this file.
function schemaSql(): string {
  return isSea()
    ? getAsset('schema.sql', 'utf8')
    : readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
}

export class FactoryDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class IncompatibleFactoryDatabaseError extends FactoryDatabaseError {}

// An older schema this controller can upgrade in place.
class UpgradableFactoryDatabaseError extends IncompatibleFactoryDatabaseError {}

export type OpenStateDatabaseOptions = {
  create?: boolean;
  readOnly?: boolean;
};

export function stateDatabasePath(factoryRoot: string): string {
  if (!path.isAbsolute(factoryRoot)) {
    throw new FactoryDatabaseError('factoryRoot must be an absolute path');
  }
  return path.join(factoryRoot, STATE_DATABASE_RELATIVE_PATH);
}

function isRow(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function firstNumber(row: unknown, label: string): number {
  if (!isRow(row)) {
    throw new FactoryDatabaseError(`expected ${label} row`);
  }
  const value = Object.values(row)[0];
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) {
    throw new FactoryDatabaseError(`expected numeric ${label}`);
  }
  return number;
}

function pragmaNumber(
  db: DatabaseSync,
  name: 'application_id' | 'user_version' | 'foreign_keys',
): number {
  const sql =
    name === 'application_id'
      ? 'PRAGMA application_id'
      : name === 'user_version'
        ? 'PRAGMA user_version'
        : 'PRAGMA foreign_keys';
  return firstNumber(db.prepare(sql).get(), name);
}

function hasTable(db: DatabaseSync, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
}

function schemaVersion(db: DatabaseSync): number | null {
  if (!hasTable(db, 'schema_meta')) {
    return null;
  }
  const row = db.prepare('SELECT schema_version FROM schema_meta WHERE singleton = 1').get();
  if (row === undefined) {
    return null;
  }
  return firstNumber(row, 'schema_version');
}

function assertCompatible(db: DatabaseSync, databasePath: string): void {
  const applicationId = pragmaNumber(db, 'application_id');
  const userVersion = pragmaNumber(db, 'user_version');
  const storedSchemaVersion = schemaVersion(db);

  if (
    applicationId === APPLICATION_ID &&
    userVersion === SCHEMA_VERSION &&
    storedSchemaVersion === SCHEMA_VERSION
  ) {
    return;
  }

  if (
    applicationId === APPLICATION_ID &&
    storedSchemaVersion !== null &&
    storedSchemaVersion < OLDEST_UPGRADABLE_VERSION
  ) {
    throw new IncompatibleFactoryDatabaseError(
      `factory database at ${databasePath} is schema ${storedSchemaVersion}; this controller needs schema ${SCHEMA_VERSION} and only upgrades schema ${OLDEST_UPGRADABLE_VERSION} or later. Finish or cancel its tickets with the older controller, then remove ${path.dirname(databasePath)} and start again.`,
    );
  }

  if (
    applicationId === APPLICATION_ID &&
    storedSchemaVersion !== null &&
    storedSchemaVersion < SCHEMA_VERSION
  ) {
    throw new UpgradableFactoryDatabaseError(
      `factory database at ${databasePath} is schema ${storedSchemaVersion}; open it read-write once to upgrade it to schema ${SCHEMA_VERSION}.`,
    );
  }

  if (applicationId === 0 && hasTable(db, 'meta')) {
    throw new IncompatibleFactoryDatabaseError(
      `legacy fstate database at ${databasePath} is not supported; back it up or remove it before initializing the controller database`,
    );
  }

  throw new IncompatibleFactoryDatabaseError(
    `incompatible factory database at ${databasePath}: expected application_id ${APPLICATION_ID} and schema version ${SCHEMA_VERSION}, got application_id ${applicationId}, user_version ${userVersion}, schema_meta ${storedSchemaVersion ?? 'missing'}`,
  );
}

function canInitialize(db: DatabaseSync): boolean {
  const applicationId = pragmaNumber(db, 'application_id');
  const userVersion = pragmaNumber(db, 'user_version');
  const userObjectCount = firstNumber(
    db
      .prepare(
        `SELECT count(*) AS count
         FROM sqlite_master
         WHERE name NOT LIKE 'sqlite_%' AND sql IS NOT NULL`,
      )
      .get(),
    'sqlite_master count',
  );
  return applicationId === 0 && userVersion === 0 && userObjectCount === 0;
}

function isLocked(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'errcode' in error &&
    (error.errcode === 5 || error.errcode === 6)
  );
}

// Switching to WAL needs an exclusive lock and ignores busy_timeout, so
// processes opening a new database together retry briefly instead of failing.
function enableWal(db: DatabaseSync): void {
  const mode = db.prepare('PRAGMA journal_mode').get();
  if (isRow(mode) && String(Object.values(mode)[0]).toLowerCase() === 'wal') {
    return;
  }
  for (let attempt = 0; ; attempt += 1) {
    try {
      db.exec('PRAGMA journal_mode = WAL');
      return;
    } catch (error: unknown) {
      if (!isLocked(error) || attempt >= 100) {
        throw error;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

function configureConnection(db: DatabaseSync, readOnly: boolean): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    enableWal(db);
  }
}

export function openStateDatabase(
  factoryRoot: string,
  options: OpenStateDatabaseOptions = {},
): DatabaseSync {
  const create = options.create ?? false;
  const readOnly = options.readOnly ?? false;
  const databasePath = stateDatabasePath(factoryRoot);
  const existed = existsSync(databasePath) && statSync(databasePath).size > 0;

  if (!existed && !create) {
    throw new FactoryDatabaseError(`factory database not found at ${databasePath}`);
  }
  if (!existed && readOnly) {
    throw new FactoryDatabaseError('cannot create a factory database in read-only mode');
  }

  if (!existed) {
    mkdirSync(path.dirname(databasePath), { recursive: true });
  }

  const db = new DatabaseSync(databasePath, { readOnly });
  try {
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 5000');

    let compatible = true;
    try {
      assertCompatible(db, databasePath);
    } catch (compatibilityError: unknown) {
      if (compatibilityError instanceof UpgradableFactoryDatabaseError && !readOnly) {
        configureConnection(db, false);
        upgrade(db);
      } else {
        compatible = false;
        if (!create || readOnly || !canInitialize(db)) {
          throw compatibilityError;
        }
      }
    }

    if (!compatible) {
      configureConnection(db, false);
      try {
        db.exec(schemaSql());
      } catch (initializationError: unknown) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // No transaction was open (for example, failure before BEGIN).
        }
        try {
          assertCompatible(db, databasePath);
        } catch {
          throw new FactoryDatabaseError(
            `failed to initialize factory database at ${databasePath}`,
            { cause: initializationError },
          );
        }
      }
    }
    assertCompatible(db, databasePath);
    configureConnection(db, readOnly);
    return db;
  } catch (error: unknown) {
    db.close();
    throw error;
  }
}

// Runs every step from the stored version to SCHEMA_VERSION in one
// transaction. A concurrent opener that upgraded first leaves nothing to do.
function upgrade(db: DatabaseSync): void {
  immediateTransaction(db, () => {
    const from = schemaVersion(db);
    if (from === null || from >= SCHEMA_VERSION) {
      return;
    }
    for (let version = from; version < SCHEMA_VERSION; version += 1) {
      const step = upgrades[version];
      if (step === undefined) {
        throw new FactoryDatabaseError(`no upgrade step from schema ${version}`);
      }
      db.exec(step);
    }
    db.prepare('UPDATE schema_meta SET schema_version = ? WHERE singleton = 1').run(SCHEMA_VERSION);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  });
}

export function initializeStateDatabase(factoryRoot: string): string {
  const db = openStateDatabase(factoryRoot, { create: true });
  db.close();
  return stateDatabasePath(factoryRoot);
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return isRow(value) && typeof value['then'] === 'function';
}

export function immediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    if (isThenable(result)) {
      void Promise.resolve(result).then(
        () => undefined,
        () => undefined,
      );
      throw new FactoryDatabaseError('immediateTransaction operation must be synchronous');
    }
    db.exec('COMMIT');
    return result;
  } catch (error: unknown) {
    db.exec('ROLLBACK');
    throw error;
  }
}
