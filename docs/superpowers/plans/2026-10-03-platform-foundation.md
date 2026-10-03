# Platform Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Fastify + PostgreSQL backend with the full platform schema, authentication, roles, audit logging, user and project management, a React web app for those features, and a platform sign-in in the existing Chrome extension.

**Architecture:** A new `PlaywrightPlatform/` npm-workspaces folder holds `server/` (Fastify, layered as routes → services → repositories → Knex) and `web/` (React + Vite, all HTTP through one typed client). PostgreSQL runs in Docker. The extension gains one new module and a Settings block; no agent, provider, runner, or Bridge code changes.

**Tech Stack:** Node 24, TypeScript, Fastify 5, Knex 3, PostgreSQL 16, Zod 3, argon2, Vitest, React 18, Vite, React Router 6, Playwright Test.

**Spec:** `docs/superpowers/specs/2026-10-03-platform-foundation-design.md`

## Global Constraints

- All work happens in the `PlaywrightExt` repo on branch `feat/platform-foundation`. All paths below are relative to that repo root.
- Do not modify `PlaywrightBridge/` or `PlaywrightOrchestrator/`. In `PlaywrightExtension/` touch only `utils/storage.js`, `utils/platform-client.js` (new), `tests/` (new), `sidepanel.html`, and `sidepanel.js`.
- Server layering: files in `routes/` never import from `repositories/` or `knex`; files in `services/` never import from `fastify`'s request/reply; only `repositories/` and `migrations/` issue queries.
- Web layering: only files in `web/src/api/` call `fetch`.
- SQL goes through Knex parameter binding. No string concatenation of user input into SQL.
- Every route validates its body, query, and params with Zod (`parse`) and its response with Zod (`shape`).
- Error responses always have the shape `{ "error": { "code", "message", "details" } }`. No stack traces in responses.
- `id` columns are `bigint generated always as identity`; timestamps are `timestamptz default now()`; status-like columns are `text` with a `CHECK`; foreign keys are `ON DELETE RESTRICT`.
- No secret is ever written to a log, a response, or git. `.env` is gitignored. No default password exists in code.
- The server package is CommonJS (no `"type": "module"`), so relative imports have no file extension and `__dirname` is available.
- One deliberate deviation from the spec's folder sketch: migrations live in `server/src/migrations/` and the seed in `server/src/seed.ts` (not `server/migrations/`, `server/seeds/`) so that `tsc` builds everything from one `rootDir`.
- Vitest and the Playwright E2E run both use the `playwright_db_test` database and reset it. Never run them at the same time.

## Review Focus

Inputs and conditions the spec implies but does not spell out, each pinned by a test in the task that owns the code:

1. **Database unreachable.** `/api/health` returns 503 with `database: "down"` instead of hanging or returning a stack trace. (Task 1)
2. **Project names that differ only by case or surrounding spaces.** `"  Shop "` is stored as `"Shop"`, and `"shop"` is then rejected as a duplicate. (Task 5)
3. **Search text containing `%` or `_`.** These match literally; searching `%` does not return every project. (Task 5)
4. **Session ends while the web app is open.** The next API call sends the user to the login page rather than leaving a broken screen. (Task 7)
5. **Ids and fields outside sane bounds.** `/api/projects/abc`, `/api/projects/99999999999999999999`, and a 500-character project name return 400, not 500. (Tasks 4 and 5)

---

## File Map

```
PlaywrightPlatform/
  package.json                      workspaces + convenience scripts
  .gitignore  .env.example  docker-compose.yml  README.md
  docker/init-test-db.sql           creates playwright_db_test on first start
  server/
    package.json  tsconfig.json  tsconfig.build.json  vitest.config.mts
    src/
      config.ts                     env → Config; ConfigError lists every problem
      db.ts                         createDb, isUniqueViolation
      errors.ts                     AppError + notFound()
      http.ts                       parse() for requests, shape() for responses
      types.ts                      domain types shared by services/repositories
      app.ts                        buildApp(): composition root
      server.ts                     process entry point
      seed.ts                       seedAdmin()
      migrate.ts                    migrateLatest, rollbackLast, rollbackAll
      migrations/                   index.ts, tables.ts, 001 … 006
      security/passwords.ts         argon2id hash/verify
      security/tokens.ts            newToken, hashToken, safeEqual
      plugins/error-handler.ts      error + not-found handlers
      plugins/auth.ts               session resolution, guards, actorOf
      repositories/                 user, session, audit, project
      services/                     audit, auth, user, project
      schemas/                      common, auth, users, projects
      routes/                       health, auth, users, projects
      scripts/db.ts                 CLI: migrate | rollback | seed
      scripts/e2e-serve.ts          resets test DB, seeds E2E users, serves on 3100
    test/                           helpers.ts, global-setup.ts, *.test.ts
  web/
    package.json  tsconfig.json  vite.config.ts  playwright.config.ts  index.html
    src/
      main.tsx  App.tsx  styles.css
      api/                          client.ts, types.ts, auth.ts, projects.ts, users.ts
      auth/AuthContext.tsx
      hooks/useLoad.ts
      components/                   AppShell, Modal, ConfirmDialog, StatusBadge
      pages/                        LoginPage, ProjectsPage, ProjectDashboardPage, UsersPage
    e2e/                            helpers.ts, auth.spec.ts, projects.spec.ts, users.spec.ts
PlaywrightExtension/
  utils/platform-client.js          new: only file that knows the platform API
  utils/storage.js                  + getPlatform / savePlatform
  tests/platform-client.test.mjs    new: node --test
  sidepanel.html, sidepanel.js      + Platform block in Settings
```

---

### Task 1: Workspace, PostgreSQL, config, and health endpoint

**Files:**
- Create: `PlaywrightPlatform/package.json`, `.gitignore`, `.env.example`, `docker-compose.yml`, `docker/init-test-db.sql`
- Create: `PlaywrightPlatform/server/package.json`, `tsconfig.json`, `tsconfig.build.json`, `vitest.config.mts`
- Create: `PlaywrightPlatform/server/src/config.ts`, `db.ts`, `errors.ts`, `http.ts`, `app.ts`, `server.ts`, `plugins/error-handler.ts`, `routes/health.ts`
- Test: `PlaywrightPlatform/server/test/helpers.ts`, `config.test.ts`, `health.test.ts`

**Interfaces:**
- Produces:
  - `loadEnvFile(): void`, `loadConfig(env?): Config`, `class ConfigError { problems: string[] }`
  - `interface Config { databaseUrl: string; host: string; port: number; nodeEnv: 'development'|'test'|'production'; logLevel: string; corsOrigins: string[]; secretsKey: Buffer; loginRateLimitMax: number }`
  - `createDb(databaseUrl: string, acquireTimeoutMs?: number): Db`, `type Db = Knex`, `isUniqueViolation(err: unknown): boolean`
  - `class AppError(statusCode: number, code: string, message: string, details?: unknown)`, `notFound(what: string): AppError`
  - `parse(schema, value)` → typed value or throws `AppError(400, 'VALIDATION_ERROR')`; `shape(schema, value)` → typed value or throws plain `Error`
  - `buildApp(deps: { config: Config; db: Db; webRoot?: string }): Promise<FastifyInstance>`
  - Test helpers: `testConfig(overrides?)`, `makeApp(overrides?) → { app, db, config }`, `closeApp(ctx)`

- [ ] **Step 1: Create the workspace root files**

`PlaywrightPlatform/package.json`:

```json
{
  "name": "playwright-platform",
  "private": true,
  "workspaces": ["server", "web"],
  "scripts": {
    "db:up": "docker compose up -d postgres",
    "db:migrate": "npm run db:migrate -w server",
    "db:rollback": "npm run db:rollback -w server",
    "db:seed": "npm run db:seed -w server",
    "dev:server": "npm run dev -w server",
    "dev:web": "npm run dev -w web",
    "build": "npm run build -w web && npm run build -w server",
    "start": "npm run start -w server",
    "test": "npm run test -w server",
    "test:e2e": "npm run test:e2e -w web",
    "typecheck": "npm run typecheck -w server && npm run typecheck -w web"
  }
}
```

Until Task 6 creates `web/`, change `"workspaces"` to `["server"]`. Task 6 restores `["server", "web"]`.

`PlaywrightPlatform/.gitignore`:

```
.env
node_modules/
dist/
test-results/
playwright-report/
```

`PlaywrightPlatform/.env.example`:

```
# PostgreSQL (docker compose reads these)
POSTGRES_USER=playwright
POSTGRES_PASSWORD=change-me
POSTGRES_DB=playwright_db
POSTGRES_PORT=5432

# Server
DATABASE_URL=postgresql://playwright:change-me@localhost:5432/playwright_db
DATABASE_URL_TEST=postgresql://playwright:change-me@localhost:5432/playwright_db_test
APP_HOST=127.0.0.1
APP_PORT=3000
NODE_ENV=development
LOG_LEVEL=info
CORS_ORIGINS=http://localhost:5173
LOGIN_RATE_LIMIT_MAX=10

# 32 random bytes, base64. Generate with:
#   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
SECRETS_ENCRYPTION_KEY=

# First admin, used only by `npm run db:seed`
ADMIN_EMAIL=
ADMIN_PASSWORD=

# Jenkins (not read until the Jenkins sub-project)
JENKINS_URL=http://localhost:8080
JENKINS_USERNAME=
JENKINS_API_TOKEN=

# Optional pgAdmin (docker compose --profile tools up -d pgadmin)
PGADMIN_EMAIL=admin@example.com
PGADMIN_PASSWORD=
```

`PlaywrightPlatform/docker-compose.yml`:

```yaml
services:
  postgres:
    image: postgres:16-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    ports:
      - "127.0.0.1:${POSTGRES_PORT:-5432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./docker/init-test-db.sql:/docker-entrypoint-initdb.d/init-test-db.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DB}"]
      interval: 5s
      timeout: 3s
      retries: 10

  pgadmin:
    image: dpage/pgadmin4:8
    profiles: ["tools"]
    environment:
      PGADMIN_DEFAULT_EMAIL: ${PGADMIN_EMAIL:-admin@example.com}
      # No default: pgAdmin refuses to start until PGADMIN_PASSWORD is set in .env.
      PGADMIN_DEFAULT_PASSWORD: ${PGADMIN_PASSWORD:-}
    ports:
      - "127.0.0.1:5050:80"
    depends_on:
      postgres:
        condition: service_healthy

volumes:
  pgdata:
```

`PlaywrightPlatform/docker/init-test-db.sql`:

```sql
CREATE DATABASE playwright_db_test;
```

- [ ] **Step 2: Create `.env` and start PostgreSQL**

```bash
cd PlaywrightPlatform
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Paste the printed value after `SECRETS_ENCRYPTION_KEY=` in `.env`. Replace both occurrences of `change-me` in `DATABASE_URL`/`DATABASE_URL_TEST` and `POSTGRES_PASSWORD` with one new password of your choosing. Set `ADMIN_EMAIL` and an `ADMIN_PASSWORD` of at least 8 characters. Then:

```bash
docker compose up -d postgres
docker compose ps
```

Expected: `postgres` shows `healthy` within about 15 seconds. If port 5432 is already in use, set `POSTGRES_PORT=5433` in `.env`, change the port in both database URLs to match, and run `docker compose up -d postgres` again.

- [ ] **Step 3: Create the server package**

`PlaywrightPlatform/server/package.json`:

```json
{
  "name": "@playwright-platform/server",
  "private": true,
  "version": "0.1.0",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "db:migrate": "tsx src/scripts/db.ts migrate",
    "db:rollback": "tsx src/scripts/db.ts rollback",
    "db:seed": "tsx src/scripts/db.ts seed",
    "e2e:serve": "tsx src/scripts/e2e-serve.ts"
  }
}
```

`PlaywrightPlatform/server/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["node"],
    "noEmit": true
  },
  "include": ["src", "test"]
}
```

`PlaywrightPlatform/server/tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": { "noEmit": false, "rootDir": "src", "outDir": "dist", "sourceMap": true },
  "include": ["src"]
}
```

`PlaywrightPlatform/server/vitest.config.mts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

Install dependencies:

```bash
cd PlaywrightPlatform
npm install -w server fastify@^5 @fastify/cookie @fastify/cors @fastify/helmet @fastify/rate-limit @fastify/static knex@^3 pg zod@^3 argon2 dotenv
npm install -w server -D typescript tsx vitest @types/node @types/pg
```

Expected: both commands finish without errors and `PlaywrightPlatform/package-lock.json` exists.

- [ ] **Step 4: Write the failing config test**

`PlaywrightPlatform/server/test/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const key = Buffer.alloc(32, 1).toString('base64');

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SECRETS_ENCRYPTION_KEY: key,
      CORS_ORIGINS: 'http://localhost:5173, http://localhost:3000 ',
    });
    expect(config.databaseUrl).toBe('postgresql://u:p@localhost:5432/db');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.nodeEnv).toBe('development');
    expect(config.loginRateLimitMax).toBe(10);
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:3000']);
    expect(config.secretsKey).toHaveLength(32);
  });

  it('reports every missing variable in one error', () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems.join('\n');
    expect(problems).toContain('DATABASE_URL');
    expect(problems).toContain('SECRETS_ENCRYPTION_KEY');
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: 'c2hvcnQ=' }),
    ).toThrow(/32 bytes/);
  });

  it('rejects an empty encryption key', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: '' }),
    ).toThrow(ConfigError);
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test -w server -- test/config.test.ts`
Expected: FAIL — cannot resolve `../src/config`.

- [ ] **Step 6: Implement config, db, errors, and http helpers**

`PlaywrightPlatform/server/src/config.ts`:

```ts
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
```

`PlaywrightPlatform/server/src/db.ts`:

```ts
import knex, { type Knex } from 'knex';
import pg from 'pg';

// int8 (bigint ids, count(*)) arrives as a string by default. Ids here stay far
// below 2^53, so plain numbers are safe and simpler to work with.
pg.types.setTypeParser(20, (value) => Number(value));

export type Db = Knex;

export function createDb(databaseUrl: string, acquireTimeoutMs = 10_000): Db {
  return knex({
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 0, max: 10 },
    acquireConnectionTimeout: acquireTimeoutMs,
  });
}

/** True for PostgreSQL error 23505 (unique_violation). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
```

`PlaywrightPlatform/server/src/errors.ts`:

```ts
export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found.`);
}
```

`PlaywrightPlatform/server/src/http.ts`:

```ts
import type { z } from 'zod';
import { AppError } from './errors';

/** Validates request input. Throws a 400 AppError listing each problem. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Validates a response. A failure is a server bug, so it surfaces as a 500. */
export function shape<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Response validation failed: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}
```

- [ ] **Step 7: Run the config test to verify it passes**

Run: `npm run test -w server -- test/config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 8: Write the failing health and error-handling tests**

`PlaywrightPlatform/server/test/helpers.ts`:

```ts
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
```

`PlaywrightPlatform/server/test/health.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb } from '../src/db';
import { closeApp, makeApp, testConfig, type TestContext } from './helpers';

describe('health and error handling', () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await makeApp();
    ctx.app.get('/api/boom', async () => {
      throw new Error('secret internal detail');
    });
    ctx.app.post('/api/echo', async (req) => req.body);
  });
  afterAll(() => closeApp(ctx));

  it('reports ok when the database answers', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'up' });
  });

  it('reports 503 when the database is unreachable', async () => {
    const config = testConfig();
    const deadDb = createDb('postgresql://nobody:nothing@127.0.0.1:1/none', 500);
    const app = await buildApp({ config, db: deadDb });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'degraded', database: 'down' });
    await app.close();
    await deadDb.destroy();
  });

  it('returns the standard error shape for an unknown route', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({
      error: { code: 'NOT_FOUND', message: 'Resource not found.', details: null },
    });
  });

  it('hides internal error details behind a 500 with a request id', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/boom' });
    expect(res.statusCode).toBe(500);
    expect(res.body).not.toContain('secret internal detail');
    expect(res.body).not.toContain('at ');
    const body = res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(typeof body.error.details.requestId).toBe('string');
  });

  it('returns 400 in the standard shape for malformed JSON', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('BAD_REQUEST');
  });
});
```

- [ ] **Step 9: Run them to verify they fail**

Run: `npm run test -w server -- test/health.test.ts`
Expected: FAIL — cannot resolve `../src/app`.

- [ ] **Step 10: Implement the error handler, health route, app, and server entry**

`PlaywrightPlatform/server/src/plugins/error-handler.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';

function body(code: string, message: string, details: unknown = null) {
  return { error: { code, message, details } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (status === 429) {
      return reply.status(429).send(body('RATE_LIMITED', 'Too many requests. Try again later.'));
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : 'Bad request.';
      return reply.status(status).send(body('BAD_REQUEST', message));
    }
    req.log.error({ err }, 'Unhandled error');
    return reply
      .status(500)
      .send(
        body('INTERNAL_ERROR', 'Something went wrong. Quote the request ID when reporting this.', {
          requestId: req.id,
        }),
      );
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send(body('NOT_FOUND', 'Resource not found.'));
  });
}
```

`PlaywrightPlatform/server/src/routes/health.ts`:

```ts
import type { FastifyInstance } from 'fastify';

export interface HealthDeps {
  ping: () => Promise<void>;
}

export async function healthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      await deps.ping();
      return { status: 'ok', database: 'up' };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'down' });
    }
  });
}
```

`PlaywrightPlatform/server/src/app.ts`:

```ts
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config';
import type { Db } from './db';
import { registerErrorHandling } from './plugins/error-handler';
import { healthRoutes } from './routes/health';

export const SESSION_COOKIE = 'pw_session';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Absolute path of the built web app. When set, it is served with SPA fallback. */
  webRoot?: string;
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
];

export async function buildApp({ config, db }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : { level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    genReqId: () => randomUUID(),
  });

  registerErrorHandling(app);

  await app.register(helmet);
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization ?? req.cookies[SESSION_COOKIE] ?? req.ip,
  });

  await app.register(
    async (api) => {
      await api.register(healthRoutes, {
        ping: async () => {
          await db.raw('select 1');
        },
      });
    },
    { prefix: '/api' },
  );

  return app;
}
```

`PlaywrightPlatform/server/src/server.ts`:

```ts
import { buildApp } from './app';
import { ConfigError, loadConfig, loadEnvFile } from './config';
import { createDb } from './db';

async function main(): Promise<void> {
  loadEnvFile();
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }

  const db = createDb(config.databaseUrl);
  const app = await buildApp({ config, db });

  const shutdown = async () => {
    await app.close();
    await db.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 11: Run all server tests and the typecheck**

Run: `npm run test -w server && npm run typecheck -w server`
Expected: PASS, 9 tests across 2 files; `tsc` prints nothing.

- [ ] **Step 12: Smoke-test the real process**

Run: `npm run dev -w server` and, in a second terminal, `curl -s http://127.0.0.1:3000/api/health`
Expected: `{"status":"ok","database":"up"}`. Stop the server with Ctrl+C.

- [ ] **Step 13: Commit**

```bash
git add PlaywrightPlatform
git status --short
```

Confirm `.env` and `node_modules` are NOT listed, then:

```bash
git commit -m "feat(platform): scaffold server with config, postgres, and health endpoint"
```

---

### Task 2: Full database schema with migrations

**Files:**
- Create: `PlaywrightPlatform/server/src/migrations/001_identity_audit.ts` … `006_healing.ts`, `index.ts`, `tables.ts`
- Create: `PlaywrightPlatform/server/src/migrate.ts`, `src/scripts/db.ts`
- Create: `PlaywrightPlatform/server/test/global-setup.ts`, `test/migrations.test.ts`
- Modify: `PlaywrightPlatform/server/vitest.config.mts`, `test/helpers.ts`

