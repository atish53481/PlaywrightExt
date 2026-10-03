import type { Db } from './db';
import { migrationSource } from './migrations';

const options = { migrationSource, tableName: 'knex_migrations' };

/**
 * Guard for code that wipes a database (test setup, the E2E server). Throws
 * unless the database name ends in `_test`, so a mistyped URL cannot drop real data.
 */
export function assertDisposableDatabase(databaseUrl: string): void {
  let name = '';
  try {
    name = new URL(databaseUrl).pathname.replace(/^\//, '');
  } catch {
    // Falls through to the error below with an empty name.
  }
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to reset database "${name}": its name must end in _test.`);
  }
}

/** Applies every pending migration. Returns [batchNumber, appliedNames]. */
export function migrateLatest(db: Db): Promise<[number, string[]]> {
  return db.migrate.latest(options);
}

/** Reverts the most recent batch. */
export function rollbackLast(db: Db): Promise<[number, string[]]> {
  return db.migrate.rollback(options);
}

/** Reverts every batch. */
export function rollbackAll(db: Db): Promise<[number, string[]]> {
  return db.migrate.rollback(options, true);
}
