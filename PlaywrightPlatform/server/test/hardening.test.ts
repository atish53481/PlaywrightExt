import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { ConfigError, loadConfig } from '../src/config';
import { createDb } from '../src/db';
import { assertDisposableDatabase } from '../src/migrate';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, testConfig, type TestContext } from './helpers';

const key = Buffer.alloc(32, 1).toString('base64');
const baseEnv = { DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: key };

describe('configuration hardening', () => {
  it('rejects a wildcard CORS origin', () => {
    expect(() => loadConfig({ ...baseEnv, CORS_ORIGINS: 'http://localhost:5173, *' })).toThrow(ConfigError);
  });

  it('accepts false or a list of proxy addresses for TRUST_PROXY and rejects anything else', () => {
    expect(loadConfig(baseEnv).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: '10.0.0.0/8, 127.0.0.1' }).trustProxy).toBe('10.0.0.0/8,127.0.0.1');
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: 'loopback' }).trustProxy).toBe('loopback');
    // "true" would believe X-Forwarded-For from anyone; a hop count cannot verify the peer.
    for (const bad of ['true', '1', 'maybe', '10.0.0.0/8, nonsense']) {
      expect(() => loadConfig({ ...baseEnv, TRUST_PROXY: bad })).toThrow(ConfigError);
    }
  });

  it('refuses to reset a database whose name does not end in _test', () => {
    expect(() => assertDisposableDatabase('postgresql://u:p@localhost:5432/playwright_db')).toThrow(/_test/);
    expect(() => assertDisposableDatabase('postgresql://u:p@localhost:5432/playwright_db_test')).not.toThrow();
  });
});

describe('rate limiting', () => {
  it('cannot be dodged by varying a junk Authorization header', async () => {
    const ctx = await makeApp({ RATE_LIMIT_MAX: '3' });
    try {
      const statuses: number[] = [];
      for (let n = 0; n < 5; n += 1) {
        const res = await ctx.app.inject({
          method: 'GET',
          url: '/api/health',
          headers: { authorization: `junk-${n}` },
        });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await closeApp(ctx);
    }
  });

  it('cannot be dodged by varying a bogus session cookie', async () => {
    const ctx = await makeApp({ RATE_LIMIT_MAX: '2' });
    try {
      const statuses: number[] = [];
      for (let n = 0; n < 4; n += 1) {
        const res = await ctx.app.inject({ method: 'GET', url: '/api/health', cookies: { pw_session: `bogus-${n}` } });
        statuses.push(res.statusCode);
      }
      expect(statuses).toEqual([200, 200, 429, 429]);
    } finally {
      await closeApp(ctx);
    }
  });
});

describe('client address behind a proxy', () => {
  const failedLogin = (ctx: TestContext) =>
    ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': '203.0.113.9' },
      payload: { email: 'nobody@example.com', password: 'whatever-pass', client: 'web' },
    });

  it('ignores X-Forwarded-For by default', async () => {
    const ctx = await makeApp();
    try {
      await resetDb(ctx.db);
      await failedLogin(ctx);
      const row = await ctx.db('audit_logs').first('ip');
      expect(row.ip).toBe('127.0.0.1');
    } finally {
      await closeApp(ctx);
    }
  });

  it('uses the forwarded address when the request comes from a trusted proxy', async () => {
    const ctx = await makeApp({ TRUST_PROXY: '127.0.0.1' }); // inject() connects from 127.0.0.1
    try {
      await resetDb(ctx.db);
      await failedLogin(ctx);
      const row = await ctx.db('audit_logs').first('ip');
      expect(row.ip).toBe('203.0.113.9');
    } finally {
      await closeApp(ctx);
    }
  });

  it('ignores X-Forwarded-For when the peer is not the configured proxy', async () => {
    const ctx = await makeApp({ TRUST_PROXY: '10.9.9.9' });
    try {
      await resetDb(ctx.db);
      await failedLogin(ctx);
      const row = await ctx.db('audit_logs').first('ip');
      expect(row.ip).toBe('127.0.0.1');
    } finally {
      await closeApp(ctx);
    }
  });
});

describe('health with credentials while the database is down', () => {
  it('still answers 503 rather than 500', async () => {
    const deadDb = createDb('postgresql://nobody:nothing@127.0.0.1:1/none', 500);
    const app = await buildApp({ config: testConfig(), db: deadDb });
    try {
      const withCookie = await app.inject({ method: 'GET', url: '/api/health', cookies: { pw_session: 'anything' } });
      expect(withCookie.statusCode).toBe(503);
      expect(withCookie.json()).toEqual({ status: 'degraded', database: 'down' });

      const withBearer = await app.inject({
        method: 'GET',
        url: '/api/health',
        headers: { authorization: 'Bearer anything' },
      });
      expect(withBearer.statusCode).toBe(503);
    } finally {
      await app.close();
      await deadDb.destroy();
    }
  });
});

