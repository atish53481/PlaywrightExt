import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Loads PlaywrightPlatform/.env into process.env. Variables already set win. */
export function loadEnvFile(): void {
  dotenv.config({ path: path.resolve(__dirname, '../../.env') });
}

// An IPv4/IPv6 address with an optional /prefix, or one of proxy-addr's named ranges.
// A bare hop count is rejected: it cannot verify who the immediate peer is.
const PROXY_ENTRY = /^(loopback|linklocal|uniquelocal|(?=.*[.:])[0-9a-fA-F.:]+(\/\d{1,3})?)$/;

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'must not be empty'),
  APP_HOST: z.string().min(1).default('127.0.0.1'),
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  CORS_ORIGINS: z
    .string()
    .default('')
    .refine((v) => !v.split(',').some((origin) => origin.trim() === '*'), 'must list explicit origins; "*" is not allowed'),
  TRUST_PROXY: z
    .string()
    .default('false')
    .refine(
      (v) => v === 'false' || v.split(',').every((entry) => PROXY_ENTRY.test(entry.trim())),
      'must be false, or a comma-separated list of proxy addresses/CIDR ranges (or loopback, linklocal, uniquelocal)',
    ),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
  SECRETS_ENCRYPTION_KEY: z
    .string()
    .refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64-encoded'),
  LOGIN_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(10),
  // The address Jenkins uses to reach this server. Empty means loopback on APP_PORT.
  PLATFORM_PUBLIC_URL: z
    .string()
    .default('')
    .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'must be an http or https URL'),
  // The Playwright Docker image builds run tests in. A full registry/name:tag
  // reference: no spaces and no shell metacharacters.
  PLAYWRIGHT_DOCKER_IMAGE: z
    .string()
    .default('mcr.microsoft.com/playwright:v1.63.0-noble')
    .refine((v) => /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9._-]+$/.test(v), 'must be a docker image like registry/name:tag'),
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
  /** Requests per minute per caller (session, or address when anonymous). */
  rateLimitMax: number;
  /** false: use the socket address. Otherwise the proxy addresses whose X-Forwarded-For is believed. */
  trustProxy: false | string;
  /** Base URL that Jenkins builds use to call back, without a trailing slash. */
  publicUrl: string;
  /** The Playwright Docker image builds run tests in. */
  playwrightDockerImage: string;
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
    rateLimitMax: e.RATE_LIMIT_MAX,
    trustProxy:
      e.TRUST_PROXY === 'false'
        ? false
        : e.TRUST_PROXY.split(',')
            .map((entry) => entry.trim())
            .join(','),
    publicUrl: e.PLATFORM_PUBLIC_URL.replace(/\/+$/, '') || `http://127.0.0.1:${e.APP_PORT}`,
    playwrightDockerImage: e.PLAYWRIGHT_DOCKER_IMAGE,
  };
}