**Interfaces:**
- Consumes: `createDb`, `Db`, `loadEnvFile`, `testConfig`
- Produces:
  - `PLATFORM_TABLES: readonly string[]` — all 22 table names, parents before children
  - `migrateLatest(db): Promise<[number, string[]]>`, `rollbackLast(db)`, `rollbackAll(db)`
  - Test helper `resetDb(db): Promise<void>` — truncates every platform table and restarts identities
  - CLI `tsx src/scripts/db.ts migrate|rollback`

- [ ] **Step 1: Write the failing migration test**

`PlaywrightPlatform/server/test/migrations.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db';
import { migrateLatest, rollbackAll } from '../src/migrate';
import { PLATFORM_TABLES } from '../src/migrations/tables';
import { resetDb, testConfig } from './helpers';

async function existingTables(db: Db): Promise<string[]> {
  const rows = await db('information_schema.tables')
    .where({ table_schema: 'public' })
    .select('table_name');
  return rows.map((r: { table_name: string }) => r.table_name);
}

describe('migrations', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(testConfig().databaseUrl);
  });
  afterAll(async () => {
    await migrateLatest(db);
    await db.destroy();
  });

  it('declares exactly the 22 tables in the spec', () => {
    expect(PLATFORM_TABLES).toHaveLength(22);
    expect(new Set(PLATFORM_TABLES).size).toBe(22);
  });

  it('rollback removes every platform table and migrate recreates them', async () => {
    await rollbackAll(db);
    const afterRollback = await existingTables(db);
    for (const table of PLATFORM_TABLES) expect(afterRollback).not.toContain(table);

    await migrateLatest(db);
    const afterMigrate = await existingTables(db);
    for (const table of PLATFORM_TABLES) expect(afterMigrate).toContain(table);
  });

  describe('constraints', () => {
    beforeAll(async () => {
      await migrateLatest(db);
      await resetDb(db);
    });

    const user = { email: 'a@example.com', display_name: 'A', password_hash: 'x', role: 'ADMIN' };

    it('rejects an unknown role', async () => {
      await expect(db('users').insert({ ...user, email: 'b@example.com', role: 'ROOT' })).rejects.toThrow();
    });

    it('treats emails as case-insensitive unique', async () => {
      await db('users').insert(user);
      await expect(db('users').insert({ ...user, email: 'A@EXAMPLE.COM' })).rejects.toThrow();
    });

    it('allows a project name to be reused only after the first is deleted', async () => {
      const [first] = await db('projects').insert({ name: 'Shop' }).returning('id');
      await expect(db('projects').insert({ name: 'shop' })).rejects.toThrow();
      await db('projects').where({ id: first.id }).update({ status: 'DELETED' });
      await expect(db('projects').insert({ name: 'shop' })).resolves.toBeDefined();
    });

    it('requires project_id exactly when a skill is project-scoped', async () => {
      const base = { name: 'S', content: '# s' };
      await expect(db('skills').insert({ ...base, scope: 'PROJECT' })).rejects.toThrow();
      const project = await db('projects').where({ status: 'ACTIVE' }).first('id');
      await expect(
        db('skills').insert({ ...base, scope: 'GLOBAL', project_id: project.id }),
      ).rejects.toThrow();
      await expect(db('skills').insert({ ...base, scope: 'GLOBAL' })).resolves.toBeDefined();
    });

    it('refuses a Jenkins configuration with no credential source', async () => {
      const base = { name: 'local', base_url: 'http://localhost:8080', username: 'u' };
      await expect(db('jenkins_configurations').insert(base)).rejects.toThrow();
      await expect(
        db('jenkins_configurations').insert({ ...base, credential_reference: 'JENKINS_API_TOKEN' }),
      ).resolves.toBeDefined();
    });

    it('refuses to hard-delete a project that has scripts', async () => {
      const project = await db('projects').where({ status: 'ACTIVE' }).first('id');
      await db('test_scripts').insert({ project_id: project.id, name: 'Login', script_content: '// x' });
      await expect(db('projects').where({ id: project.id }).del()).rejects.toThrow();
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w server -- test/migrations.test.ts`
Expected: FAIL — cannot resolve `../src/migrate`.

- [ ] **Step 3: Write the table list and the six migrations**

`PlaywrightPlatform/server/src/migrations/tables.ts`:

```ts
/** Every platform table, parents before children. */
export const PLATFORM_TABLES = [
  'users',
  'sessions',
  'audit_logs',
  'projects',
  'project_environments',
  'test_scripts',
  'test_script_versions',
  'tags',
  'script_tags',
  'skills',
  'skill_versions',
  'skill_tags',
  'project_skills',
  'script_skills',
  'jenkins_configurations',
  'project_ci_jobs',
  'test_executions',
  'execution_scripts',
  'execution_results',
  'execution_logs',
  'execution_skill_snapshots',
  'healing_proposals',
] as const;
```

`PlaywrightPlatform/server/src/migrations/001_identity_audit.ts`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table users (
      id bigint generated always as identity primary key,
      email text not null,
      display_name text not null,
      password_hash text not null,
      role text not null check (role in ('ADMIN', 'USER', 'VIEWER')),
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
      last_login_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index users_email_lower_uq on users (lower(email));

    create table sessions (
      id bigint generated always as identity primary key,
      user_id bigint not null references users (id) on delete restrict,
      token_hash text not null unique,
      kind text not null check (kind in ('WEB', 'EXTENSION')),
      csrf_secret text not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      last_used_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index sessions_user_id_idx on sessions (user_id);

    create table audit_logs (
      id bigint generated always as identity primary key,
      user_id bigint references users (id) on delete restrict,
      user_email text,
      action text not null,
      resource text not null,
      resource_id text,
      result text not null check (result in ('SUCCESS', 'FAILURE')),
      ip text,
      details jsonb,
      created_at timestamptz not null default now()
    );
    create index audit_logs_resource_idx on audit_logs (resource, resource_id);
    create index audit_logs_created_at_idx on audit_logs (created_at);
    create index audit_logs_user_id_idx on audit_logs (user_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists audit_logs;
    drop table if exists sessions;
    drop table if exists users;
  `);
}
```

`PlaywrightPlatform/server/src/migrations/002_projects.ts`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table projects (
      id bigint generated always as identity primary key,
      name text not null,
      description text not null default '',
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED', 'DELETED')),
      auto_use_skills boolean not null default true,
      created_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      deleted_by bigint references users (id) on delete restrict
    );
    create unique index projects_live_name_uq on projects (lower(name)) where status <> 'DELETED';
    create index projects_status_idx on projects (status);

    create table project_environments (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      name text not null check (name in ('DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION')),
      base_url text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (project_id, name)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists project_environments;
    drop table if exists projects;
  `);
}
```

`PlaywrightPlatform/server/src/migrations/003_scripts.ts`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table test_scripts (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      name text not null,
      description text not null default '',
      test_scenario text not null default '',
      script_content text not null,
      language text not null default 'TypeScript',
      framework text not null default 'Playwright',
      script_type text not null default 'E2E',
      version integer not null default 1 check (version >= 1),
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED', 'DELETED')),
      lifecycle_state text not null default 'DRAFT' check (lifecycle_state in
        ('DRAFT', 'GENERATED', 'SAVED', 'VALIDATED', 'READY', 'RUNNING', 'PASSED', 'FAILED', 'HEALING')),
      created_by bigint references users (id) on delete restrict,
      updated_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      deleted_by bigint references users (id) on delete restrict
    );
    create unique index test_scripts_live_name_uq
      on test_scripts (project_id, lower(name)) where status <> 'DELETED';
    create index test_scripts_project_status_idx on test_scripts (project_id, status);

    create table test_script_versions (
      id bigint generated always as identity primary key,
      script_id bigint not null references test_scripts (id) on delete restrict,
      version integer not null check (version >= 1),
      script_content text not null,
      change_summary text not null default '',
      source text not null default 'MANUAL' check (source in
        ('MANUAL', 'GENERATED', 'RECORDED', 'IMPORTED', 'HEALED', 'RESTORED')),
      created_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      unique (script_id, version)
    );

    create table tags (
      id bigint generated always as identity primary key,
      name text not null
    );
    create unique index tags_name_lower_uq on tags (lower(name));

    create table script_tags (
      script_id bigint not null references test_scripts (id) on delete restrict,
      tag_id bigint not null references tags (id) on delete restrict,
      primary key (script_id, tag_id)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists script_tags;
    drop table if exists tags;
    drop table if exists test_script_versions;
    drop table if exists test_scripts;
  `);
}
```

`PlaywrightPlatform/server/src/migrations/004_skills.ts`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table skills (
      id bigint generated always as identity primary key,
      name text not null,
      description text not null default '',
      scope text not null check (scope in ('GLOBAL', 'PROJECT')),
      project_id bigint references projects (id) on delete restrict,
      file_name text,
      content text not null,
      version integer not null default 1 check (version >= 1),
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
      created_by bigint references users (id) on delete restrict,
      updated_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint skills_scope_project_check check (
        (scope = 'PROJECT' and project_id is not null) or (scope = 'GLOBAL' and project_id is null)
      )
    );
    create index skills_scope_status_idx on skills (scope, status);
    create index skills_project_id_idx on skills (project_id);

    create table skill_versions (
      id bigint generated always as identity primary key,
      skill_id bigint not null references skills (id) on delete restrict,
      version integer not null check (version >= 1),
      content text not null,
      change_summary text not null default '',
      created_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      unique (skill_id, version)
    );

    create table skill_tags (
      skill_id bigint not null references skills (id) on delete restrict,
      tag_id bigint not null references tags (id) on delete restrict,
      primary key (skill_id, tag_id)
    );

    create table project_skills (
      project_id bigint not null references projects (id) on delete restrict,
      skill_id bigint not null references skills (id) on delete restrict,
      enabled boolean not null default true,
      priority integer not null default 100,
      created_at timestamptz not null default now(),
      primary key (project_id, skill_id)
    );
    create index project_skills_priority_idx on project_skills (project_id, priority);

    create table script_skills (
      script_id bigint not null,
      script_version integer not null,
      skill_id bigint not null,
      skill_version integer not null,
      primary key (script_id, script_version, skill_id, skill_version),
      foreign key (script_id, script_version)
        references test_script_versions (script_id, version) on delete restrict,
      foreign key (skill_id, skill_version)
        references skill_versions (skill_id, version) on delete restrict
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists script_skills;
    drop table if exists project_skills;
    drop table if exists skill_tags;
    drop table if exists skill_versions;
    drop table if exists skills;
  `);
}
```

`PlaywrightPlatform/server/src/migrations/005_ci_execution.ts`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table jenkins_configurations (
      id bigint generated always as identity primary key,
      name text not null unique,
      base_url text not null,
      username text not null,
      credential_reference text,
      secret_ciphertext text,
      job_name text,
      folder text,
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint jenkins_credential_source_check check (
        credential_reference is not null or secret_ciphertext is not null
      )
    );

    create table project_ci_jobs (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      jenkins_configuration_id bigint not null references jenkins_configurations (id) on delete restrict,
      job_name text not null,
      folder text not null default '',
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      unique (project_id, jenkins_configuration_id, job_name, folder)
    );

    create table test_executions (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      script_id bigint references test_scripts (id) on delete restrict,
      script_version integer,
      jenkins_job_id bigint references project_ci_jobs (id) on delete restrict,
      jenkins_build_number integer,
      jenkins_queue_id bigint,
      ci_provider text not null default 'JENKINS',
      trigger_type text not null check (trigger_type in ('MANUAL', 'JENKINS', 'SCHEDULED', 'API')),
      status text not null default 'QUEUED' check (status in
        ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ABORTED', 'ERROR')),
      stage text not null default 'QUEUED' check (stage in
        ('QUEUED', 'STARTING', 'RUNNING', 'TEST_EXECUTION', 'GENERATING_REPORT', 'COMPLETED')),
      environment text,
      browser text,
      tags text[] not null default '{}',
      total_tests integer not null default 0,
      passed_tests integer not null default 0,
      failed_tests integer not null default 0,
      skipped_tests integer not null default 0,
      report_url text,
      error_message text,
      callback_token_hash text,
      triggered_by bigint references users (id) on delete restrict,
      started_at timestamptz,
      completed_at timestamptz,
      duration bigint,
      created_at timestamptz not null default now()
    );
    create index test_executions_project_created_idx on test_executions (project_id, created_at desc);
    create index test_executions_status_idx on test_executions (status);
    create index test_executions_script_id_idx on test_executions (script_id);

    create table execution_scripts (
      execution_id bigint not null references test_executions (id) on delete restrict,
      script_id bigint not null references test_scripts (id) on delete restrict,
      script_version integer not null,
      primary key (execution_id, script_id, script_version)
    );

    create table execution_results (
      id bigint generated always as identity primary key,
      execution_id bigint not null references test_executions (id) on delete restrict,
      script_id bigint references test_scripts (id) on delete restrict,
      test_name text not null,
      status text not null check (status in ('PASSED', 'FAILED', 'SKIPPED')),
      duration bigint,
      error_message text,
      stack_trace text,
      screenshot_path text,
      video_path text,
      trace_path text,
      created_at timestamptz not null default now()
    );
    create index execution_results_execution_id_idx on execution_results (execution_id);

    create table execution_logs (
      id bigint generated always as identity primary key,
      execution_id bigint not null references test_executions (id) on delete restrict,
      level text not null default 'info',
      message text not null,
      created_at timestamptz not null default now()
    );
    create index execution_logs_execution_created_idx on execution_logs (execution_id, created_at);

    create table execution_skill_snapshots (
      execution_id bigint not null references test_executions (id) on delete restrict,
      skill_id bigint not null references skills (id) on delete restrict,
      skill_version integer not null,
      skill_name text not null,
      primary key (execution_id, skill_id)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists execution_skill_snapshots;
    drop table if exists execution_logs;
    drop table if exists execution_results;
    drop table if exists execution_scripts;
    drop table if exists test_executions;
    drop table if exists project_ci_jobs;
    drop table if exists jenkins_configurations;
  `);
}
```

`PlaywrightPlatform/server/src/migrations/006_healing.ts`:

```ts
import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table healing_proposals (
      id bigint generated always as identity primary key,
      script_id bigint not null references test_scripts (id) on delete restrict,
      base_version integer not null,
      execution_id bigint references test_executions (id) on delete restrict,
      proposed_content text not null,
      summary text not null default '',
      status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED')),
      resulting_version integer,
      created_by bigint references users (id) on delete restrict,
      reviewed_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      reviewed_at timestamptz
    );
    create index healing_proposals_script_status_idx on healing_proposals (script_id, status);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`drop table if exists healing_proposals;`);
}
```

- [ ] **Step 4: Write the migration source, runner functions, and CLI**

`PlaywrightPlatform/server/src/migrations/index.ts`:

```ts
import type { Knex } from 'knex';
import * as m001 from './001_identity_audit';
import * as m002 from './002_projects';
import * as m003 from './003_scripts';
import * as m004 from './004_skills';
import * as m005 from './005_ci_execution';
import * as m006 from './006_healing';

export interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

/** Ordered list. Append new migrations; never edit or reorder shipped ones. */
export const migrations: Migration[] = [
  { name: '001_identity_audit', up: m001.up, down: m001.down },
  { name: '002_projects', up: m002.up, down: m002.down },
  { name: '003_scripts', up: m003.up, down: m003.down },
  { name: '004_skills', up: m004.up, down: m004.down },
  { name: '005_ci_execution', up: m005.up, down: m005.down },
  { name: '006_healing', up: m006.up, down: m006.down },
];

// Migrations are plain imports rather than files Knex discovers on disk, so the
// same code runs under tsx, Vitest, and the compiled build with no loader setup.
export const migrationSource: Knex.MigrationSource<Migration> = {
  getMigrations: async () => migrations,
  getMigrationName: (migration) => migration.name,
  getMigration: async (migration) => migration,
};
```

`PlaywrightPlatform/server/src/migrate.ts`:

```ts
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
```

`PlaywrightPlatform/server/src/scripts/db.ts`:

```ts
import { loadEnvFile } from '../config';
import { createDb } from '../db';
import { migrateLatest, rollbackLast } from '../migrate';

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
```

- [ ] **Step 5: Add the global setup and `resetDb` helper**

`PlaywrightPlatform/server/test/global-setup.ts`:

```ts
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
```

In `PlaywrightPlatform/server/vitest.config.mts`, add `globalSetup` inside `test`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
```

Append to `PlaywrightPlatform/server/test/helpers.ts`:

```ts
import { PLATFORM_TABLES } from '../src/migrations/tables';

/** Empties every platform table and restarts identity counters. */
export async function resetDb(db: Db): Promise<void> {
  await db.raw(`truncate table ${PLATFORM_TABLES.join(', ')} restart identity cascade`);
}
```

(Move the `import` line up with the other imports at the top of the file.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test -w server`
Expected: PASS — `migrations.test.ts` 8 tests, plus the 9 from Task 1.

- [ ] **Step 7: Run the CLI against the development database**

```bash
cd PlaywrightPlatform
npm run db:migrate
npm run db:migrate
npm run db:rollback
npm run db:migrate
docker compose exec postgres psql -U playwright -d playwright_db -c "\dt"
```

Expected, in order: `Batch 1 applied: 001_identity_audit, …, 006_healing`; `Already up to date.`; `Batch 1 rolled back: …`; `Batch 1 applied: …`; and a `\dt` listing of 24 tables (22 platform tables plus `knex_migrations` and `knex_migrations_lock`). If your `POSTGRES_USER` differs from `playwright`, use it in the `psql` command.

- [ ] **Step 8: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): add full database schema with migrations and rollback"
```

---

### Task 3: Authentication, sessions, CSRF, audit, and admin seed

**Files:**
- Create: `PlaywrightPlatform/server/src/types.ts`, `security/passwords.ts`, `security/tokens.ts`
- Create: `PlaywrightPlatform/server/src/repositories/user-repository.ts`, `session-repository.ts`, `audit-repository.ts`
- Create: `PlaywrightPlatform/server/src/services/audit-service.ts`, `auth-service.ts`
- Create: `PlaywrightPlatform/server/src/plugins/auth.ts`, `schemas/common.ts`, `schemas/auth.ts`, `routes/auth.ts`, `seed.ts`
- Modify: `PlaywrightPlatform/server/src/app.ts`, `src/scripts/db.ts`, `test/helpers.ts`
- Test: `PlaywrightPlatform/server/test/auth.test.ts`, `test/seed.test.ts`

**Interfaces:**
- Consumes: `Db`, `AppError`, `parse`, `shape`, `Config`, `SESSION_COOKIE`, `resetDb`, `makeApp`
- Produces:
  - Types: `Role = 'ADMIN'|'USER'|'VIEWER'`, `UserStatus = 'ACTIVE'|'DISABLED'`, `SessionKind = 'WEB'|'EXTENSION'`, `User { id, email, displayName, role, status, lastLoginAt: Date|null, createdAt: Date, updatedAt: Date }`, `UserWithHash extends User { passwordHash }`, `Session { id, userId, kind, csrfSecret, expiresAt: Date }`, `AuthContext { user: User; session: Session; via: 'cookie'|'bearer' }`, `Actor { userId: number; email: string; ip: string }`
  - `hashPassword(plain): Promise<string>`, `verifyPassword(hash, plain): Promise<boolean>`
  - `newToken(): string`, `hashToken(token): string`, `safeEqual(a, b): boolean`
  - `UserRepository`: `findByEmail(email)`, `findById(id)` → `UserWithHash|null`; `list()` → `User[]`; `create({ email, displayName, passwordHash, role })` → `User`; `update(id, { displayName?, role?, status?, passwordHash? })` → `User|null`; `touchLogin(id)`; `countActiveAdmins()` → `number`
  - `SessionRepository`: `create({ userId, tokenHash, kind, csrfSecret, expiresAt })` → `Session`; `findActive(tokenHash, kind)` → `{ user: User; session: Session } | null`; `revoke(id)`; `revokeAllForUser(userId)`
  - `AuditService.record(entry: AuditEntry): Promise<void>` where `AuditEntry { userId: number|null; userEmail: string|null; action: string; resource: string; resourceId: string|null; result: 'SUCCESS'|'FAILURE'; ip: string|null; details?: Record<string, unknown> }`
  - `AuthService.login({ email, password, client: 'web'|'extension', ip })` → `{ user, token, csrfToken, expiresAt }`; `.resolve(token, kind)`; `.logout(ctx, ip)`
  - Guards in `plugins/auth.ts`: `registerAuth(app, authService)`, `signedIn`, `adminOnly` (arrays for `preHandler`), `actorOf(req): Actor`
  - `userDto` (Zod), `toUserDto(user)`, `idParams` (Zod `{ id }`)
  - `seedAdmin(db, env): Promise<'created'|'exists'>`
  - Test helpers: `createUser(db, { email?, role?, password?, displayName?, status? })` → `User & { password: string }`; `loginWeb(app, email, password)` → `{ cookies, headers }`; `loginExt(app, email, password)` → `{ headers, token }`

- [ ] **Step 1: Write domain types and security primitives**

`PlaywrightPlatform/server/src/types.ts`:

```ts
export type Role = 'ADMIN' | 'USER' | 'VIEWER';
export type UserStatus = 'ACTIVE' | 'DISABLED';
export type SessionKind = 'WEB' | 'EXTENSION';

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

export interface Session {
  id: number;
  userId: number;
  kind: SessionKind;
  csrfSecret: string;
  expiresAt: Date;
}

export interface AuthContext {
  user: User;
  session: Session;
  via: 'cookie' | 'bearer';
}

/** Who performed an action, for audit rows. */
export interface Actor {
  userId: number;
  email: string;
  ip: string;
}
```

`PlaywrightPlatform/server/src/security/passwords.ts`:

```ts
import argon2 from 'argon2';

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
```

`PlaywrightPlatform/server/src/security/tokens.ts`:

```ts
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 256 bits of randomness, URL-safe. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this hash is stored, so a database leak does not expose live sessions. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
```

- [ ] **Step 2: Write the repositories**

`PlaywrightPlatform/server/src/repositories/user-repository.ts`:

```ts
import type { Db } from '../db';
import type { Role, User, UserStatus, UserWithHash } from '../types';

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toUser(row: Omit<UserRow, 'password_hash'>): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUserWithHash(row: UserRow): UserWithHash {
  return { ...toUser(row), passwordHash: row.password_hash };
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string;
  role: Role;
}

export interface UserPatch {
  displayName?: string;
  role?: Role;
  status?: UserStatus;
  passwordHash?: string;
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<UserWithHash | null> {
    const row = await this.db('users')
      .whereRaw('lower(email) = ?', [email.toLowerCase()])
      .first();
    return row ? toUserWithHash(row) : null;
  }

  async findById(id: number): Promise<UserWithHash | null> {
    const row = await this.db('users').where({ id }).first();
    return row ? toUserWithHash(row) : null;
  }

  async list(): Promise<User[]> {
    const rows = await this.db('users').orderBy('created_at', 'asc').orderBy('id', 'asc');
    return rows.map(toUser);
  }

  async create(input: NewUser): Promise<User> {
    const [row] = await this.db('users')
      .insert({
        email: input.email,
        display_name: input.displayName,
        password_hash: input.passwordHash,
        role: input.role,
      })
      .returning('*');
    return toUser(row);
  }

  async update(id: number, patch: UserPatch): Promise<User | null> {
    const changes: Record<string, unknown> = { updated_at: this.db.fn.now() };
    if (patch.displayName !== undefined) changes.display_name = patch.displayName;
    if (patch.role !== undefined) changes.role = patch.role;
    if (patch.status !== undefined) changes.status = patch.status;
    if (patch.passwordHash !== undefined) changes.password_hash = patch.passwordHash;
    const [row] = await this.db('users').where({ id }).update(changes).returning('*');
    return row ? toUser(row) : null;
  }

  async touchLogin(id: number): Promise<void> {
    await this.db('users').where({ id }).update({ last_login_at: this.db.fn.now() });
  }

  async countActiveAdmins(): Promise<number> {
    const row = await this.db('users').where({ role: 'ADMIN', status: 'ACTIVE' }).count('* as n').first();
    return Number(row?.n ?? 0);
  }
}
```

`PlaywrightPlatform/server/src/repositories/session-repository.ts`:

```ts
import type { Db } from '../db';
import type { Session, SessionKind, User } from '../types';
import { toUser } from './user-repository';

export interface NewSession {
  userId: number;
  tokenHash: string;
  kind: SessionKind;
  csrfSecret: string;
  expiresAt: Date;
}

export class SessionRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewSession): Promise<Session> {
    const [row] = await this.db('sessions')
      .insert({
        user_id: input.userId,
        token_hash: input.tokenHash,
        kind: input.kind,
        csrf_secret: input.csrfSecret,
        expires_at: input.expiresAt,
        last_used_at: this.db.fn.now(),
      })
      .returning(['id', 'user_id', 'kind', 'csrf_secret', 'expires_at']);
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      csrfSecret: row.csrf_secret,
      expiresAt: row.expires_at,
    };
  }

  /** A session counts only if unrevoked, unexpired, of the right kind, and its user is active. */
  async findActive(tokenHash: string, kind: SessionKind): Promise<{ user: User; session: Session } | null> {
    const row = await this.db('sessions as s')
      .join('users as u', 'u.id', 's.user_id')
      .where('s.token_hash', tokenHash)
      .where('s.kind', kind)
      .whereNull('s.revoked_at')
      .where('s.expires_at', '>', this.db.fn.now())
      .where('u.status', 'ACTIVE')
      .first(
        's.id as session_id',
        's.kind as session_kind',
        's.csrf_secret',
        's.expires_at',
        'u.id',
        'u.email',
        'u.display_name',
        'u.role',
        'u.status',
        'u.last_login_at',
        'u.created_at',
        'u.updated_at',
      );
    if (!row) return null;
    return {
      user: toUser(row),
      session: {
        id: row.session_id,
        userId: row.id,
        kind: row.session_kind,
        csrfSecret: row.csrf_secret,
        expiresAt: row.expires_at,
      },
    };
  }

  async revoke(id: number): Promise<void> {
    await this.db('sessions').where({ id }).whereNull('revoked_at').update({ revoked_at: this.db.fn.now() });
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.db('sessions')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: this.db.fn.now() });
  }
}
```

`PlaywrightPlatform/server/src/repositories/audit-repository.ts`:

```ts
import type { Db } from '../db';

export interface AuditRow {
  userId: number | null;
  userEmail: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: 'SUCCESS' | 'FAILURE';
  ip: string | null;
  details: Record<string, unknown> | null;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  async insert(row: AuditRow): Promise<void> {
    await this.db('audit_logs').insert({
      user_id: row.userId,
      user_email: row.userEmail,
      action: row.action,
      resource: row.resource,
      resource_id: row.resourceId,
      result: row.result,
      ip: row.ip,
      details: row.details === null ? null : JSON.stringify(row.details),
    });
  }
}
```

- [ ] **Step 3: Write the audit and auth services**

`PlaywrightPlatform/server/src/services/audit-service.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import type { AuditRepository } from '../repositories/audit-repository';

export interface AuditEntry {
  userId: number | null;
  userEmail: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: 'SUCCESS' | 'FAILURE';
  ip: string | null;
  /** Never put secrets here: this object is stored and logged. */
  details?: Record<string, unknown>;
}

export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly log: FastifyBaseLogger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.repo.insert({ ...entry, details: entry.details ?? null });
    this.log.info(
      { action: entry.action, resource: entry.resource, resourceId: entry.resourceId, userId: entry.userId },
      `[AUDIT] ${entry.action} ${entry.result}`,
    );
  }
}
```

`PlaywrightPlatform/server/src/services/auth-service.ts`:

```ts
import { AppError } from '../errors';
import type { SessionRepository } from '../repositories/session-repository';
import type { UserRepository } from '../repositories/user-repository';
import { hashPassword, verifyPassword } from '../security/passwords';
import { hashToken, newToken } from '../security/tokens';
import type { AuthContext, Session, SessionKind, User } from '../types';
import type { AuditService } from './audit-service';

