import { buildApp } from '../app';
import { loadConfig, loadEnvFile } from '../config';
import { createDb } from '../db';
import { migrateLatest, rollbackAll } from '../migrate';
import { UserRepository } from '../repositories/user-repository';
import { hashPassword } from '../security/passwords';
import type { Role } from '../types';

// Fixed accounts for browser tests. They exist only in playwright_db_test.
const E2E_USERS: { email: string; displayName: string; password: string; role: Role }[] = [
  { email: 'admin@e2e.test', displayName: 'E2E Admin', password: 'Admin-e2e-pass1', role: 'ADMIN' },
  { email: 'viewer@e2e.test', displayName: 'E2E Viewer', password: 'Viewer-e2e-pass1', role: 'VIEWER' },
];

/** Rebuilds the test database, creates the E2E accounts, and serves the API on port 3100. */
async function main(): Promise<void> {
  loadEnvFile();
  const databaseUrl = process.env.DATABASE_URL_TEST;
  if (!databaseUrl) throw new Error('DATABASE_URL_TEST is not set. Copy .env.example to .env and fill it in.');

  const config = loadConfig({
    ...process.env,
    DATABASE_URL: databaseUrl,
    APP_HOST: '127.0.0.1',
    APP_PORT: '3100',
    NODE_ENV: 'test',
    LOGIN_RATE_LIMIT_MAX: '1000',
  });
  const db = createDb(config.databaseUrl);
  await rollbackAll(db);
  await migrateLatest(db);

  const users = new UserRepository(db);
  for (const u of E2E_USERS) {
    await users.create({
      email: u.email,
      displayName: u.displayName,
      passwordHash: await hashPassword(u.password),
      role: u.role,
    });
  }

  const app = await buildApp({ config, db });
  await app.listen({ host: config.host, port: config.port });
  console.log(`E2E server ready on http://${config.host}:${config.port}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
