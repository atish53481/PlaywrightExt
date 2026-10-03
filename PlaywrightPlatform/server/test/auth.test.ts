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