const WEB_SESSION_MS = 8 * 60 * 60 * 1000;
const EXTENSION_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export interface LoginInput {
  email: string;
  password: string;
  client: 'web' | 'extension';
  ip: string;
}

export interface LoginResult {
  user: User;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthService {
  // Verified against when the email is unknown, so both failure paths cost the same.
  private readonly dummyHash = hashPassword('timing-equaliser-not-a-real-password');

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const found = await this.users.findByEmail(input.email);
    const passwordOk = await verifyPassword(found?.passwordHash ?? (await this.dummyHash), input.password);

    if (!found || !passwordOk || found.status !== 'ACTIVE') {
      await this.audit.record({
        userId: found?.id ?? null,
        userEmail: input.email,
        action: 'auth.login',
        resource: 'session',
        resourceId: null,
        result: 'FAILURE',
        ip: input.ip,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const kind: SessionKind = input.client === 'web' ? 'WEB' : 'EXTENSION';
    const token = newToken();
    const csrfToken = newToken();
    const expiresAt = new Date(Date.now() + (kind === 'WEB' ? WEB_SESSION_MS : EXTENSION_SESSION_MS));
    const session = await this.sessions.create({
      userId: found.id,
      tokenHash: hashToken(token),
      kind,
      csrfSecret: csrfToken,
      expiresAt,
    });
    await this.users.touchLogin(found.id);
    await this.audit.record({
      userId: found.id,
      userEmail: found.email,
      action: 'auth.login',
      resource: 'session',
      resourceId: String(session.id),
      result: 'SUCCESS',
      ip: input.ip,
      details: { client: input.client },
    });

    const { passwordHash: _omit, ...user } = found;
    return { user, token, csrfToken, expiresAt };
  }

  resolve(token: string, kind: SessionKind): Promise<{ user: User; session: Session } | null> {
    return this.sessions.findActive(hashToken(token), kind);
  }

  async logout(ctx: AuthContext, ip: string): Promise<void> {
    await this.sessions.revoke(ctx.session.id);
    await this.audit.record({
      userId: ctx.user.id,
      userEmail: ctx.user.email,
      action: 'auth.logout',
      resource: 'session',
      resourceId: String(ctx.session.id),
      result: 'SUCCESS',
      ip,
    });
  }
}
```

- [ ] **Step 4: Write the test helpers and the failing auth tests**

Append to `PlaywrightPlatform/server/test/helpers.ts` (imports go at the top of the file):

```ts
import { UserRepository } from '../src/repositories/user-repository';
import { hashPassword } from '../src/security/passwords';
import type { Role, User, UserStatus } from '../src/types';

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
```

`PlaywrightPlatform/server/test/auth.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/security/tokens';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';

describe('authentication', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeApp();
  });
  afterAll(() => closeApp(ctx));
  beforeEach(() => resetDb(ctx.db));

  const login = (payload: unknown) =>
    ctx.app.inject({ method: 'POST', url: '/api/auth/login', payload: payload as object });

  it('web login sets a hardened cookie and returns a CSRF token, not the session token', async () => {
    const user = await createUser(ctx.db, { email: 'ada@example.com' });
    const res = await login({ email: 'ADA@example.com', password: user.password, client: 'web' });

    expect(res.statusCode).toBe(200);
    const cookie = res.cookies.find((c) => c.name === 'pw_session')!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Strict');
    expect(cookie.path).toBe('/');

    const body = res.json();
    expect(body.user).toMatchObject({ email: 'ada@example.com', role: 'ADMIN', status: 'ACTIVE' });
    expect(typeof body.csrfToken).toBe('string');
    expect(body.token).toBeUndefined();
    expect(res.body).not.toContain('passwordHash');
    expect(res.body).not.toContain('password_hash');
  });

  it('extension login returns a bearer token and sets no cookie', async () => {
    const user = await createUser(ctx.db);
    const res = await login({ email: user.email, password: user.password, client: 'extension' });
    expect(res.statusCode).toBe(200);
    expect(res.cookies).toHaveLength(0);
    expect(typeof res.json().token).toBe('string');
    expect(typeof res.json().expiresAt).toBe('string');
  });

  it('stores only a hash of the session token', async () => {
    const user = await createUser(ctx.db);
    const { token } = await loginExt(ctx.app, user.email, user.password);
    const rows = await ctx.db('sessions').select('token_hash');
    expect(rows).toHaveLength(1);
    expect(rows[0].token_hash).toBe(hashToken(token));
    expect(rows[0].token_hash).not.toBe(token);
  });

  it('gives the same answer for a wrong password, an unknown email, and a disabled user', async () => {
    const user = await createUser(ctx.db);
    const disabled = await createUser(ctx.db, { status: 'DISABLED' });
    const wrong = await login({ email: user.email, password: 'nope-nope-nope', client: 'web' });
    const unknown = await login({ email: 'ghost@example.com', password: 'nope-nope-nope', client: 'web' });
    const off = await login({ email: disabled.email, password: disabled.password, client: 'web' });

    for (const res of [wrong, unknown, off]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({
        error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.', details: null },
      });
    }
  });

  it('audits both successful and failed logins', async () => {
    const user = await createUser(ctx.db);
    await login({ email: user.email, password: 'nope-nope-nope', client: 'web' });
    await login({ email: user.email, password: user.password, client: 'web' });
    const rows = await ctx.db('audit_logs').where({ action: 'auth.login' }).orderBy('id');
    expect(rows.map((r: { result: string }) => r.result)).toEqual(['FAILURE', 'SUCCESS']);
    expect(rows[1].user_id).toBe(user.id);
    expect(JSON.stringify(rows)).not.toContain(user.password);
  });

  it('rejects a malformed login body with a validation error', async () => {
    const res = await login({ email: 'not-an-email', client: 'web' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(res.json().error.details.length).toBeGreaterThan(0);
  });

  it('/auth/me works with a cookie and with a bearer token, and 401s without either', async () => {
    const user = await createUser(ctx.db);
    const web = await loginWeb(ctx.app, user.email, user.password);
    const ext = await loginExt(ctx.app, user.email, user.password);

    const viaCookie = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', cookies: web.cookies });
    expect(viaCookie.statusCode).toBe(200);
    expect(viaCookie.json().csrfToken).toBe(web.headers['x-csrf-token']);

    const viaBearer = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: ext.headers });
    expect(viaBearer.statusCode).toBe(200);
    expect(viaBearer.json().csrfToken).toBeNull();

    const anonymous = await ctx.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(anonymous.statusCode).toBe(401);
    expect(anonymous.json().error.code).toBe('UNAUTHENTICATED');
  });

  it('does not accept a web token as a bearer token or an extension token as a cookie', async () => {
    const user = await createUser(ctx.db);
    const web = await loginWeb(ctx.app, user.email, user.password);
    const ext = await loginExt(ctx.app, user.email, user.password);

    const webAsBearer = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      headers: { authorization: `Bearer ${web.cookies.pw_session}` },
    });
    const extAsCookie = await ctx.app.inject({
      method: 'GET',
      url: '/api/auth/me',
      cookies: { pw_session: ext.token },
    });
    expect(webAsBearer.statusCode).toBe(401);
    expect(extAsCookie.statusCode).toBe(401);
  });

  it('rejects an expired session', async () => {
    const user = await createUser(ctx.db);
    const ext = await loginExt(ctx.app, user.email, user.password);
    await ctx.db('sessions').update({ expires_at: new Date(Date.now() - 1000) });
    const res = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: ext.headers });
    expect(res.statusCode).toBe(401);
  });

  it('requires a CSRF token for cookie-authenticated writes', async () => {
    const user = await createUser(ctx.db);
    const web = await loginWeb(ctx.app, user.email, user.password);

    const missing = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', cookies: web.cookies });
    expect(missing.statusCode).toBe(403);
    expect(missing.json().error.code).toBe('CSRF_INVALID');

    const wrong = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: web.cookies,
      headers: { 'x-csrf-token': 'forged' },
    });
    expect(wrong.statusCode).toBe(403);
  });

  it('logout revokes the session and clears the cookie', async () => {
    const user = await createUser(ctx.db);
    const web = await loginWeb(ctx.app, user.email, user.password);
    const out = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      cookies: web.cookies,
      headers: web.headers,
    });
    expect(out.statusCode).toBe(204);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', cookies: web.cookies });
    expect(after.statusCode).toBe(401);
  });

  it('bearer logout needs no CSRF token', async () => {
    const user = await createUser(ctx.db);
    const ext = await loginExt(ctx.app, user.email, user.password);
    const out = await ctx.app.inject({ method: 'POST', url: '/api/auth/logout', headers: ext.headers });
    expect(out.statusCode).toBe(204);
  });

  it('rate-limits login attempts', async () => {
    const limited = await makeApp({ LOGIN_RATE_LIMIT_MAX: '2' });
    try {
      const attempt = () =>
        limited.app.inject({
          method: 'POST',
          url: '/api/auth/login',
          payload: { email: 'x@example.com', password: 'whatever-pass', client: 'web' },
        });
      expect((await attempt()).statusCode).toBe(401);
      expect((await attempt()).statusCode).toBe(401);
      const third = await attempt();
      expect(third.statusCode).toBe(429);
      expect(third.json().error.code).toBe('RATE_LIMITED');
    } finally {
      await closeApp(limited);
    }
  });
});
```

- [ ] **Step 5: Run it to verify it fails**

Run: `npm run test -w server -- test/auth.test.ts`
Expected: FAIL — every login returns 404 because `/api/auth/login` does not exist yet.

- [ ] **Step 6: Implement schemas, the auth plugin, and the routes**

`PlaywrightPlatform/server/src/schemas/common.ts`:

```ts
import { z } from 'zod';
import type { User } from '../types';

export const roleSchema = z.enum(['ADMIN', 'USER', 'VIEWER']);
export const userStatusSchema = z.enum(['ACTIVE', 'DISABLED']);

/** Path ids. The upper bound keeps absurd values from reaching PostgreSQL as out-of-range bigints. */
export const idParams = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const userDto = z.object({
  id: z.number(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export function toUserDto(user: User): z.infer<typeof userDto> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
```

`PlaywrightPlatform/server/src/schemas/auth.ts`:

```ts
import { z } from 'zod';
import { userDto } from './common';

export const loginBody = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
  client: z.enum(['web', 'extension']),
});

export const webLoginResponse = z.object({ user: userDto, csrfToken: z.string() });
export const extensionLoginResponse = z.object({ user: userDto, token: z.string(), expiresAt: z.string() });
export const meResponse = z.object({ user: userDto, csrfToken: z.string().nullable() });
```

`PlaywrightPlatform/server/src/plugins/auth.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { safeEqual } from '../security/tokens';
import type { AuthService } from '../services/auth-service';
import type { Actor, AuthContext, Role } from '../types';

export const SESSION_COOKIE = 'pw_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/** Resolves the caller once per request. Routes opt in to enforcement with the guards below. */
export function registerAuth(app: FastifyInstance, authService: AuthService): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const found = await authService.resolve(header.slice('Bearer '.length).trim(), 'EXTENSION');
      if (found) req.auth = { ...found, via: 'bearer' };
      return;
    }
    const cookieToken = req.cookies[SESSION_COOKIE];
    if (cookieToken) {
      const found = await authService.resolve(cookieToken, 'WEB');
      if (found) req.auth = { ...found, via: 'cookie' };
    }
  });
}

async function requireAuth(req: FastifyRequest): Promise<void> {
  if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
}

