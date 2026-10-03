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
