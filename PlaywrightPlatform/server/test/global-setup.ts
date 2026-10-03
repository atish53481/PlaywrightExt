import { createDb } from '../src/db';
import { migrateLatest, rollbackAll } from '../src/migrate';
import { testConfig } from './helpers';

/** Rebuilds the test database schema once before the whole run. */
export default async function setup(): Promise<void> {
  const db = createDb(testConfig().databaseUrl);
  try {
    await rollbackAll(db);
    await migrateLatest(db);
  } finally {
    await db.destroy();
  }
}