// Browsers attach cookies automatically, so cookie-authenticated writes must also
// prove they come from our own page. Bearer tokens are attached deliberately.
async function requireCsrf(req: FastifyRequest): Promise<void> {
  if (req.auth?.via !== 'cookie') return;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const sent = req.headers['x-csrf-token'];
  if (typeof sent !== 'string' || !safeEqual(sent, req.auth.session.csrfSecret)) {
    throw new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token. Reload the page and try again.');
  }
}

function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth || !roles.includes(req.auth.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this action.');
    }
  };
}

/** `preHandler` for any signed-in user. */
export const signedIn = [requireAuth, requireCsrf];
/** `preHandler` for ADMIN only. */
export const adminOnly = [requireAuth, requireCsrf, requireRole('ADMIN')];

/** Call only inside a route guarded by `signedIn` or `adminOnly`. */
export function actorOf(req: FastifyRequest): Actor {
  const auth = req.auth as AuthContext;
  return { userId: auth.user.id, email: auth.user.email, ip: req.ip };
}
```

`PlaywrightPlatform/server/src/routes/auth.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import { parse, shape } from '../http';
import { SESSION_COOKIE, signedIn } from '../plugins/auth';
import { extensionLoginResponse, loginBody, meResponse, webLoginResponse } from '../schemas/auth';
import { toUserDto } from '../schemas/common';
import type { AuthService } from '../services/auth-service';
import type { AuthContext } from '../types';

export interface AuthRouteDeps {
  auth: AuthService;
  config: Config;
}

export async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: deps.config.loginRateLimitMax,
          timeWindow: '15 minutes',
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (req, reply) => {
      const body = parse(loginBody, req.body);
      const result = await deps.auth.login({ ...body, ip: req.ip });

      if (body.client === 'web') {
        reply.setCookie(SESSION_COOKIE, result.token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: deps.config.nodeEnv === 'production',
          path: '/',
          expires: result.expiresAt,
        });
        return shape(webLoginResponse, { user: toUserDto(result.user), csrfToken: result.csrfToken });
      }
      return shape(extensionLoginResponse, {
        user: toUserDto(result.user),
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  app.post('/auth/logout', { preHandler: signedIn }, async (req, reply) => {
    await deps.auth.logout(req.auth as AuthContext, req.ip);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: signedIn }, async (req) => {
    const auth = req.auth as AuthContext;
    return shape(meResponse, {
      user: toUserDto(auth.user),
      csrfToken: auth.via === 'cookie' ? auth.session.csrfSecret : null,
    });
  });
}
```

- [ ] **Step 7: Wire auth into `app.ts`**

Replace `PlaywrightPlatform/server/src/app.ts` with:

```ts
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config';
import type { Db } from './db';
import { registerAuth, SESSION_COOKIE } from './plugins/auth';
import { registerErrorHandling } from './plugins/error-handler';
import { AuditRepository } from './repositories/audit-repository';
import { SessionRepository } from './repositories/session-repository';
import { UserRepository } from './repositories/user-repository';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { AuditService } from './services/audit-service';
import { AuthService } from './services/auth-service';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Absolute path of the built web app. When set, it is served with SPA fallback. */
  webRoot?: string;
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
];

export async function buildApp({ config, db }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : { level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    genReqId: () => randomUUID(),
  });

  registerErrorHandling(app);

  await app.register(helmet);
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization ?? req.cookies[SESSION_COOKIE] ?? req.ip,
  });

  // Composition root: the only place repositories and services are constructed.
  const users = new UserRepository(db);
  const sessions = new SessionRepository(db);
  const audit = new AuditService(new AuditRepository(db), app.log);
  const auth = new AuthService(users, sessions, audit);

  registerAuth(app, auth);

  await app.register(
    async (api) => {
      await api.register(healthRoutes, {
        ping: async () => {
          await db.raw('select 1');
        },
      });
      await api.register(authRoutes, { auth, config });
    },
    { prefix: '/api' },
  );

  return app;
}
```

(`SESSION_COOKIE` now lives in `plugins/auth.ts`; the copy that Task 1 declared in `app.ts` is gone.)

- [ ] **Step 8: Run the auth tests to verify they pass**

Run: `npm run test -w server -- test/auth.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 9: Write the failing seed test**

`PlaywrightPlatform/server/test/seed.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db';
import { seedAdmin } from '../src/seed';
import { verifyPassword } from '../src/security/passwords';
import { resetDb, testConfig } from './helpers';

describe('seedAdmin', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(testConfig().databaseUrl);
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetDb(db));

  const env = { ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'a-long-admin-password' };

  it('creates one ADMIN with a hashed password', async () => {
    expect(await seedAdmin(db, env)).toBe('created');
    const rows = await db('users').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'root@example.com', role: 'ADMIN', status: 'ACTIVE' });
    expect(rows[0].password_hash).not.toContain(env.ADMIN_PASSWORD);
    expect(await verifyPassword(rows[0].password_hash, env.ADMIN_PASSWORD)).toBe(true);
  });

  it('does nothing when that user already exists', async () => {
    await seedAdmin(db, env);
    expect(await seedAdmin(db, { ...env, ADMIN_PASSWORD: 'a-different-password' })).toBe('exists');
    const rows = await db('users').select('password_hash');
    expect(rows).toHaveLength(1);
    expect(await verifyPassword(rows[0].password_hash, env.ADMIN_PASSWORD)).toBe(true);
  });

  it('fails clearly when the variables are missing or the password is short', async () => {
    await expect(seedAdmin(db, {})).rejects.toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD/);
    await expect(seedAdmin(db, { ADMIN_EMAIL: 'a@example.com', ADMIN_PASSWORD: 'short' })).rejects.toThrow(
      /at least 8/,
    );
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `npm run test -w server -- test/seed.test.ts`
Expected: FAIL — cannot resolve `../src/seed`.

- [ ] **Step 11: Implement the seed and the CLI command**

`PlaywrightPlatform/server/src/seed.ts`:

```ts
import type { Db } from './db';
import { UserRepository } from './repositories/user-repository';
import { hashPassword } from './security/passwords';

/** Creates the first ADMIN from ADMIN_EMAIL / ADMIN_PASSWORD. Safe to run repeatedly. */
export async function seedAdmin(
  db: Db,
  env: Record<string, string | undefined>,
): Promise<'created' | 'exists'> {
  const email = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env to seed the first admin.');
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }

  const users = new UserRepository(db);
  if (await users.findByEmail(email)) return 'exists';

  await users.create({
    email,
    displayName: 'Administrator',
    passwordHash: await hashPassword(password),
    role: 'ADMIN',
  });
  return 'created';
}
```

In `PlaywrightPlatform/server/src/scripts/db.ts`, add the import and the `seed` branch:

```ts
import { seedAdmin } from '../seed';
```

```ts
    } else if (command === 'seed') {
      const outcome = await seedAdmin(db, process.env);
      console.log(outcome === 'created' ? 'Admin user created.' : 'Admin user already exists; nothing changed.');
    } else {
```

(The new branch goes between the `rollback` branch and the final `else`.)

- [ ] **Step 12: Run everything, then seed the development database**

```bash
npm run test -w server && npm run typecheck -w server
npm run db:seed
npm run db:seed
```

Expected: tests PASS (33 total); first seed prints `Admin user created.`, second prints `Admin user already exists; nothing changed.`

- [ ] **Step 13: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): add authentication, sessions, CSRF, audit log, and admin seed"
```

---

### Task 4: User management API

**Files:**
- Create: `PlaywrightPlatform/server/src/services/user-service.ts`, `schemas/users.ts`, `routes/users.ts`
- Modify: `PlaywrightPlatform/server/src/app.ts`
- Test: `PlaywrightPlatform/server/test/users.test.ts`

**Interfaces:**
- Consumes: `UserRepository`, `SessionRepository`, `AuditService`, `Actor`, `adminOnly`, `actorOf`, `idParams`, `userDto`, `toUserDto`, `hashPassword`, `isUniqueViolation`
- Produces:
  - `UserService.list(): Promise<User[]>`
  - `UserService.create(actor, { email, displayName, password, role }): Promise<User>` — 409 `EMAIL_TAKEN`
  - `UserService.update(actor, id, { displayName?, role?, status?, password? }): Promise<User>` — 404, 409 `LAST_ADMIN`
  - Routes `GET /api/users`, `POST /api/users` (201), `PUT /api/users/:id` — response bodies `{ items: UserDto[] }` and `{ user: UserDto }`

- [ ] **Step 1: Write the failing tests**

`PlaywrightPlatform/server/test/users.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';

describe('user management', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;

  beforeAll(async () => {
    ctx = await makeApp();
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { email: 'admin@example.com', role: 'ADMIN' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
  });

  const newUser = { email: 'new@example.com', displayName: 'New Person', password: 'a-good-password', role: 'USER' };

  it('lets an ADMIN create and list users without exposing hashes', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: asAdmin, payload: newUser });
    expect(created.statusCode).toBe(201);
    expect(created.json().user).toMatchObject({ email: 'new@example.com', role: 'USER', status: 'ACTIVE' });

    const list = await ctx.app.inject({ method: 'GET', url: '/api/users', headers: asAdmin });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.map((u: { email: string }) => u.email)).toEqual([
      'admin@example.com',
      'new@example.com',
    ]);
    expect(list.body).not.toMatch(/password/i);
  });

  it('the created user can sign in with the given password', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: asAdmin, payload: newUser });
    await expect(loginExt(ctx.app, newUser.email, newUser.password)).resolves.toBeDefined();
  });

  it('rejects a duplicate email regardless of case', async () => {
    await ctx.app.inject({ method: 'POST', url: '/api/users', headers: asAdmin, payload: newUser });
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asAdmin,
      payload: { ...newUser, email: 'NEW@example.com' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('EMAIL_TAKEN');
  });

  it('validates the body', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asAdmin,
      payload: { email: 'bad', displayName: '', password: 'short', role: 'ROOT' },
    });
    expect(res.statusCode).toBe(400);
    const paths = res.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['email', 'displayName', 'password', 'role']));
  });

  it.each(['USER', 'VIEWER'] as const)('forbids every user route to a %s', async (role) => {
    const other = await createUser(ctx.db, { role });
    const headers = (await loginExt(ctx.app, other.email, other.password)).headers;
    const calls = [
      ctx.app.inject({ method: 'GET', url: '/api/users', headers }),
      ctx.app.inject({ method: 'POST', url: '/api/users', headers, payload: newUser }),
      ctx.app.inject({ method: 'PUT', url: `/api/users/${admin.id}`, headers, payload: { role: 'VIEWER' } }),
    ];
    for (const res of await Promise.all(calls)) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('requires a session for every user route', async () => {
    const calls = [
      ctx.app.inject({ method: 'GET', url: '/api/users' }),
      ctx.app.inject({ method: 'POST', url: '/api/users', payload: newUser }),
      ctx.app.inject({ method: 'PUT', url: '/api/users/1', payload: { role: 'VIEWER' } }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('changes role and display name', async () => {
    const target = await createUser(ctx.db, { role: 'VIEWER' });
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/users/${target.id}`,
      headers: asAdmin,
      payload: { role: 'USER', displayName: 'Renamed' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user).toMatchObject({ role: 'USER', displayName: 'Renamed' });
  });

  it('disabling a user ends their sessions and blocks new logins', async () => {
    const target = await createUser(ctx.db, { role: 'USER' });
    const theirs = (await loginExt(ctx.app, target.email, target.password)).headers;

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/users/${target.id}`,
      headers: asAdmin,
      payload: { status: 'DISABLED' },
    });
    expect(res.statusCode).toBe(200);

    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: theirs });
    expect(me.statusCode).toBe(401);
    await expect(loginExt(ctx.app, target.email, target.password)).rejects.toThrow(/401/);
  });

  it('changing a password ends existing sessions and the new password works', async () => {
    const target = await createUser(ctx.db, { role: 'USER' });
    const theirs = (await loginExt(ctx.app, target.email, target.password)).headers;

    await ctx.app.inject({
      method: 'PUT',
      url: `/api/users/${target.id}`,
      headers: asAdmin,
      payload: { password: 'a-brand-new-password' },
    });

    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: theirs });
    expect(me.statusCode).toBe(401);
    await expect(loginExt(ctx.app, target.email, 'a-brand-new-password')).resolves.toBeDefined();
  });

  it('protects the last active ADMIN from demotion and disabling', async () => {
    for (const payload of [{ role: 'USER' }, { status: 'DISABLED' }]) {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/users/${admin.id}`,
        headers: asAdmin,
        payload,
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('LAST_ADMIN');
    }
  });

  it('allows demoting an ADMIN when another active ADMIN exists', async () => {
    const second = await createUser(ctx.db, { role: 'ADMIN' });
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/users/${second.id}`,
      headers: asAdmin,
      payload: { role: 'USER' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('returns 404 for an unknown id and 400 for an id that is not a sane number', async () => {
    const missing = await ctx.app.inject({
      method: 'PUT',
      url: '/api/users/9999',
      headers: asAdmin,
      payload: { role: 'USER' },
    });
    expect(missing.statusCode).toBe(404);

    for (const id of ['abc', '0', '-1', '99999999999999999999']) {
      const res = await ctx.app.inject({
        method: 'PUT',
        url: `/api/users/${id}`,
        headers: asAdmin,
        payload: { role: 'USER' },
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it('rejects an empty update', async () => {
    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/users/${admin.id}`,
      headers: asAdmin,
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('audits create and update without recording passwords', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/users', headers: asAdmin, payload: newUser });
    const id = created.json().user.id;
    await ctx.app.inject({
      method: 'PUT',
      url: `/api/users/${id}`,
      headers: asAdmin,
      payload: { password: 'another-good-password' },
    });

    const rows = await ctx.db('audit_logs').where({ resource: 'user' }).orderBy('id');
    expect(rows.map((r: { action: string }) => r.action)).toEqual(['user.create', 'user.update']);
    expect(rows[0]).toMatchObject({ user_id: admin.id, resource_id: String(id), result: 'SUCCESS' });
    const text = JSON.stringify(rows);
    expect(text).not.toContain(newUser.password);
    expect(text).not.toContain('another-good-password');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w server -- test/users.test.ts`
Expected: FAIL — `/api/users` returns 404.

- [ ] **Step 3: Implement the schemas, service, and routes**

`PlaywrightPlatform/server/src/schemas/users.ts`:

```ts
import { z } from 'zod';
import { roleSchema, userDto, userStatusSchema } from './common';

const displayName = z.string().trim().min(1, 'Display name is required.').max(120);
const password = z.string().min(8, 'Password must be at least 8 characters.').max(200);

export const createUserBody = z.object({
  email: z.string().trim().email().max(254),
  displayName,
  password,
  role: roleSchema,
});

export const updateUserBody = z
  .object({
    displayName: displayName.optional(),
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
    password: password.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to change.',
  });

export const userResponse = z.object({ user: userDto });
export const userListResponse = z.object({ items: z.array(userDto) });
```

`PlaywrightPlatform/server/src/services/user-service.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { isUniqueViolation } from '../db';
import { AppError, notFound } from '../errors';
import type { SessionRepository } from '../repositories/session-repository';
import type { UserRepository } from '../repositories/user-repository';
import { hashPassword } from '../security/passwords';
import type { Actor, Role, User, UserStatus } from '../types';
import type { AuditService } from './audit-service';

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  role: Role;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: Role;
  status?: UserStatus;
  password?: string;
}

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly log: FastifyBaseLogger,
  ) {}

  list(): Promise<User[]> {
    return this.users.list();
  }

  async create(actor: Actor, input: CreateUserInput): Promise<User> {
    let user: User;
    try {
      user = await this.users.create({
        email: input.email,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'EMAIL_TAKEN', `A user with the email ${input.email} already exists.`);
      }
      throw err;
    }

    await this.audit.record({
      userId: actor.userId,
      userEmail: actor.email,
      action: 'user.create',
      resource: 'user',
      resourceId: String(user.id),
      result: 'SUCCESS',
      ip: actor.ip,
      details: { email: user.email, role: user.role },
    });
    this.log.info(`[USER] Created user ${user.id}`);
    return user;
  }

  async update(actor: Actor, id: number, input: UpdateUserInput): Promise<User> {
    const existing = await this.users.findById(id);
    if (!existing) throw notFound('User');

    const losesAdmin =
      existing.role === 'ADMIN' &&
      existing.status === 'ACTIVE' &&
      ((input.role !== undefined && input.role !== 'ADMIN') || input.status === 'DISABLED');
    if (losesAdmin && (await this.users.countActiveAdmins()) <= 1) {
      throw new AppError(409, 'LAST_ADMIN', 'This is the last active administrator and cannot be demoted or disabled.');
    }

    const updated = await this.users.update(id, {
      displayName: input.displayName,
      role: input.role,
      status: input.status,
      passwordHash: input.password === undefined ? undefined : await hashPassword(input.password),
    });
    if (!updated) throw notFound('User');

    // A disabled account or a changed password must not leave old sessions usable.
    if (input.status === 'DISABLED' || input.password !== undefined) {
      await this.sessions.revokeAllForUser(id);
    }

    await this.audit.record({
      userId: actor.userId,
      userEmail: actor.email,
      action: 'user.update',
      resource: 'user',
      resourceId: String(id),
      result: 'SUCCESS',
      ip: actor.ip,
      details: {
        changed: Object.entries(input)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
      },
    });
    this.log.info(`[USER] Updated user ${id}`);
    return updated;
  }
}
```

`PlaywrightPlatform/server/src/routes/users.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { parse, shape } from '../http';
import { actorOf, adminOnly } from '../plugins/auth';
import { idParams, toUserDto } from '../schemas/common';
import { createUserBody, updateUserBody, userListResponse, userResponse } from '../schemas/users';
import type { UserService } from '../services/user-service';

export interface UserRouteDeps {
  users: UserService;
}

export async function userRoutes(app: FastifyInstance, deps: UserRouteDeps): Promise<void> {
  app.get('/users', { preHandler: adminOnly }, async () => {
    const items = await deps.users.list();
    return shape(userListResponse, { items: items.map(toUserDto) });
  });

  app.post('/users', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(createUserBody, req.body);
    const user = await deps.users.create(actorOf(req), body);
    return reply.status(201).send(shape(userResponse, { user: toUserDto(user) }));
  });

  app.put('/users/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateUserBody, req.body);
    const user = await deps.users.update(actorOf(req), id, body);
    return shape(userResponse, { user: toUserDto(user) });
  });
}
```

- [ ] **Step 4: Wire it into `app.ts`**

In `PlaywrightPlatform/server/src/app.ts` add two imports:

```ts
import { userRoutes } from './routes/users';
import { UserService } from './services/user-service';
```

After `const auth = new AuthService(users, sessions, audit);` add:

```ts
  const userService = new UserService(users, sessions, audit, app.log);
```

After `await api.register(authRoutes, { auth, config });` add:

```ts
      await api.register(userRoutes, { users: userService });
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w server && npm run typecheck -w server`
Expected: PASS — `users.test.ts` 15 tests (the `it.each` counts as 2); 48 total.

- [ ] **Step 6: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): add admin-only user management API"
```

---

### Task 5: Projects API

**Files:**
- Create: `PlaywrightPlatform/server/src/repositories/project-repository.ts`, `services/project-service.ts`, `schemas/projects.ts`, `routes/projects.ts`
- Modify: `PlaywrightPlatform/server/src/types.ts`, `src/app.ts`
- Test: `PlaywrightPlatform/server/test/projects.test.ts`

