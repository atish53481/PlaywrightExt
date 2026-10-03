import { loadEnvFile } from '../config';
import { createDb } from '../db';
import { migrateLatest, rollbackLast } from '../migrate';
import { seedAdmin } from '../seed';

async function main(): Promise<void> {
  loadEnvFile();
  const command = process.argv[2];
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
    process.exitCode = 1;
    return;
  }

  const db = createDb(databaseUrl);
  try {
    if (command === 'migrate') {
      const [batch, names] = await migrateLatest(db);
      console.log(names.length ? `Batch ${batch} applied: ${names.join(', ')}` : 'Already up to date.');
    } else if (command === 'rollback') {
      const [batch, names] = await rollbackLast(db);
      console.log(names.length ? `Batch ${batch} rolled back: ${names.join(', ')}` : 'Nothing to roll back.');
    } else if (command === 'seed') {
      const outcome = await seedAdmin(db, process.env);
      console.log(outcome === 'created' ? 'Admin user created.' : 'Admin user already exists; nothing changed.');
    } else {
      console.error('Usage: tsx src/scripts/db.ts migrate|rollback|seed');
      process.exitCode = 1;
    }
  } finally {
    await db.destroy();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
