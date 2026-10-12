import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const APPLICATION_ID = 0x46_41_43_54; // "FACT"
export const SCHEMA_VERSION = 3;
export const STATE_DATABASE_RELATIVE_PATH = path.join('db', 'state.sqlite');

const schemaSql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');

export class FactoryDatabaseError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class IncompatibleFactoryDatabaseError extends FactoryDatabaseError {}

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
    storedSchemaVersion < SCHEMA_VERSION
  ) {
    throw new IncompatibleFactoryDatabaseError(
      `factory database at ${databasePath} is schema ${storedSchemaVersion}; this controller needs schema ${SCHEMA_VERSION} and does not upgrade older databases. Finish or cancel its tickets with the older controller, then remove ${path.dirname(databasePath)} and start again.`,
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

function configureConnection(db: DatabaseSync, readOnly: boolean): void {
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (!readOnly) {
    db.exec('PRAGMA journal_mode = WAL');
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
      compatible = false;
      if (!create || readOnly || !canInitialize(db)) {
        throw compatibilityError;
      }
    }

    if (!compatible) {
      configureConnection(db, false);
      try {
        db.exec(schemaSql);
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
