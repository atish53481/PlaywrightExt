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
