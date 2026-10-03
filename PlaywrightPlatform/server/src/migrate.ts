import type { Db } from './db';
import { migrationSource } from './migrations';

const options = { migrationSource, tableName: 'knex_migrations' };

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
