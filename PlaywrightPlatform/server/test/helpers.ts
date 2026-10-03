import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig, loadEnvFile, type Config } from '../src/config';
import { createDb, type Db } from '../src/db';
import { PLATFORM_TABLES } from '../src/migrations/tables';
import { UserRepository } from '../src/repositories/user-repository';
import { hashPassword } from '../src/security/passwords';
import type { Role, User, UserStatus } from '../src/types';

export interface TestContext {
  app: FastifyInstance;
  db: Db;
  config: Config;
}

export function testConfig(overrides: Record<string, string> = {}): Config {
  loadEnvFile();
  const databaseUrl = process.env.DATABASE_URL_TEST;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL_TEST is not set. Copy .env.example to .env and fill it in.');
  }
  return loadConfig({
    DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
    SECRETS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    CORS_ORIGINS: 'http://localhost:5173',
    LOGIN_RATE_LIMIT_MAX: '1000',
    ...overrides,
  });
}

export async function makeApp(overrides: Record<string, string> = {}): Promise<TestContext> {
  const config = testConfig(overrides);
  const db = createDb(config.databaseUrl);
  const app = await buildApp({ config, db });
  return { app, db, config };
}

export async function closeApp(ctx: TestContext): Promise<void> {
  await ctx.app.close();
  await ctx.db.destroy();
}

/** Empties every platform table and restarts identity counters. */
export async function resetDb(db: Db): Promise<void> {
  await db.raw(`truncate table ${PLATFORM_TABLES.join(', ')} restart identity cascade`);
}

let userCounter = 0;

export async function createUser(
  db: Db,
  options: { email?: string; role?: Role; password?: string; displayName?: string; status?: UserStatus } = {},
): Promise<User & { password: string }> {
  userCounter += 1;
  const password = options.password ?? 'correct-horse-battery';
  const users = new UserRepository(db);
  let user = await users.create({
    email: options.email ?? `user${userCounter}@example.com`,
    displayName: options.displayName ?? `User ${userCounter}`,
    passwordHash: await hashPassword(password),
    role: options.role ?? 'ADMIN',
  });
  if (options.status === 'DISABLED') {
    user = (await users.update(user.id, { status: 'DISABLED' })) as User;
  }
  return { ...user, password };
}

export interface WebLogin {
  cookies: Record<string, string>;
  headers: Record<string, string>;
}

/** Signs in as the web app does. Pass `cookies` and `headers` to `app.inject`. */
export async function loginWeb(app: FastifyInstance, email: string, password: string): Promise<WebLogin> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password, client: 'web' },
  });
  if (res.statusCode !== 200) throw new Error(`web login failed: ${res.statusCode} ${res.body}`);
  const cookie = res.cookies.find((c) => c.name === 'pw_session');
  if (!cookie) throw new Error('web login did not set a session cookie');
  return { cookies: { pw_session: cookie.value }, headers: { 'x-csrf-token': res.json().csrfToken } };
}

/** Signs in as the extension does. Pass `headers` to `app.inject`. */
export async function loginExt(
  app: FastifyInstance,
  email: string,
  password: string,
): Promise<{ headers: Record<string, string>; token: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email, password, client: 'extension' },
  });
  if (res.statusCode !== 200) throw new Error(`extension login failed: ${res.statusCode} ${res.body}`);
  const token = res.json().token as string;
  return { headers: { authorization: `Bearer ${token}` }, token };
}
