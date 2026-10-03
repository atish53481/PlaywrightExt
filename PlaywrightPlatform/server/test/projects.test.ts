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