**Interfaces:**
- Consumes: `Db`, `isUniqueViolation`, `AppError`, `notFound`, `AuditService`, `Actor`, `signedIn`, `adminOnly`, `actorOf`, `idParams`, `parse`, `shape`
- Produces:
  - Types: `ProjectStatus = 'ACTIVE'|'ARCHIVED'|'DELETED'`; `Project { id, name, description, status, autoUseSkills, createdAt: Date, updatedAt: Date }`; `ProjectListItem extends Project { scriptCount: number; lastRunStatus: string|null; lastRunAt: Date|null }`; `ProjectOverview { totalScripts, passedScripts, failedScripts, notExecuted: number; lastExecutionAt: Date|null }`
  - `ProjectService.list({ search?, status, page, pageSize })` → `{ items: ProjectListItem[]; total: number }`; `.get(id)` → `{ project, overview }`; `.create(actor, { name, description })`; `.update(actor, id, { name?, description?, status? })`; `.remove(actor, id)`
  - Routes: `GET /api/projects` → `{ items, total, page, pageSize }`; `POST /api/projects` (201) → `{ project }`; `GET /api/projects/:id` → `{ project, overview }`; `PUT /api/projects/:id` → `{ project }`; `DELETE /api/projects/:id` → 204
  - Error codes: 409 `PROJECT_NAME_TAKEN`

- [ ] **Step 1: Write the failing tests**

`PlaywrightPlatform/server/test/projects.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';

describe('projects', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;

  beforeAll(async () => {
    ctx = await makeApp();
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
  });

  const create = (payload: unknown, headers = asAdmin) =>
    ctx.app.inject({ method: 'POST', url: '/api/projects', headers, payload: payload as object });
  const list = (query = '', headers = asAdmin) =>
    ctx.app.inject({ method: 'GET', url: `/api/projects${query}`, headers });
  const names = (res: { json(): { items: { name: string }[] } }) => res.json().items.map((p) => p.name);

  it('creates a project and returns it with an id', async () => {
    const res = await create({ name: 'E-Commerce', description: 'Playwright E2E automation' });
    expect(res.statusCode).toBe(201);
    expect(res.json().project).toMatchObject({
      name: 'E-Commerce',
      description: 'Playwright E2E automation',
      status: 'ACTIVE',
      autoUseSkills: true,
    });
    expect(res.json().project.id).toBeGreaterThan(0);
  });

  it('trims the name and treats names as case-insensitive duplicates', async () => {
    const first = await create({ name: '  Shop  ' });
    expect(first.json().project.name).toBe('Shop');
    expect(first.json().project.description).toBe('');

    const second = await create({ name: 'shop' });
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({
      code: 'PROJECT_NAME_TAKEN',
      message: 'A project named "shop" already exists.',
    });
  });

  it('rejects an empty, whitespace-only, or oversized name', async () => {
    for (const name of ['', '   ', 'x'.repeat(500)]) {
      const res = await create({ name });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('lists newest first with script count and last run status', async () => {
    const a = (await create({ name: 'Alpha' })).json().project;
    await create({ name: 'Beta' });
    await ctx.db('test_scripts').insert([
      { project_id: a.id, name: 'Login', script_content: '// 1' },
      { project_id: a.id, name: 'Checkout', script_content: '// 2' },
      { project_id: a.id, name: 'Old', script_content: '// 3', status: 'DELETED' },
    ]);
    await ctx.db('test_executions').insert({
      project_id: a.id,
      trigger_type: 'MANUAL',
      status: 'PASSED',
      created_at: new Date(Date.now() - 60_000),
    });
    await ctx.db('test_executions').insert({ project_id: a.id, trigger_type: 'MANUAL', status: 'FAILED' });

    const res = await list();
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(names(res)).toEqual(['Beta', 'Alpha']);
    expect(body.items[1]).toMatchObject({ scriptCount: 2, lastRunStatus: 'FAILED' });
    expect(body.items[0]).toMatchObject({ scriptCount: 0, lastRunStatus: null, lastRunAt: null });
  });

  it('searches name and description, case-insensitively', async () => {
    await create({ name: 'Banking Application', description: 'core flows' });
    await create({ name: 'CRM', description: 'Customer BANKING portal' });
    await create({ name: 'E-Commerce' });
    expect(names(await list('?search=banking')).sort()).toEqual(['Banking Application', 'CRM']);
  });

  it('treats % and _ in a search as literal characters', async () => {
    await create({ name: '100% Coverage' });
    await create({ name: 'snake_case' });
    await create({ name: 'Plain' });
    expect(names(await list('?search=%25'))).toEqual(['100% Coverage']);
    expect(names(await list('?search=_'))).toEqual(['snake_case']);
  });

  it('paginates and validates paging input', async () => {
    for (const name of ['One', 'Two', 'Three']) await create({ name });
    const page2 = await list('?page=2&pageSize=2');
    expect(page2.json()).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(names(page2)).toEqual(['One']);

    for (const query of ['?page=0', '?pageSize=0', '?pageSize=101', '?page=abc', '?status=NOPE']) {
      expect((await list(query)).statusCode).toBe(400);
    }
  });

  it('gets one project with overview counters', async () => {
    const project = (await create({ name: 'Counted' })).json().project;
    await ctx.db('test_scripts').insert([
      { project_id: project.id, name: 'A', script_content: '//', lifecycle_state: 'PASSED' },
      { project_id: project.id, name: 'B', script_content: '//', lifecycle_state: 'FAILED' },
      { project_id: project.id, name: 'C', script_content: '//', lifecycle_state: 'SAVED' },
      { project_id: project.id, name: 'D', script_content: '//', lifecycle_state: 'PASSED', status: 'DELETED' },
    ]);
    await ctx.db('test_executions').insert({ project_id: project.id, trigger_type: 'API', status: 'PASSED' });

    const res = await ctx.app.inject({ method: 'GET', url: `/api/projects/${project.id}`, headers: asAdmin });
    expect(res.statusCode).toBe(200);
    expect(res.json().project.name).toBe('Counted');
    expect(res.json().overview).toMatchObject({
      totalScripts: 3,
      passedScripts: 1,
      failedScripts: 1,
      notExecuted: 1,
    });
    expect(typeof res.json().overview.lastExecutionAt).toBe('string');
  });

  it('updates name and description and rejects a clashing rename', async () => {
    const a = (await create({ name: 'Alpha' })).json().project;
    await create({ name: 'Beta' });

    const ok = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${a.id}`,
      headers: asAdmin,
      payload: { name: 'Alpha 2', description: 'renamed' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().project).toMatchObject({ name: 'Alpha 2', description: 'renamed' });

    const clash = await ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${a.id}`,
      headers: asAdmin,
      payload: { name: 'BETA' },
    });
    expect(clash.statusCode).toBe(409);
  });

  it('archives and restores, and filters by status', async () => {
    const p = (await create({ name: 'Archivable' })).json().project;
    const put = (status: string) =>
      ctx.app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers: asAdmin, payload: { status } });

    expect((await put('ARCHIVED')).json().project.status).toBe('ARCHIVED');
    expect(names(await list())).toEqual([]);
    expect(names(await list('?status=ARCHIVED'))).toEqual(['Archivable']);

    expect((await put('ACTIVE')).json().project.status).toBe('ACTIVE');
    expect((await put('DELETED')).statusCode).toBe(400);
  });

  it('soft-deletes: row and history stay, the project disappears, the name is reusable', async () => {
    const p = (await create({ name: 'Doomed' })).json().project;
    await ctx.db('test_executions').insert({ project_id: p.id, trigger_type: 'MANUAL', status: 'PASSED' });

    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: asAdmin });
    expect(del.statusCode).toBe(204);

    const row = await ctx.db('projects').where({ id: p.id }).first();
    expect(row.status).toBe('DELETED');
    expect(row.deleted_by).toBe(admin.id);
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(await ctx.db('test_executions').where({ project_id: p.id })).toHaveLength(1);

    const url = `/api/projects/${p.id}`;
    expect((await ctx.app.inject({ method: 'GET', url, headers: asAdmin })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'PUT', url, headers: asAdmin, payload: { name: 'X' } })).statusCode).toBe(404);
    expect((await ctx.app.inject({ method: 'DELETE', url, headers: asAdmin })).statusCode).toBe(404);
    expect(names(await list())).toEqual([]);
    expect(names(await list('?status=DELETED'))).toEqual(['Doomed']);

    expect((await create({ name: 'Doomed' })).statusCode).toBe(201);
  });

  it('returns 404 for an unknown id and 400 for an id that is not a sane number', async () => {
    expect((await ctx.app.inject({ method: 'GET', url: '/api/projects/9999', headers: asAdmin })).statusCode).toBe(404);
    for (const id of ['abc', '0', '1.5', '99999999999999999999']) {
      const res = await ctx.app.inject({ method: 'GET', url: `/api/projects/${id}`, headers: asAdmin });
      expect(res.statusCode).toBe(400);
    }
  });

  it.each(['USER', 'VIEWER'] as const)('lets a %s read but not change projects', async (role) => {
    const p = (await create({ name: 'Readable' })).json().project;
    const other = await createUser(ctx.db, { role });
    const headers = (await loginExt(ctx.app, other.email, other.password)).headers;

    expect((await list('', headers)).statusCode).toBe(200);
    expect((await ctx.app.inject({ method: 'GET', url: `/api/projects/${p.id}`, headers })).statusCode).toBe(200);
    expect((await list('?status=DELETED', headers)).statusCode).toBe(403);

    const writes = [
      create({ name: 'Nope' }, headers),
      ctx.app.inject({ method: 'PUT', url: `/api/projects/${p.id}`, headers, payload: { name: 'Nope' } }),
      ctx.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers }),
    ];
    for (const res of await Promise.all(writes)) expect(res.statusCode).toBe(403);
  });

  it('requires a session for every project route', async () => {
    const calls = [
      ctx.app.inject({ method: 'GET', url: '/api/projects' }),
      ctx.app.inject({ method: 'POST', url: '/api/projects', payload: { name: 'X' } }),
      ctx.app.inject({ method: 'GET', url: '/api/projects/1' }),
      ctx.app.inject({ method: 'PUT', url: '/api/projects/1', payload: { name: 'X' } }),
      ctx.app.inject({ method: 'DELETE', url: '/api/projects/1' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('enforces CSRF on cookie-authenticated project writes', async () => {
    const web = await loginWeb(ctx.app, admin.email, admin.password);
    const without = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: web.cookies,
      payload: { name: 'No Token' },
    });
    expect(without.statusCode).toBe(403);
    const withToken = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: web.cookies,
      headers: web.headers,
      payload: { name: 'With Token' },
    });
    expect(withToken.statusCode).toBe(201);
  });

  it('audits create, update, archive, and delete', async () => {
    const p = (await create({ name: 'Audited' })).json().project;
    const url = `/api/projects/${p.id}`;
    await ctx.app.inject({ method: 'PUT', url, headers: asAdmin, payload: { description: 'd' } });
    await ctx.app.inject({ method: 'PUT', url, headers: asAdmin, payload: { status: 'ARCHIVED' } });
    await ctx.app.inject({ method: 'DELETE', url, headers: asAdmin });
    await create({ name: 'Audited' });
    await create({ name: 'audited' });

    const rows = await ctx.db('audit_logs').where({ resource: 'project' }).orderBy('id');
    expect(rows.map((r: { action: string; result: string }) => `${r.action}:${r.result}`)).toEqual([
      'project.create:SUCCESS',
      'project.update:SUCCESS',
      'project.archive:SUCCESS',
      'project.delete:SUCCESS',
      'project.create:SUCCESS',
      'project.create:FAILURE',
    ]);
    expect(rows[0]).toMatchObject({ user_id: admin.id, user_email: admin.email, resource_id: String(p.id) });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w server -- test/projects.test.ts`
Expected: FAIL — `/api/projects` returns 404.

- [ ] **Step 3: Add the project types**

Append to `PlaywrightPlatform/server/src/types.ts`:

```ts
export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

export interface Project {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  autoUseSkills: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectListItem extends Project {
  scriptCount: number;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
}

export interface ProjectOverview {
  totalScripts: number;
  passedScripts: number;
  failedScripts: number;
  notExecuted: number;
  lastExecutionAt: Date | null;
}
```

- [ ] **Step 4: Implement the repository**

`PlaywrightPlatform/server/src/repositories/project-repository.ts`:

```ts
import type { Db } from '../db';
import type { Project, ProjectListItem, ProjectOverview, ProjectStatus } from '../types';

interface ProjectRow {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  auto_use_skills: boolean;
  created_at: Date;
  updated_at: Date;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status,
    autoUseSkills: row.auto_use_skills,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Escapes LIKE wildcards so user text matches literally. Pairs with `escape '\'` in the query. */
function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}

export interface ProjectListQuery {
  search?: string;
  status: ProjectStatus;
  page: number;
  pageSize: number;
}

export interface ProjectPatch {
  name?: string;
  description?: string;
  status?: 'ACTIVE' | 'ARCHIVED';
}

export class ProjectRepository {
  constructor(private readonly db: Db) {}

  async list(query: ProjectListQuery): Promise<{ items: ProjectListItem[]; total: number }> {
    const filtered = this.db('projects as p').where('p.status', query.status);
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      filtered.whereRaw("(p.name ilike ? escape '\\' or p.description ilike ? escape '\\')", [pattern, pattern]);
    }

    const totalRow = await filtered.clone().count('* as n').first();
    const rows = await filtered
      .clone()
      .select(
        'p.*',
        this.db.raw(
          "(select count(*) from test_scripts s where s.project_id = p.id and s.status <> 'DELETED') as script_count",
        ),
        this.db.raw(
          '(select e.status from test_executions e where e.project_id = p.id order by e.created_at desc, e.id desc limit 1) as last_run_status',
        ),
        this.db.raw('(select max(e.created_at) from test_executions e where e.project_id = p.id) as last_run_at'),
      )
      .orderBy('p.created_at', 'desc')
      .orderBy('p.id', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      total: Number(totalRow?.n ?? 0),
      items: rows.map((row: ProjectRow & { script_count: number; last_run_status: string | null; last_run_at: Date | null }) => ({
        ...toProject(row),
        scriptCount: Number(row.script_count),
        lastRunStatus: row.last_run_status,
        lastRunAt: row.last_run_at,
      })),
    };
  }

  /** "Live" means not soft-deleted. */
  async findLiveById(id: number): Promise<Project | null> {
    const row = await this.db('projects').where({ id }).whereNot('status', 'DELETED').first();
    return row ? toProject(row) : null;
  }

  async overview(id: number): Promise<ProjectOverview> {
    const counts = await this.db('test_scripts')
      .where({ project_id: id })
      .whereNot('status', 'DELETED')
      .select(
        this.db.raw('count(*) as total'),
        this.db.raw("count(*) filter (where lifecycle_state = 'PASSED') as passed"),
        this.db.raw("count(*) filter (where lifecycle_state = 'FAILED') as failed"),
      )
      .first();
    const last = await this.db('test_executions').where({ project_id: id }).max('created_at as at').first();

    const total = Number(counts?.total ?? 0);
    const passed = Number(counts?.passed ?? 0);
    const failed = Number(counts?.failed ?? 0);
    return {
      totalScripts: total,
      passedScripts: passed,
      failedScripts: failed,
      notExecuted: total - passed - failed,
      lastExecutionAt: last?.at ?? null,
    };
  }

  async create(input: { name: string; description: string; createdBy: number }): Promise<Project> {
    const [row] = await this.db('projects')
      .insert({ name: input.name, description: input.description, created_by: input.createdBy })
      .returning('*');
    return toProject(row);
  }

  async update(id: number, patch: ProjectPatch): Promise<Project | null> {
    const changes: Record<string, unknown> = { updated_at: this.db.fn.now() };
    if (patch.name !== undefined) changes.name = patch.name;
    if (patch.description !== undefined) changes.description = patch.description;
    if (patch.status !== undefined) changes.status = patch.status;
    const [row] = await this.db('projects')
      .where({ id })
      .whereNot('status', 'DELETED')
      .update(changes)
      .returning('*');
    return row ? toProject(row) : null;
  }

  async softDelete(id: number, deletedBy: number): Promise<boolean> {
    const count = await this.db('projects')
      .where({ id })
      .whereNot('status', 'DELETED')
      .update({
        status: 'DELETED',
        deleted_at: this.db.fn.now(),
        deleted_by: deletedBy,
        updated_at: this.db.fn.now(),
      });
    return count > 0;
  }
}
```

- [ ] **Step 5: Implement the service**

`PlaywrightPlatform/server/src/services/project-service.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { isUniqueViolation } from '../db';
import { AppError, notFound } from '../errors';
import type { ProjectListQuery, ProjectPatch, ProjectRepository } from '../repositories/project-repository';
import type { Actor, Project, ProjectListItem, ProjectOverview } from '../types';
import type { AuditService } from './audit-service';

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly audit: AuditService,
    private readonly log: FastifyBaseLogger,
  ) {}

  list(query: ProjectListQuery): Promise<{ items: ProjectListItem[]; total: number }> {
    return this.projects.list(query);
  }

  async get(id: number): Promise<{ project: Project; overview: ProjectOverview }> {
    const project = await this.projects.findLiveById(id);
    if (!project) throw notFound('Project');
    return { project, overview: await this.projects.overview(id) };
  }

  async create(actor: Actor, input: { name: string; description: string }): Promise<Project> {
    let project: Project;
    try {
      project = await this.projects.create({ ...input, createdBy: actor.userId });
    } catch (err) {
      if (isUniqueViolation(err)) {
        await this.record(actor, 'project.create', null, 'FAILURE', { name: input.name, reason: 'name taken' });
        throw this.nameTaken(input.name);
      }
      throw err;
    }
    await this.record(actor, 'project.create', project.id, 'SUCCESS', { name: project.name });
    this.log.info(`[PROJECT] Created project ${project.id}`);
    return project;
  }

  async update(actor: Actor, id: number, patch: ProjectPatch): Promise<Project> {
    const existing = await this.projects.findLiveById(id);
    if (!existing) throw notFound('Project');

    let updated: Project | null;
    try {
      updated = await this.projects.update(id, patch);
    } catch (err) {
      if (isUniqueViolation(err)) throw this.nameTaken(patch.name ?? existing.name);
      throw err;
    }
    if (!updated) throw notFound('Project');

    const archiving = patch.status === 'ARCHIVED' && existing.status !== 'ARCHIVED';
    await this.record(actor, archiving ? 'project.archive' : 'project.update', id, 'SUCCESS', {
      changed: Object.keys(patch),
    });
    this.log.info(`[PROJECT] ${archiving ? 'Archived' : 'Updated'} project ${id}`);
    return updated;
  }

  async remove(actor: Actor, id: number): Promise<void> {
    const deleted = await this.projects.softDelete(id, actor.userId);
    if (!deleted) throw notFound('Project');
    await this.record(actor, 'project.delete', id, 'SUCCESS');
    this.log.info(`[PROJECT] Deleted project ${id}`);
  }

  private nameTaken(name: string): AppError {
    return new AppError(409, 'PROJECT_NAME_TAKEN', `A project named "${name}" already exists.`);
  }

  private record(
    actor: Actor,
    action: string,
    id: number | null,
    result: 'SUCCESS' | 'FAILURE',
    details?: Record<string, unknown>,
  ): Promise<void> {
    return this.audit.record({
      userId: actor.userId,
      userEmail: actor.email,
      action,
      resource: 'project',
      resourceId: id === null ? null : String(id),
      result,
      ip: actor.ip,
      details,
    });
  }
}
```

- [ ] **Step 6: Implement the schemas and routes**

`PlaywrightPlatform/server/src/schemas/projects.ts`:

```ts
import { z } from 'zod';
import type { Project, ProjectListItem, ProjectOverview } from '../types';

const name = z.string().trim().min(1, 'Project name is required.').max(120, 'Project name is too long (120 max).');
const description = z.string().trim().max(2000, 'Description is too long (2000 max).');
const status = z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']);