describe('mutations are atomic with their audit row', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;

  const breakAudit = () =>
    ctx.db.raw(`
      create or replace function test_fail_audit() returns trigger as $$
      begin raise exception 'audit store unavailable'; end; $$ language plpgsql;
      create trigger test_fail_audit before insert on audit_logs
        for each row execute function test_fail_audit();
    `);
  const repairAudit = () =>
    ctx.db.raw(`
      drop trigger if exists test_fail_audit on audit_logs;
      drop function if exists test_fail_audit();
    `);

  beforeAll(async () => {
    ctx = await makeApp();
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await repairAudit();
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
  });
  afterEach(() => repairAudit());

  it('a failed audit write rolls back project creation', async () => {
    await breakAudit();
    const res = await ctx.app.inject({ method: 'POST', url: '/api/projects', headers: asAdmin, payload: { name: 'Ghost' } });
    expect(res.statusCode).toBe(500);
    expect(await ctx.db('projects')).toHaveLength(0);

    await repairAudit();
    const retry = await ctx.app.inject({ method: 'POST', url: '/api/projects', headers: asAdmin, payload: { name: 'Ghost' } });
    expect(retry.statusCode).toBe(201);
  });

  it('a failed audit write rolls back project update and delete', async () => {
    const created = await ctx.app.inject({ method: 'POST', url: '/api/projects', headers: asAdmin, payload: { name: 'Stable' } });
    const id = created.json().project.id;
    await breakAudit();

    const put = await ctx.app.inject({ method: 'PUT', url: `/api/projects/${id}`, headers: asAdmin, payload: { name: 'Changed' } });
    const del = await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${id}`, headers: asAdmin });
    expect(put.statusCode).toBe(500);
    expect(del.statusCode).toBe(500);

    const row = await ctx.db('projects').where({ id }).first();
    expect(row).toMatchObject({ name: 'Stable', status: 'ACTIVE' });
  });

  it('a failed audit write rolls back user creation', async () => {
    await breakAudit();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asAdmin,
      payload: { email: 'new@example.com', displayName: 'New', password: 'a-good-password', role: 'USER' },
    });
    expect(res.statusCode).toBe(500);
    expect(await ctx.db('users')).toHaveLength(1);
  });

  it('a failed audit write rolls back a password change and leaves sessions valid', async () => {
    const target = await createUser(ctx.db, { role: 'USER' });
    const theirs = (await loginExt(ctx.app, target.email, target.password)).headers;
    await breakAudit();

    const res = await ctx.app.inject({
      method: 'PUT',
      url: `/api/users/${target.id}`,
      headers: asAdmin,
      payload: { password: 'a-brand-new-password' },
    });
    expect(res.statusCode).toBe(500);

    await repairAudit();
    const me = await ctx.app.inject({ method: 'GET', url: '/api/auth/me', headers: theirs });
    expect(me.statusCode).toBe(200);
    await expect(loginExt(ctx.app, target.email, target.password)).resolves.toBeDefined();
    await expect(loginExt(ctx.app, target.email, 'a-brand-new-password')).rejects.toThrow(/401/);
  });

  it('a failed audit write leaves no session behind on login', async () => {
    const before = await ctx.db('sessions').count('* as n').first();
    await breakAudit();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { email: admin.email, password: admin.password, client: 'web' },
    });
    expect(res.statusCode).toBe(500);
    expect(res.cookies).toHaveLength(0);
    const after = await ctx.db('sessions').count('* as n').first();
    expect(after?.n).toBe(before?.n);
  });
});

describe('last-admin protection under concurrency', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await makeApp();
  });
  afterAll(() => closeApp(ctx));

  it('never lets two simultaneous demotions remove every administrator', async () => {
    for (let round = 0; round < 5; round += 1) {
      await resetDb(ctx.db);
      const a = await createUser(ctx.db, { role: 'ADMIN' });
      const b = await createUser(ctx.db, { role: 'ADMIN' });
      const headers = (await loginExt(ctx.app, a.email, a.password)).headers;

      const results = await Promise.all(
        [a.id, b.id].map((id) =>
          ctx.app.inject({ method: 'PUT', url: `/api/users/${id}`, headers, payload: { role: 'USER' } }),
        ),
      );

      const admins = await ctx.db('users').where({ role: 'ADMIN', status: 'ACTIVE' });
      expect(admins).toHaveLength(1);
      expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    }
  });
});

describe('out-of-range and malformed input returns 400', () => {
  let ctx: TestContext;
  let asAdmin: Record<string, string>;
  let cookieAdmin: Awaited<ReturnType<typeof loginWeb>>;

  beforeAll(async () => {
    ctx = await makeApp();
    await resetDb(ctx.db);
    const admin = await createUser(ctx.db, { role: 'ADMIN' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    cookieAdmin = await loginWeb(ctx.app, admin.email, admin.password);
  });
  afterAll(() => closeApp(ctx));

  it('rejects an absurd page number', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/projects?page=400000000000000000', headers: asAdmin });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a null character in search, project fields, and user fields', async () => {
    const search = await ctx.app.inject({ method: 'GET', url: '/api/projects?search=%00', headers: asAdmin });
    const name = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      headers: asAdmin,
      payload: { name: 'Bad\u0000Name' },
    });
    const description = await ctx.app.inject({
      method: 'POST',
      url: '/api/projects',
      cookies: cookieAdmin.cookies,
      headers: cookieAdmin.headers,
      payload: { name: 'Fine', description: 'bad\u0000text' },
    });
    const displayName = await ctx.app.inject({
      method: 'POST',
      url: '/api/users',
      headers: asAdmin,
      payload: { email: 'x@example.com', displayName: 'A\u0000B', password: 'a-good-password', role: 'USER' },
    });
    for (const res of [search, name, description, displayName]) {
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
  });
});
