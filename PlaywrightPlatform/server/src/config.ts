import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Loads PlaywrightPlatform/.env into process.env. Variables already set win. */
export function loadEnvFile(): void {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'must not be empty'),
  APP_HOST: z.string().min(1).default('127.0.0.1'),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z.string().default(''),
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
});

export interface Config {
  databaseUrl: string;
  host: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  logLevel: string;
  corsOrigins: string[];
  secretsKey: Buffer;
  loginRateLimitMax: number;
}

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`));
  }
  const e = parsed.data;
  return {
    databaseUrl: e.DATABASE_URL,
    host: e.APP_HOST,
    port: e.APP_PORT,
    nodeEnv: e.NODE_ENV,
    logLevel: e.LOG_LEVEL,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    secretsKey: Buffer.from(e.SECRETS_ENCRYPTION_KEY, 'base64'),
    loginRateLimitMax: e.LOGIN_RATE_LIMIT_MAX,
  };
}