export const createProjectBody = z.object({ name, description: description.default('') });

export const updateProjectBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to change.',
  });

export const listProjectsQuery = z.object({
  search: z.string().trim().max(200).optional(),
  status: status.default('ACTIVE'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

const projectDto = z.object({
  id: z.number(),
  name: z.string(),
  description: z.string(),
  status,
  autoUseSkills: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const projectListItemDto = projectDto.extend({
  scriptCount: z.number(),
  lastRunStatus: z.string().nullable(),
  lastRunAt: z.string().nullable(),
});

const overviewDto = z.object({
  totalScripts: z.number(),
  passedScripts: z.number(),
  failedScripts: z.number(),
  notExecuted: z.number(),
  lastExecutionAt: z.string().nullable(),
});

export const projectResponse = z.object({ project: projectDto });
export const projectDetailResponse = z.object({ project: projectDto, overview: overviewDto });
export const projectListResponse = z.object({
  items: z.array(projectListItemDto),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export function toProjectDto(p: Project): z.infer<typeof projectDto> {
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    autoUseSkills: p.autoUseSkills,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

export function toProjectListItemDto(p: ProjectListItem): z.infer<typeof projectListItemDto> {
  return {
    ...toProjectDto(p),
    scriptCount: p.scriptCount,
    lastRunStatus: p.lastRunStatus,
    lastRunAt: p.lastRunAt ? p.lastRunAt.toISOString() : null,
  };
}

export function toOverviewDto(o: ProjectOverview): z.infer<typeof overviewDto> {
  return { ...o, lastExecutionAt: o.lastExecutionAt ? o.lastExecutionAt.toISOString() : null };
}
```

`PlaywrightPlatform/server/src/routes/projects.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';
import { parse, shape } from '../http';
import { actorOf, adminOnly, signedIn } from '../plugins/auth';
import { idParams } from '../schemas/common';
import {
  createProjectBody,
  listProjectsQuery,
  projectDetailResponse,
  projectListResponse,
  projectResponse,
  toOverviewDto,
  toProjectDto,
  toProjectListItemDto,
  updateProjectBody,
} from '../schemas/projects';
import type { ProjectService } from '../services/project-service';

export interface ProjectRouteDeps {
  projects: ProjectService;
}

export async function projectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): Promise<void> {
  app.get('/projects', { preHandler: signedIn }, async (req) => {
    const query = parse(listProjectsQuery, req.query);
    if (query.status === 'DELETED' && req.auth?.user.role !== 'ADMIN') {
      throw new AppError(403, 'FORBIDDEN', 'Only administrators can list deleted projects.');
    }
    const { items, total } = await deps.projects.list(query);
    return shape(projectListResponse, {
      items: items.map(toProjectListItemDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.post('/projects', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(createProjectBody, req.body);
    const project = await deps.projects.create(actorOf(req), body);
    return reply.status(201).send(shape(projectResponse, { project: toProjectDto(project) }));
  });

  app.get('/projects/:id', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { project, overview } = await deps.projects.get(id);
    return shape(projectDetailResponse, { project: toProjectDto(project), overview: toOverviewDto(overview) });
  });

  app.put('/projects/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateProjectBody, req.body);
    const project = await deps.projects.update(actorOf(req), id, body);
    return shape(projectResponse, { project: toProjectDto(project) });
  });

  app.delete('/projects/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deps.projects.remove(actorOf(req), id);
    return reply.status(204).send();
  });
}
```

- [ ] **Step 7: Wire it into `app.ts`**

In `PlaywrightPlatform/server/src/app.ts` add three imports:

```ts
import { ProjectRepository } from './repositories/project-repository';
import { projectRoutes } from './routes/projects';
import { ProjectService } from './services/project-service';
```

After `const userService = new UserService(users, sessions, audit, app.log);` add:

```ts
  const projectService = new ProjectService(new ProjectRepository(db), audit, app.log);
```

After `await api.register(userRoutes, { users: userService });` add:

```ts
      await api.register(projectRoutes, { projects: projectService });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test -w server && npm run typecheck -w server`
Expected: PASS — `projects.test.ts` 17 tests (the `it.each` counts as 2); 65 total.

- [ ] **Step 9: Verify the layering rule mechanically**

Run from `PlaywrightPlatform/server`:

```bash
grep -rnE "from '(\.\./)+repositories|from 'knex'|from '\.\./db'" src/routes ; echo "routes: exit $?"
grep -rnE "FastifyRequest|FastifyReply" src/services ; echo "services: exit $?"
```

Expected: no matching lines, and both `exit 1` (grep found nothing).

- [ ] **Step 10: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): add projects API with search, archive, soft delete, and audit"
```

---

### Task 6: Web app scaffold, API client, sign-in, and app shell

**Files:**
- Create: `PlaywrightPlatform/web/package.json`, `tsconfig.json`, `vite.config.ts`, `playwright.config.ts`, `index.html`
- Create: `PlaywrightPlatform/web/src/main.tsx`, `App.tsx`, `styles.css`, `api/client.ts`, `api/types.ts`, `api/auth.ts`, `auth/AuthContext.tsx`, `components/AppShell.tsx`, `pages/LoginPage.tsx`, `pages/ProjectsPage.tsx`
- Create: `PlaywrightPlatform/web/e2e/helpers.ts`, `e2e/auth.spec.ts`
- Create: `PlaywrightPlatform/server/src/scripts/e2e-serve.ts`
- Modify: `PlaywrightPlatform/package.json` (`"workspaces": ["server", "web"]`)

**Interfaces:**
- Consumes: server routes `/api/auth/login|logout|me`; `buildApp`, `loadConfig`, `createDb`, `rollbackAll`, `migrateLatest`, `UserRepository`, `hashPassword`
- Produces:
  - `api<T>(path, { method?, body? }): Promise<T>`, `class ApiError { status, code, message, details }`, `setCsrfToken(token|null)`, `setUnauthorizedHandler(fn|null)`
  - Types `Role`, `User`, `Project`, `ProjectListItem`, `ProjectOverview`, `ProjectStatus`
  - `useAuth(): { user: User|null; loading: boolean; login(email, password): Promise<void>; logout(): Promise<void> }`
  - `<AppShell>` layout with `<Outlet/>`
  - E2E: `ADMIN`, `VIEWER` credentials and `signIn(page, creds)` in `e2e/helpers.ts`; server on `http://127.0.0.1:3100`, web on `http://localhost:5174`

- [ ] **Step 1: Create the web package**

Set `"workspaces": ["server", "web"]` in `PlaywrightPlatform/package.json`.

`PlaywrightPlatform/web/package.json`:

```json
{
  "name": "@playwright-platform/web",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test:e2e": "playwright test"
  }
}
```

`PlaywrightPlatform/web/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "isolatedModules": true,
    "types": ["vite/client", "node"]
  },
  "include": ["src", "e2e", "vite.config.ts", "playwright.config.ts"]
}
```

`PlaywrightPlatform/web/vite.config.ts`:

```ts
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The browser only ever talks to the Vite origin; /api is proxied to the server,
// so cookies are same-origin and no CORS is involved in development.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': process.env.VITE_API_TARGET ?? 'http://127.0.0.1:3000' },
  },
});
```

`PlaywrightPlatform/web/index.html`:

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Playwright AI Platform</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Install:

```bash
cd PlaywrightPlatform
npm install -w web react@^18 react-dom@^18 react-router-dom@^6
npm install -w web -D vite @vitejs/plugin-react typescript @types/react@^18 @types/react-dom@^18 @types/node @playwright/test
npx -w web playwright install chromium
```

- [ ] **Step 2: Write the E2E server script**

`PlaywrightPlatform/server/src/scripts/e2e-serve.ts`:

```ts
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
```

- [ ] **Step 3: Write the Playwright config and the failing sign-in tests**

`PlaywrightPlatform/web/playwright.config.ts`:

```ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:5174', trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run e2e:serve -w server',
      cwd: '..',
      url: 'http://127.0.0.1:3100/api/health',
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: 'npm run dev -w web -- --port 5174 --strictPort',
      cwd: '..',
      url: 'http://localhost:5174',
      env: { VITE_API_TARGET: 'http://127.0.0.1:3100' },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
```

`PlaywrightPlatform/web/e2e/helpers.ts`:

```ts
import { expect, type Page } from '@playwright/test';

export interface Credentials {
  email: string;
  password: string;
}

// Must match E2E_USERS in server/src/scripts/e2e-serve.ts.
export const ADMIN: Credentials = { email: 'admin@e2e.test', password: 'Admin-e2e-pass1' };
export const VIEWER: Credentials = { email: 'viewer@e2e.test', password: 'Viewer-e2e-pass1' };

export async function signIn(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}
```

`PlaywrightPlatform/web/e2e/auth.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { ADMIN, signIn } from './helpers';

test('an unauthenticated visitor is sent to the login page', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a wrong password shows the server message and stays on the login page', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
  await expect(page).toHaveURL(/\/login$/);
});

test('an admin signs in, sees the shell, survives a reload, and signs out', async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.getByText(ADMIN.email)).toBeVisible();
  await expect(page.getByText('ADMIN', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
});
```

- [ ] **Step 4: Run them to verify they fail**

Make sure PostgreSQL is up and no Vitest run is in progress, then:

Run: `npm run test:e2e -w web`
Expected: FAIL — the web server starts but `/src/main.tsx` does not exist, so no login form is found.

- [ ] **Step 5: Write the API layer**

`PlaywrightPlatform/web/src/api/types.ts`:

```ts
export type Role = 'ADMIN' | 'USER' | 'VIEWER';
export type UserStatus = 'ACTIVE' | 'DISABLED';
export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  autoUseSkills: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends Project {
  scriptCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
}

export interface ProjectOverview {
  totalScripts: number;
  passedScripts: number;
  failedScripts: number;
  notExecuted: number;
  lastExecutionAt: string | null;
}
```

`PlaywrightPlatform/web/src/api/client.ts`:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Kept in memory only. It is re-issued by /auth/me after a reload.
let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when a request other than the auth probes comes back 401 (session ended). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check that it is running and try again.', null);
  }

  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const err = data?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with status ${res.status}.`,
      err?.details ?? null,
    );
  }
  return data as T;
}

/** Message suitable for showing to the user. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected error.';
}
```

`PlaywrightPlatform/web/src/api/auth.ts`:

```ts
import { api } from './client';
import type { User } from './types';

export const authApi = {
  login: (email: string, password: string) =>
    api<{ user: User; csrfToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password, client: 'web' },
    }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  me: () => api<{ user: User; csrfToken: string | null }>('/auth/me'),
};
```

- [ ] **Step 6: Write the auth context**

`PlaywrightPlatform/web/src/auth/AuthContext.tsx`:

```tsx
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi } from '../api/auth';
import { setCsrfToken, setUnauthorizedHandler } from '../api/client';
import type { User } from '../api/types';

interface AuthValue {
  user: User | null;
  /** True until the first /auth/me probe finishes. */
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    authApi
      .me()
      .then(({ user: current, csrfToken }) => {
        setCsrfToken(csrfToken);
        setUser(current);
      })
      .catch(clear)
      .finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authApi.login(email, password);
    setCsrfToken(result.csrfToken);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      clear();
    }
  }, [clear]);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
```

- [ ] **Step 7: Write the shell, the login page, and the routes**

`PlaywrightPlatform/web/src/components/AppShell.tsx`:

```tsx
import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Sections that later sub-projects will build. Shown so the product shape is visible.
const COMING_SOON = ['Dashboard', 'Playwright Agents', 'CI/CD', 'Reports', 'Skills'];

export function AppShell() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">PLAYWRIGHT AI</div>
        <nav aria-label="Main">
          <span className="nav-item disabled" title="Coming soon">Dashboard</span>
          <NavLink className="nav-item" to="/projects">Projects</NavLink>
          {COMING_SOON.slice(1).map((label) => (
            <span key={label} className="nav-item disabled" title="Coming soon">
              {label}
            </span>
          ))}
          {user.role === 'ADMIN' && (
            <NavLink className="nav-item" to="/settings/users">Settings</NavLink>
          )}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">{user.email}</span>
          <span className="badge badge-neutral">{user.role}</span>
          <button className="btn btn-secondary" onClick={() => void logout()}>Sign out</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
```

`PlaywrightPlatform/web/src/pages/LoginPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { useAuth } from '../auth/AuthContext';

export function LoginPage() {
  const { user, login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to="/projects" replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email, password);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <div className="brand">PLAYWRIGHT AI</div>
        <h1>Sign in</h1>
        <label htmlFor="login-email">Email</label>
        <input id="login-email" type="email" autoComplete="username" required value={email}
          onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="login-password">Password</label>
        <input id="login-password" type="password" autoComplete="current-password" required value={password}
          onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
```

`PlaywrightPlatform/web/src/pages/ProjectsPage.tsx` (Task 7 replaces this file with the full page):

```tsx
export function ProjectsPage() {
  return <h1>Projects</h1>;
}
```

`PlaywrightPlatform/web/src/App.tsx`:

```tsx
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { ProjectsPage } from './pages/ProjectsPage';

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <AppShell />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}
```

`PlaywrightPlatform/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
```

- [ ] **Step 8: Write the stylesheet**

`PlaywrightPlatform/web/src/styles.css` (palette matches the extension's `sidepanel.css`):

```css
:root {
  --bg: #0d1117; --bg2: #161b22; --bg3: #21262d; --sidebar: #010409; --border: #30363d;
  --accent: #00d4aa; --text: #e6edf3; --text2: #8b949e;
  --danger: #f85149; --warn: #d29922; --success: #3fb950; --info: #58a6ff;
  --radius: 6px;
  --font: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
}
* { box-sizing: border-box; }
html, body, #root { height: 100%; margin: 0; }
body { background: var(--bg); color: var(--text); font: 14px/1.5 var(--font); }
h1 { font-size: 22px; margin: 0; }
h2 { font-size: 16px; margin: 0 0 12px; }
a { color: var(--info); text-decoration: none; }
a:hover { text-decoration: underline; }
.muted { color: var(--text2); }
.center { text-align: center; padding: 48px; }
.error { color: var(--danger); margin: 0; }

.shell { display: flex; height: 100%; }
.sidebar { width: 220px; flex: none; background: var(--sidebar); border-right: 1px solid var(--border); padding: 16px 12px; }
.brand { font-weight: 700; letter-spacing: 1px; color: var(--accent); margin-bottom: 16px; }
.nav-item { display: block; padding: 8px 10px; border-radius: var(--radius); color: var(--text); margin-bottom: 2px; }
.nav-item:hover { background: var(--bg3); text-decoration: none; }
.nav-item.active { background: var(--bg3); color: var(--accent); }
.nav-item.disabled { color: var(--text2); opacity: 0.55; cursor: not-allowed; }
.nav-item.disabled:hover { background: none; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.topbar { display: flex; justify-content: flex-end; align-items: center; gap: 12px; padding: 10px 24px; border-bottom: 1px solid var(--border); }
.content { padding: 24px; overflow: auto; flex: 1; }

.page-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
.toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; }
.toolbar label { color: var(--text2); }

.card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; margin-bottom: 20px; }
.stat-value { font-size: 26px; font-weight: 700; }
.stat-label { color: var(--text2); font-size: 12px; text-transform: uppercase; letter-spacing: 0.5px; }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--border); vertical-align: middle; }
th { color: var(--text2); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; }
td.actions { text-align: right; white-space: nowrap; }
td.actions .btn { margin-left: 6px; }

input, select, textarea { background: var(--bg); color: var(--text); border: 1px solid var(--border); border-radius: var(--radius); padding: 7px 10px; font: inherit; }
input:focus, select:focus, textarea:focus, .btn:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
textarea { min-height: 80px; resize: vertical; }
.form { display: flex; flex-direction: column; gap: 6px; }
.form label { color: var(--text2); font-size: 12px; margin-top: 6px; }
.form-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 14px; }

.btn { border: 1px solid transparent; border-radius: var(--radius); padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-primary { background: var(--accent); color: #000; }
.btn-secondary { background: var(--bg3); color: var(--text); border-color: var(--border); }
.btn-danger { background: var(--danger); color: #fff; }
.btn-sm { padding: 4px 10px; font-size: 12px; }

.badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700; letter-spacing: 0.4px; border: 1px solid currentColor; }
.badge-success { color: var(--success); }
.badge-danger { color: var(--danger); }
.badge-warn { color: var(--warn); }
.badge-info { color: var(--info); }
.badge-neutral { color: var(--text2); }

.tabs { display: flex; gap: 4px; border-bottom: 1px solid var(--border); margin-bottom: 16px; }
.tab { background: none; border: none; border-bottom: 2px solid transparent; color: var(--text2); padding: 8px 14px; font: inherit; cursor: pointer; }
.tab[aria-selected='true'] { color: var(--accent); border-bottom-color: var(--accent); }

.overlay { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.6); display: flex; align-items: center; justify-content: center; padding: 16px; }
.dialog { width: 100%; max-width: 460px; background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 20px; }

.login-wrap { height: 100%; display: flex; align-items: center; justify-content: center; }
.login-card { width: 340px; display: flex; flex-direction: column; gap: 8px; }
.login-card h1 { margin-bottom: 8px; }
.login-card label { color: var(--text2); font-size: 12px; }
.login-card .btn { margin-top: 10px; }
```

- [ ] **Step 9: Run the E2E tests and typecheck to verify they pass**

Run: `npm run test:e2e -w web && npm run typecheck -w web`
Expected: PASS, 3 tests; `tsc` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add PlaywrightPlatform
git commit -m "feat(platform): add web app shell with sign-in and E2E harness"
```

---

### Task 7: Web pages for projects and users

**Files:**
- Create: `PlaywrightPlatform/web/src/api/projects.ts`, `api/users.ts`, `hooks/useLoad.ts`
- Create: `PlaywrightPlatform/web/src/components/Modal.tsx`, `ConfirmDialog.tsx`, `StatusBadge.tsx`
- Create: `PlaywrightPlatform/web/src/pages/ProjectDashboardPage.tsx`, `UsersPage.tsx`
- Replace: `PlaywrightPlatform/web/src/pages/ProjectsPage.tsx`
- Modify: `PlaywrightPlatform/web/src/App.tsx`
- Test: `PlaywrightPlatform/web/e2e/projects.spec.ts`, `e2e/users.spec.ts`

**Interfaces:**
- Consumes: `api`, `errorMessage`, `useAuth`, types from `api/types.ts`, `signIn`, `ADMIN`, `VIEWER`
- Produces:
  - `projectsApi.list({ search, status })`, `.get(id)`, `.create({ name, description })`, `.update(id, patch)`, `.remove(id)`
  - `usersApi.list()`, `.create(input)`, `.update(id, patch)`
  - `useLoad<T>(load: () => Promise<T>, deps): { data: T|null; error: string|null; loading: boolean; reload(): void }`
  - `<Modal title onClose>`, `<ConfirmDialog title message confirmLabel danger? onConfirm onCancel>`, `<StatusBadge status>`

- [ ] **Step 1: Write the failing E2E tests**

`PlaywrightPlatform/web/e2e/projects.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { ADMIN, VIEWER, signIn } from './helpers';

test('an admin creates, opens, finds, edits, and archives a project', async ({ page }) => {
  const name = `Shop ${Date.now()}`;
  await signIn(page, ADMIN);

  await page.getByRole('button', { name: 'Create Project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(dialog.getByLabel('Project Name')).toBeFocused(); // required field blocks an empty submit

  await dialog.getByLabel('Project Name').fill(name);
  await dialog.getByLabel('Description').fill('E2E automation');
  await dialog.getByRole('button', { name: 'Create Project' }).click();

  // Lands on the project dashboard.
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByText('Total Scripts')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Scripts' })).toBeVisible();
  await page.getByRole('tab', { name: 'CI/CD' }).click();
  await expect(page.getByText('CI/CD is not available yet.')).toBeVisible();

  // Found by search in the list.
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByPlaceholder('Search projects...').fill(name);
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row.getByText('ACTIVE')).toBeVisible();

  // A duplicate name shows the server's message inside the dialog.
  await page.getByRole('button', { name: 'Create Project' }).click();
  await dialog.getByLabel('Project Name').fill(name.toUpperCase());
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Edit.
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Description').fill('Edited description');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // Archive needs confirmation, then the project leaves the ACTIVE list.
  await row.getByRole('button', { name: 'Archive' }).click();
  await expect(dialog).toContainText(`Archive "${name}"?`);
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(row).toHaveCount(0);

  await page.getByLabel('Status').selectOption('ARCHIVED');
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
});

test('an admin deletes a project after confirming', async ({ page }) => {
  const name = `Doomed ${Date.now()}`;
  await signIn(page, ADMIN);
  await page.getByRole('button', { name: 'Create Project' }).click();
  await page.getByRole('dialog').getByLabel('Project Name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await page.getByRole('link', { name: 'Projects' }).click();
  const row = page.getByRole('row', { name: new RegExp(name) });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog')).toContainText('This will remove the project');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
});

test('a viewer can browse but sees no way to change anything', async ({ page }) => {
  await signIn(page, VIEWER);
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
});

test('when the session ends, the next action returns the user to the login page', async ({ page, context }) => {
  await signIn(page, ADMIN);
  await context.clearCookies();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('an unknown project id shows a clear message', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/projects/99999999');
  await expect(page.getByRole('alert')).toHaveText('Project not found.');
  await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
});
```

`PlaywrightPlatform/web/e2e/users.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { ADMIN, signIn } from './helpers';

test('an admin creates a USER who can then sign in with limited rights', async ({ page }) => {
  const email = `tester${Date.now()}@e2e.test`;
  const password = 'Tester-e2e-pass1';

  await signIn(page, ADMIN);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Create User' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Display Name').fill('E2E Tester');
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByLabel('Role').selectOption('USER');
  await dialog.getByRole('button', { name: 'Create User' }).click();

  const row = page.getByRole('row', { name: new RegExp(email) });
  await expect(row).toBeVisible();
  await expect(row.getByText('USER', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, { email, password });
  await expect(page.getByRole('button', { name: 'Create Project' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
});

test('an admin can disable a user, and the last admin is protected', async ({ page }) => {
  const email = `temp${Date.now()}@e2e.test`;
  await signIn(page, ADMIN);
  await page.getByRole('link', { name: 'Settings' }).click();

  await page.getByRole('button', { name: 'Create User' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Display Name').fill('Temp');
  await dialog.getByLabel('Password').fill('Temp-e2e-pass1');
  await dialog.getByRole('button', { name: 'Create User' }).click();

  const row = page.getByRole('row', { name: new RegExp(email) });
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Status').selectOption('DISABLED');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('DISABLED')).toBeVisible();

  const adminRow = page.getByRole('row', { name: new RegExp(ADMIN.email) });
  await adminRow.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Role').selectOption('VIEWER');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('last active administrator');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test:e2e -w web`
Expected: the 3 auth tests PASS; all 7 new tests FAIL (no "Create Project" button, no Settings page).

- [ ] **Step 3: Write the API modules and the `useLoad` hook**

`PlaywrightPlatform/web/src/api/projects.ts`:

```ts
import { api } from './client';
import type { Project, ProjectListItem, ProjectOverview, ProjectStatus } from './types';

export interface ProjectList {
  items: ProjectListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const projectsApi = {
  list(params: { search: string; status: ProjectStatus }) {
    const query = new URLSearchParams({ status: params.status, pageSize: '100' });
    if (params.search.trim()) query.set('search', params.search.trim());
    return api<ProjectList>(`/projects?${query.toString()}`);
  },
  get: (id: number) => api<{ project: Project; overview: ProjectOverview }>(`/projects/${id}`),
  create: (input: { name: string; description: string }) =>
    api<{ project: Project }>('/projects', { method: 'POST', body: input }),
  update: (id: number, patch: { name?: string; description?: string; status?: 'ACTIVE' | 'ARCHIVED' }) =>
    api<{ project: Project }>(`/projects/${id}`, { method: 'PUT', body: patch }),
  remove: (id: number) => api<void>(`/projects/${id}`, { method: 'DELETE' }),
};
```

`PlaywrightPlatform/web/src/api/users.ts`:

```ts
import { api } from './client';
import type { Role, User, UserStatus } from './types';

export const usersApi = {
  list: () => api<{ items: User[] }>('/users'),
  create: (input: { email: string; displayName: string; password: string; role: Role }) =>
    api<{ user: User }>('/users', { method: 'POST', body: input }),
  update: (id: number, patch: { displayName?: string; role?: Role; status?: UserStatus; password?: string }) =>
    api<{ user: User }>(`/users/${id}`, { method: 'PUT', body: patch }),
};
```

`PlaywrightPlatform/web/src/hooks/useLoad.ts`:

```ts
import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { errorMessage } from '../api/client';

export interface LoadState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/** Runs `load` on mount, whenever `deps` change, and on `reload()`. Ignores stale responses. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    load()
      .then((result) => {
        if (!current) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (current) setError(errorMessage(err));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
    // `load` is intentionally excluded: callers pass a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
```

- [ ] **Step 4: Write the shared components**

`PlaywrightPlatform/web/src/components/Modal.tsx`:

```tsx
import { useEffect, useId, type ReactNode } from 'react';

export function Modal({ title, onClose, children }: { title: string; onClose(): void; children: ReactNode }) {
  const titleId = useId();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay">
      <div className="dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
}
```

`PlaywrightPlatform/web/src/components/ConfirmDialog.tsx`:

```tsx
import { useState } from 'react';
import { errorMessage } from '../api/client';
import { Modal } from './Modal';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): Promise<void>;
  onCancel(): void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <p>{message}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => void confirm()} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
```

`PlaywrightPlatform/web/src/components/StatusBadge.tsx`:

```tsx
const TONE: Record<string, string> = {
  PASSED: 'success',
  ACTIVE: 'success',
  FAILED: 'danger',
  ERROR: 'danger',
  DELETED: 'danger',
  DISABLED: 'danger',
  RUNNING: 'info',
  QUEUED: 'warn',
  ABORTED: 'warn',
  ARCHIVED: 'neutral',
};

/** One look for every status word in the product. Unknown or missing values render neutrally. */
export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="muted">—</span>;
  return <span className={`badge badge-${TONE[status] ?? 'neutral'}`}>{status}</span>;
}
```

- [ ] **Step 5: Write the Projects page**

Replace `PlaywrightPlatform/web/src/pages/ProjectsPage.tsx` with:

```tsx
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { projectsApi } from '../api/projects';
import type { ProjectListItem, ProjectStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; project: ProjectListItem }
  | { kind: 'archive'; project: ProjectListItem }
  | { kind: 'delete'; project: ProjectListItem };

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ProjectsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('ACTIVE');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const debouncedSearch = useDebounced(search, 250);

  const { data, error, loading, reload } = useLoad(
    () => projectsApi.list({ search: debouncedSearch, status }),
    [debouncedSearch, status],
  );

  const close = () => setDialog(null);
  const closeAndReload = () => {
    close();
    reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setDialog({ kind: 'create' })}>Create Project</button>
        )}
      </div>

      <div className="toolbar">
        <input type="search" placeholder="Search projects..." aria-label="Search projects" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <label htmlFor="status-filter">Status</label>
        <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <button className="btn btn-secondary" onClick={reload}>Refresh</button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {loading && !data && <p className="muted">Loading projects…</p>}
      {data && data.items.length === 0 && (
        <p className="muted center">
          {search ? 'No projects match your search.' : 'No projects yet.'}
        </p>
      )}

      {data && data.items.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Project Name</th>
                <th>Scripts</th>
                <th>Last Run</th>
                <th>Status</th>
                {isAdmin && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {data.items.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link to={`/projects/${project.id}`}>{project.name}</Link>
                    {project.description && <div className="muted">{project.description}</div>}
                  </td>
                  <td>{project.scriptCount}</td>
                  <td><StatusBadge status={project.lastRunStatus} /></td>
                  <td><StatusBadge status={project.status} /></td>
                  {isAdmin && (
                    <td className="actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'edit', project })}>Edit</button>
                      {project.status === 'ACTIVE' ? (
                        <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'archive', project })}>Archive</button>
                      ) : (
                        <button className="btn btn-secondary btn-sm"
                          onClick={() => void projectsApi.update(project.id, { status: 'ACTIVE' }).then(reload)}>
                          Restore
                        </button>
                      )}
                      <button className="btn btn-danger btn-sm" onClick={() => setDialog({ kind: 'delete', project })}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'create' && (
        <ProjectForm
          title="Create New Project"
          submitLabel="Create Project"
          initial={{ name: '', description: '' }}
          onCancel={close}
          onSubmit={async (values) => {
            const { project } = await projectsApi.create(values);
            navigate(`/projects/${project.id}`);
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ProjectForm
          title="Edit Project"
          submitLabel="Save"
          initial={{ name: dialog.project.name, description: dialog.project.description }}
          onCancel={close}
          onSubmit={async (values) => {
            await projectsApi.update(dialog.project.id, values);
            closeAndReload();
          }}
        />
      )}
      {dialog?.kind === 'archive' && (
        <ConfirmDialog
          title="Archive project"
          message={`Archive "${dialog.project.name}"? It moves to the Archived list and can be restored later.`}
          confirmLabel="Archive"
          onCancel={close}
          onConfirm={async () => {
            await projectsApi.update(dialog.project.id, { status: 'ARCHIVED' });
            closeAndReload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Are you sure?"
          message={`This will remove the project "${dialog.project.name}". Its execution history is kept.`}
          confirmLabel="Delete"
          danger
          onCancel={close}
          onConfirm={async () => {
            await projectsApi.remove(dialog.project.id);
            closeAndReload();
          }}
        />
      )}
    </>
  );
}

interface ProjectFormProps {
  title: string;
  submitLabel: string;
  initial: { name: string; description: string };
  onSubmit(values: { name: string; description: string }): Promise<void>;
  onCancel(): void;
}

function ProjectForm({ title, submitLabel, initial, onSubmit, onCancel }: ProjectFormProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name, description });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="project-name">Project Name</label>
        <input id="project-name" required maxLength={120} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="project-description">Description</label>
        <textarea id="project-description" maxLength={2000} value={description}
          onChange={(e) => setDescription(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 6: Write the Project dashboard page**

`PlaywrightPlatform/web/src/pages/ProjectDashboardPage.tsx`:

```tsx
import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { projectsApi } from '../api/projects';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';

const TABS = ['Overview', 'Scripts', 'Executions', 'CI/CD', 'Reports', 'Skills', 'Settings'] as const;
type Tab = (typeof TABS)[number];

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

export function ProjectDashboardPage() {
  const id = Number(useParams().id);
  const [tab, setTab] = useState<Tab>('Overview');
  const { data, error, loading } = useLoad(() => projectsApi.get(id), [id]);

  if (error) {
    return (
      <>
        <p className="error" role="alert">{error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  if (loading || !data) return <p className="muted">Loading project…</p>;

  const { project, overview } = data;
  const stats: [string, string | number][] = [
    ['Total Scripts', overview.totalScripts],
    ['Passed Tests', overview.passedScripts],
    ['Failed Tests', overview.failedScripts],
    ['Not Executed', overview.notExecuted],
    ['Last Execution', formatWhen(overview.lastExecutionAt)],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} role="tab" className="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>

      {tab === 'Overview' ? (
        <div className="stats">
          {stats.map(([label, value]) => (
            <div className="card" key={label}>
              <div className="stat-value">{value}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted center">{tab} is not available yet.</p>
      )}
    </>
  );
}
```

- [ ] **Step 7: Write the Users page**

`PlaywrightPlatform/web/src/pages/UsersPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import type { Role, User, UserStatus } from '../api/types';
import { usersApi } from '../api/users';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';

const ROLES: Role[] = ['ADMIN', 'USER', 'VIEWER'];

export function UsersPage() {
  const { user: me } = useAuth();
  const { data, error, loading, reload } = useLoad(() => usersApi.list(), []);
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; user: User } | null>(null);

  if (me?.role !== 'ADMIN') return <Navigate to="/projects" replace />;

  const done = () => {
    setDialog(null);
    reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setDialog({ kind: 'create' })}>Create User</button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {loading && !data && <p className="muted">Loading users…</p>}

      {data && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Sign-in</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{user.displayName}</td>
                  <td><span className="badge badge-neutral">{user.role}</span></td>
                  <td><StatusBadge status={user.status} /></td>
                  <td className="muted">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</td>
                  <td className="actions">
                    <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'edit', user })}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'create' && <CreateUserForm onCancel={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'edit' && <EditUserForm user={dialog.user} onCancel={() => setDialog(null)} onDone={done} />}
    </>
  );
}

function useSubmit(action: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return { submit, error, busy };
}

function CreateUserForm({ onCancel, onDone }: { onCancel(): void; onDone(): void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');
  const { submit, error, busy } = useSubmit(async () => {
    await usersApi.create({ email, displayName, password, role });
    onDone();
  });

  return (
    <Modal title="Create User" onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="user-email">Email</label>
        <input id="user-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="user-name">Display Name</label>
        <input id="user-name" required maxLength={120} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <label htmlFor="user-password">Password</label>
        <input id="user-password" type="password" required minLength={8} autoComplete="new-password" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor="user-role">Role</label>
        <select id="user-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>Create User</button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserForm({ user, onCancel, onDone }: { user: User; onCancel(): void; onDone(): void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<Role>(user.role);
  const [status, setStatus] = useState<UserStatus>(user.status);
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(async () => {
    await usersApi.update(user.id, {
      displayName: displayName !== user.displayName ? displayName : undefined,
      role: role !== user.role ? role : undefined,
      status: status !== user.status ? status : undefined,
      password: password || undefined,
    });
    onDone();
  });
  const unchanged = displayName === user.displayName && role === user.role && status === user.status && !password;

  return (
    <Modal title={`Edit ${user.email}`} onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="edit-name">Display Name</label>
        <input id="edit-name" required maxLength={120} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <label htmlFor="edit-role">Role</label>
        <select id="edit-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <label htmlFor="edit-status">Status</label>
        <select id="edit-status" value={status} onChange={(e) => setStatus(e.target.value as UserStatus)}>
          <option value="ACTIVE">ACTIVE</option>
          <option value="DISABLED">DISABLED</option>
        </select>
        <label htmlFor="edit-password">New Password (leave blank to keep)</label>
        <input id="edit-password" type="password" minLength={8} autoComplete="new-password" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || unchanged}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
```

- [ ] **Step 8: Add the routes**

In `PlaywrightPlatform/web/src/App.tsx` add two imports:

```tsx
import { ProjectDashboardPage } from './pages/ProjectDashboardPage';
import { UsersPage } from './pages/UsersPage';
```

and two routes directly after the `/projects` route:

```tsx
        <Route path="/projects/:id" element={<ProjectDashboardPage />} />
        <Route path="/settings/users" element={<UsersPage />} />
```

- [ ] **Step 9: Run the E2E tests and typecheck to verify they pass**

Run: `npm run test:e2e -w web && npm run typecheck -w web`
Expected: PASS, 10 tests.

- [ ] **Step 10: Verify the web layering rule**

Run from `PlaywrightPlatform/web`: `grep -rn "fetch(" src --include=*.ts --include=*.tsx | grep -v "src/api/"; echo "exit $?"`
Expected: no lines, `exit 1`.

- [ ] **Step 11: Commit**

```bash
git add PlaywrightPlatform/web
git commit -m "feat(platform): add projects, project dashboard, and user management pages"
```

---

### Task 8: Extension platform sign-in

**Files:**
- Create: `PlaywrightExtension/utils/platform-client.js`, `PlaywrightExtension/tests/platform-client.test.mjs`
- Modify: `PlaywrightExtension/utils/storage.js` (add two methods), `PlaywrightExtension/sidepanel.html` (Settings panel, after the `#settings-status` div near line 537), `PlaywrightExtension/sidepanel.js` (one import near line 8, one call in `init()` near line 40, one new function before `function setupSettings()` near line 821)

**Interfaces:**
- Consumes: server routes `POST /api/auth/login` (`client: 'extension'`), `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/projects`
- Produces:
  - `Storage.getPlatform(): Promise<{ url: string; token: string; user: object|null }>`, `Storage.savePlatform(platform): Promise<void>` — storage key `pas_platform`
  - `createPlatformClient({ fetchFn, storage })` and the ready-made `PlatformClient`, each with `login(url, email, password) → user`, `logout()`, `me() → user|null`, `listProjects() → ProjectListItem[]`
  - Later sub-projects add "Save to Project" on top of `PlatformClient.listProjects()`.

- [ ] **Step 1: Write the failing client test**

`PlaywrightExtension/tests/platform-client.test.mjs`:

```js
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createPlatformClient } from '../utils/platform-client.js';

const USER = { id: 1, email: 'ada@example.com', displayName: 'Ada', role: 'ADMIN' };

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('platform client', () => {
  let saved;
  let calls;
  let responder;
  let client;

  beforeEach(() => {
    saved = { url: '', token: '', user: null };
    calls = [];
    responder = () => json(200, {});
    client = createPlatformClient({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return responder(url, init);
      },
      storage: {
        getPlatform: async () => saved,
        savePlatform: async (next) => {
          saved = next;
        },
      },
    });
  });

  it('login posts extension credentials and stores url, token, and user but never the password', async () => {
    responder = () => json(200, { user: USER, token: 'tok-123', expiresAt: '2030-01-01T00:00:00.000Z' });
    const user = await client.login(' http://localhost:3000/// ', 'ada@example.com', 'pw-secret');

    assert.deepEqual(user, USER);
    assert.equal(calls[0].url, 'http://localhost:3000/api/auth/login');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      email: 'ada@example.com',
      password: 'pw-secret',
      client: 'extension',
    });
    assert.deepEqual(saved, { url: 'http://localhost:3000', token: 'tok-123', user: USER });
    assert.ok(!JSON.stringify(saved).includes('pw-secret'));
  });

  it('login surfaces the server error message and stores nothing', async () => {
    responder = () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
    await assert.rejects(client.login('http://localhost:3000', 'a@b.co', 'x'), /Invalid email or password\./);
    assert.equal(saved.token, '');
  });

  it('rejects a URL that is not http or https before any request', async () => {
    await assert.rejects(client.login('localhost:3000', 'a@b.co', 'x'), /must start with http/);
    await assert.rejects(client.login('javascript:alert(1)', 'a@b.co', 'x'), /must start with http/);
    assert.equal(calls.length, 0);
  });

  it('explains an unreachable platform', async () => {
    client = createPlatformClient({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
      storage: { getPlatform: async () => saved, savePlatform: async () => {} },
    });
    await assert.rejects(
      client.login('http://localhost:3000', 'a@b.co', 'x'),
      /Cannot reach the platform at http:\/\/localhost:3000/,
    );
  });

  it('me sends the bearer token and returns the user', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(200, { user: USER, csrfToken: null });
    assert.deepEqual(await client.me(), USER);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
  });

  it('me returns null and forgets the token when the session has ended', async () => {
    saved = { url: 'http://localhost:3000', token: 'old', user: USER };
    responder = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    assert.equal(await client.me(), null);
    assert.deepEqual(saved, { url: 'http://localhost:3000', token: '', user: null });
  });

  it('me returns null without a request when not signed in', async () => {
    assert.equal(await client.me(), null);
    assert.equal(calls.length, 0);
  });

  it('logout clears the token even if the server call fails, and keeps the url', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => {
      throw new TypeError('Failed to fetch');
    };
    await client.logout();
    assert.deepEqual(saved, { url: 'http://localhost:3000', token: '', user: null });
  });

  it('listProjects returns the items array', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(200, { items: [{ id: 7, name: 'Shop' }], total: 1, page: 1, pageSize: 100 });
    assert.deepEqual(await client.listProjects(), [{ id: 7, name: 'Shop' }]);
    assert.equal(calls[0].url, 'http://localhost:3000/api/projects?pageSize=100');
  });

  it('listProjects requires a sign-in', async () => {
    await assert.rejects(client.listProjects(), /Sign in to the platform first/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run from the repo root: `node --test PlaywrightExtension/tests/`
Expected: FAIL — cannot find module `../utils/platform-client.js`.

- [ ] **Step 3: Add the storage methods**

In `PlaywrightExtension/utils/storage.js`, add these two methods inside the `Storage` object, after `saveSettings`:

```js
  async getPlatform() {
    const data = await this.get('pas_platform');
    return data.pas_platform || { url: '', token: '', user: null };
  },

  async savePlatform(platform) {
    await this.set({ pas_platform: platform });
  },
```

- [ ] **Step 4: Implement the client**

`PlaywrightExtension/utils/platform-client.js`:

```js
// HTTP client for the Playwright Platform backend (PlaywrightPlatform/server).
// The only extension file that knows the platform API. The password is sent
// once at sign-in and never stored; only the bearer token is kept.

import { Storage } from './storage.js';

function normalizeUrl(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Platform URL must start with http:// or https://');
  }
  return trimmed;
}

export function createPlatformClient({ fetchFn, storage }) {
  async function request(baseUrl, path, { method = 'GET', token = '', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetchFn(`${baseUrl}/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Cannot reach the platform at ${baseUrl}. Is the server running?`);
    }

    if (res.status === 204) return { status: 204, data: null };
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Platform request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data };
  }

  async function signedIn() {
    const platform = await storage.getPlatform();
    if (!platform.url || !platform.token) throw new Error('Sign in to the platform first (Settings → Platform).');
    return platform;
  }

  return {
    async login(url, email, password) {
      const baseUrl = normalizeUrl(url);
      const { data } = await request(baseUrl, '/auth/login', {
        method: 'POST',
        body: { email, password, client: 'extension' },
      });
      await storage.savePlatform({ url: baseUrl, token: data.token, user: data.user });
      return data.user;
    },

    async logout() {
      const platform = await storage.getPlatform();
      if (platform.url && platform.token) {
        try {
          await request(platform.url, '/auth/logout', { method: 'POST', token: platform.token });
        } catch {
          // The local token is dropped regardless; a dead server must not trap the user signed in.
        }
      }
      await storage.savePlatform({ url: platform.url, token: '', user: null });
    },

    // Returns the current user, or null when not signed in or the session has ended.
    async me() {
      const platform = await storage.getPlatform();
      if (!platform.url || !platform.token) return null;
      try {
        const { data } = await request(platform.url, '/auth/me', { token: platform.token });
        return data.user;
      } catch (err) {
        if (err.status === 401) {
          await storage.savePlatform({ url: platform.url, token: '', user: null });
          return null;
        }
        throw err;
      }
    },

    async listProjects() {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/projects?pageSize=100', { token: platform.token });
      return data.items;
    },
  };
}

export const PlatformClient = createPlatformClient({
  fetchFn: (url, init) => fetch(url, init),
  storage: Storage,
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --test PlaywrightExtension/tests/`
Expected: PASS, 10 tests.

- [ ] **Step 6: Add the Platform block to the Settings panel**

In `PlaywrightExtension/sidepanel.html`, find this existing line inside `#panel-settings`:

```html
          <div id="settings-status" style="font-size:12px;color:var(--text2);padding:4px 0"></div>
```

Insert directly after it:

```html
          <div class="settings-section" id="platform-section">
            <h3>Platform</h3>
            <div class="form-group" style="margin-top:8px">
              <label for="platform-url">Platform URL</label>
              <input type="text" id="platform-url" placeholder="http://localhost:3000">
            </div>
            <div id="platform-signin-fields">
              <div class="form-group" style="margin-top:8px">
                <label for="platform-email">Email</label>
                <input type="text" id="platform-email" autocomplete="username">
              </div>
              <div class="form-group" style="margin-top:8px">
                <label for="platform-password">Password</label>
                <input type="password" id="platform-password" autocomplete="off">
              </div>
            </div>
            <div class="btn-row" style="margin-top:10px">
              <button class="btn btn-primary" id="platform-signin">Sign in</button>
              <button class="btn btn-secondary" id="platform-signout" style="display:none">Sign out</button>
            </div>
            <div id="platform-status" style="font-size:12px;color:var(--text2);padding:6px 0 0"></div>
          </div>
```

- [ ] **Step 7: Wire the block in `sidepanel.js`**

Add after the existing `import { Storage } from './utils/storage.js';` line:

```js
import { PlatformClient } from './utils/platform-client.js';
```

In `init()`, directly after the existing `setupSettings();` line, add:

```js
  setupPlatform();
```

Directly before the existing `function setupSettings() {` line, add:

```js
// Settings → Platform: optional sign-in to the Playwright Platform backend.
// Everything else in the extension works unchanged when this is left empty.
function setupPlatform() {
  const urlInput = document.getElementById('platform-url');
  const emailInput = document.getElementById('platform-email');
  const passwordInput = document.getElementById('platform-password');
  const fields = document.getElementById('platform-signin-fields');
  const signInBtn = document.getElementById('platform-signin');
  const signOutBtn = document.getElementById('platform-signout');
  const status = document.getElementById('platform-status');
  if (!urlInput || !signInBtn || !signOutBtn || !status) return;

  const render = (user, message) => {
    fields.style.display = user ? 'none' : '';
    signInBtn.style.display = user ? 'none' : '';
    signOutBtn.style.display = user ? '' : 'none';
    urlInput.disabled = Boolean(user);
    // textContent only: the values come from a server and must never be parsed as HTML.
    status.textContent = message || (user ? `✅ Signed in as ${user.email} (${user.role})` : 'Not signed in');
  };

  (async () => {
    const platform = await Storage.getPlatform();
    urlInput.value = platform.url || '';
    render(platform.user);
    if (!platform.token) return;
    try {
      const user = await PlatformClient.me();
      render(user, user ? '' : 'Session expired — sign in again');
    } catch (err) {
      render(platform.user, `⚠️ ${err.message}`);
    }
  })();

  signInBtn.addEventListener('click', async () => {
    signInBtn.disabled = true;
    status.textContent = 'Signing in…';
    try {
      const user = await PlatformClient.login(urlInput.value, emailInput.value.trim(), passwordInput.value);
      passwordInput.value = '';
      render(user);
      showToast('Signed in to platform');
    } catch (err) {
      render(null, `❌ ${err.message}`);
    } finally {
      signInBtn.disabled = false;
    }
  });

  signOutBtn.addEventListener('click', async () => {
    await PlatformClient.logout();
    render(null);
  });
}
```

- [ ] **Step 8: Verify by hand in Chrome**

Start the platform (`cd PlaywrightPlatform && npm run dev:server`). In Chrome open `chrome://extensions`, reload "Playwright AI Studio", open its side panel, and go to Settings.

1. A "Platform" section shows URL, Email, Password, "Sign in", and "Not signed in".
2. URL `localhost:3000` + Sign in → `❌ Platform URL must start with http:// or https://`.
3. URL `http://localhost:3000` + wrong password → `❌ Invalid email or password.`
4. Correct admin credentials → `✅ Signed in as <email> (ADMIN)`; the email and password fields hide; the password box is empty.
5. Close and reopen the side panel → still signed in.
6. Sign out → "Not signed in"; the URL is still filled in.
7. Stop the server, reopen the panel while signed in → `⚠️ Cannot reach the platform at http://localhost:3000. Is the server running?`
8. Regression with the provider set to Mock: Planner produces a plan; Generator produces code; Recorder records two clicks and shows generated code; Healer returns a suggestion for pasted broken code. Each behaves as before this change.

Record the result of each numbered check in the commit body or the PR description.

- [ ] **Step 9: Commit**

```bash
git add PlaywrightExtension/utils/platform-client.js PlaywrightExtension/utils/storage.js PlaywrightExtension/tests PlaywrightExtension/sidepanel.html PlaywrightExtension/sidepanel.js
git commit -m "feat(extension): add optional platform sign-in to Settings"
```

---

### Task 9: Production serving, documentation, and final verification

**Files:**
- Modify: `PlaywrightPlatform/server/src/plugins/error-handler.ts`, `src/app.ts`, `src/server.ts`
- Create: `PlaywrightPlatform/server/test/static.test.ts`, `PlaywrightPlatform/README.md`
- Modify: `CLAUDE.md`, `README.md` (repo root)

**Interfaces:**
- Consumes: `buildApp({ config, db, webRoot })`
- Produces: with `webRoot` set, `GET` requests outside `/api` serve the built web app with SPA fallback; `registerErrorHandling(app, { spaFallback })`

- [ ] **Step 1: Write the failing static-serving test**

`PlaywrightPlatform/server/test/static.test.ts`:

```ts
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db';
import { testConfig } from './helpers';

describe('serving the built web app', () => {
  let webRoot: string;
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    webRoot = mkdtempSync(path.join(os.tmpdir(), 'pw-web-'));
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Platform</title>');
    mkdirSync(path.join(webRoot, 'assets'));
    writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'console.log("app")');

    const config = testConfig();
    db = createDb(config.databaseUrl);
    app = await buildApp({ config, db, webRoot });
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
    rmSync(webRoot, { recursive: true, force: true });
  });

  it('serves index.html at the root and real asset files', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<title>Platform</title>');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/5' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Platform</title>');
  });

  it('still answers unknown API routes and non-GET requests with JSON 404', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('NOT_FOUND');

    const post = await app.inject({ method: 'POST', url: '/projects/5' });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe('NOT_FOUND');
  });

  it('does not serve files outside the web root', async () => {
    const res = await app.inject({ method: 'GET', url: '/../package.json' });
    expect(res.body).not.toContain('"name"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w server -- test/static.test.ts`
Expected: FAIL — `GET /` returns 404 because `webRoot` is ignored.

- [ ] **Step 3: Implement static serving with SPA fallback**

In `PlaywrightPlatform/server/src/plugins/error-handler.ts`, change the signature and the not-found handler:

```ts
export function registerErrorHandling(app: FastifyInstance, options: { spaFallback: boolean }): void {
```

```ts
  app.setNotFoundHandler((req, reply) => {
    // Client-side routes such as /projects/5 have no file on disk; the SPA handles them.
    if (options.spaFallback && req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send(body('NOT_FOUND', 'Resource not found.'));
  });
```

In `PlaywrightPlatform/server/src/app.ts`:

Add the import:

```ts
import fastifyStatic from '@fastify/static';
```

Change the function signature to destructure `webRoot`, and pass the option:

```ts
export async function buildApp({ config, db, webRoot }: AppDeps): Promise<FastifyInstance> {
```

```ts
  registerErrorHandling(app, { spaFallback: Boolean(webRoot) });
```

Directly before `return app;` add:

```ts
  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }
```

In `PlaywrightPlatform/server/src/server.ts`, add imports and compute `webRoot`:

```ts
import { existsSync } from 'node:fs';
import path from 'node:path';
```

Replace `const app = await buildApp({ config, db });` with:

```ts
  // Resolves to PlaywrightPlatform/web/dist from both src/ (tsx) and dist/ (node).
  const builtWeb = path.resolve(__dirname, '../../web/dist');
  const serveWeb = config.nodeEnv === 'production' && existsSync(path.join(builtWeb, 'index.html'));
  const app = await buildApp({ config, db, webRoot: serveWeb ? builtWeb : undefined });
```

- [ ] **Step 4: Run all server tests to verify they pass**

Run: `npm run test -w server && npm run typecheck -w server`
Expected: PASS — `static.test.ts` 4 tests; 69 total.

- [ ] **Step 5: Verify the production build end to end**

```bash
cd PlaywrightPlatform
npm run build
NODE_ENV=production APP_PORT=3200 npm run start
```

In a second terminal:

```bash
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:3200/
curl -s -o /dev/null -w "%{http_code} %{content_type}\n" http://127.0.0.1:3200/projects/1
curl -s http://127.0.0.1:3200/api/health
curl -s http://127.0.0.1:3200/api/projects
```

Expected: `200 text/html…` twice; `{"status":"ok","database":"up"}`; and `{"error":{"code":"UNAUTHENTICATED","message":"Sign in to continue.","details":null}}`. Stop the server with Ctrl+C.

- [ ] **Step 6: Write the platform README**

`PlaywrightPlatform/README.md`:

````markdown
# Playwright Platform

Backend, database, and web app for Playwright AI Studio: projects, users, roles, and audit
logging today; scripts, skills, Jenkins execution, reports, and healing in later releases.
The database already contains the tables for all of those.

## Architecture

```
web/ (React + Vite)  ──HTTP /api──▶  server/ (Fastify)  ──Knex──▶  PostgreSQL (Docker)
Chrome extension     ──HTTP /api──▶  routes → services → repositories
```

- **routes/** parse and validate HTTP, then call a service.
- **services/** hold the rules (roles, last-admin protection, audit).
- **repositories/** are the only code that queries the database.
- The web app sends a session cookie plus a CSRF header; the extension sends a bearer token.

## Requirements

Node 20 or newer, Docker, and a free port 5432 (or set `POSTGRES_PORT`).

## First-time setup

```bash
cd PlaywrightPlatform
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Edit `.env`:

| Variable | What to put |
|---|---|
| `SECRETS_ENCRYPTION_KEY` | The value printed by the command above |
| `POSTGRES_PASSWORD`, and the password inside `DATABASE_URL` and `DATABASE_URL_TEST` | One new password, the same in all three |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator (password at least 8 characters) |

Then:

```bash
docker compose up -d postgres   # start PostgreSQL
npm run db:migrate              # create all tables
npm run db:seed                 # create the first admin
```

## Run in development

```bash
npm run dev:server   # API on http://127.0.0.1:3000
npm run dev:web      # web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Run in production

```bash
npm run build
NODE_ENV=production npm run start
```

The server then serves the web app and the API from one origin on `APP_PORT`.
Put it behind HTTPS: in production the session cookie is `Secure` and the security
headers tell browsers to upgrade requests to HTTPS. Set `APP_HOST=0.0.0.0` only when a
reverse proxy or firewall controls access.

## Database commands

| Command | Effect |
|---|---|
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:rollback` | Revert the most recent batch |
| `npm run db:seed` | Create the first admin if absent |
| `docker compose --profile tools up -d pgadmin` | pgAdmin on http://127.0.0.1:5050 (set `PGADMIN_PASSWORD` in `.env` first) |

Schema changes are always a new file in `server/src/migrations/` added to the list in
`index.ts`. Never edit a migration that has already been applied anywhere.

## Roles

| Action | ADMIN | USER | VIEWER |
|---|---|---|---|
| View projects | yes | yes | yes |
| Create, edit, archive, delete projects | yes | no | no |
| Manage users (Settings → Users) | yes | no | no |

## Connect the extension

Load `PlaywrightExtension/` unpacked in Chrome, open Settings in the side panel, enter the
platform URL (for example `http://localhost:3000`) and your credentials under **Platform**,
and choose **Sign in**. The password is not stored; a 30-day token is.

## Tests

```bash
npm test             # server: Vitest against playwright_db_test
npm run test:e2e     # web: Playwright against a server on :3100 and Vite on :5174
node --test ../PlaywrightExtension/tests/   # extension client
```

Both suites rebuild `playwright_db_test`. Do not run them at the same time.

## API

All routes are under `/api`. Errors always look like
`{ "error": { "code": "...", "message": "...", "details": ... } }`.

| Method | Path | Role |
|---|---|---|
| GET | `/health` | public |
| POST | `/auth/login` | public |
| POST | `/auth/logout` | signed in |
| GET | `/auth/me` | signed in |
| GET | `/projects` | signed in |
| POST | `/projects` | ADMIN |
| GET | `/projects/:id` | signed in |
| PUT | `/projects/:id` | ADMIN |
| DELETE | `/projects/:id` | ADMIN (soft delete) |
| GET | `/users` | ADMIN |
| POST | `/users` | ADMIN |
| PUT | `/users/:id` | ADMIN |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Invalid configuration:` at startup | `.env` is missing or a listed variable is empty. Fill in each one named in the message. |
| `/api/health` returns `database: "down"` | PostgreSQL is not running or `DATABASE_URL` is wrong. Run `docker compose ps`; check port and password. |
| `docker compose up` fails with "port is already allocated" | Another PostgreSQL uses 5432. Set `POSTGRES_PORT=5433` and use that port in both database URLs. |
| Tests fail with `database "playwright_db_test" does not exist` | The data volume predates the init script. Run `docker compose exec postgres createdb -U <POSTGRES_USER> playwright_db_test`. |
| Login returns 429 | Ten attempts per 15 minutes per address. Wait, or restart the server in development. |
| Web app shows "Missing or invalid CSRF token" | The page is older than the session. Reload it. |
| Sign-in works but the next request is 401 in production | The site is served over plain HTTP, so the `Secure` cookie is dropped. Serve it over HTTPS. |
````

- [ ] **Step 7: Update the repo-level docs**

In `CLAUDE.md`, change "Three sibling projects" to "Four sibling projects" in the Repository Layout paragraph, and add this row to the table:

```markdown
| `PlaywrightPlatform/` | Test-management backend (Fastify + PostgreSQL) and React web app; the extension signs in to it over HTTP | Node + Docker |
```

Add this subsection under "## Commands":

````markdown
### PlaywrightPlatform
```bash
cd PlaywrightPlatform
docker compose up -d postgres && npm run db:migrate && npm run db:seed   # once
npm run dev:server           # API on :3000
npm run dev:web              # web on :5173
npm test                     # server tests (Vitest, real Postgres)
npm run test:e2e             # web tests (Playwright)
npm run typecheck
```
Layering is strict: `routes/` → `services/` → `repositories/`; only repositories query the database; only `web/src/api/` calls `fetch`. See `PlaywrightPlatform/README.md`.
````

In the root `README.md`, add this bullet to the "Solution" list:

```markdown
- **Platform** — a Fastify + PostgreSQL backend and React web app for projects, users, and roles, with the schema for scripts, skills, CI runs, and healing already in place. See `PlaywrightPlatform/README.md`.
```

and this row to the "Tech Stack" table:

```markdown
| `PlaywrightPlatform/` | TypeScript, Fastify, Knex, PostgreSQL, Zod, React, Vite, Vitest, Playwright Test |
```

- [ ] **Step 8: Run the complete verification**

From `PlaywrightPlatform/`, one command at a time, confirming each before the next:

```bash
npm run typecheck
npm test
npm run test:e2e
node --test ../PlaywrightExtension/tests/
npm run build
```

Expected: typecheck silent; 69 server tests pass; 10 E2E tests pass; 10 extension tests pass; build succeeds.

Then confirm nothing sensitive or unintended is staged:

```bash
git status --short
git diff --stat main -- PlaywrightBridge PlaywrightOrchestrator
git ls-files | grep -E "(^|/)\.env$" ; echo "env tracked: exit $?"
```

Expected: only documentation changes pending; the `--stat` output is empty (Bridge and Orchestrator untouched); `env tracked: exit 1`.

- [ ] **Step 9: Commit**

```bash
git add PlaywrightPlatform CLAUDE.md README.md
git commit -m "feat(platform): serve built web app in production and document the platform"
```

