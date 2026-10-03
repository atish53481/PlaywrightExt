import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { loadConfig, loadEnvFile, type Config } from '../src/config';
import { createDb, type Db } from '../src/db';

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
