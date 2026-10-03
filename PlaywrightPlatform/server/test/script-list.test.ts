import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';
import { newProject, newScript } from './script-helpers';

describe('scripts: list, search, and tags', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;
  let projectId: number;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN', displayName: 'Ada Admin' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    projectId = await newProject(ctx, asAdmin);
  });

  const list = (query = '', headers = asAdmin, project: number | string = projectId) =>
    ctx.app.inject({ method: 'GET', url: `/api/projects/${project}/scripts${query}`, headers });
  /** Pass `{}` as headers for a call without a session: `undefined` would select the default. */
  const tagList = (query = '', headers: Record<string, string> = asAdmin) =>
    ctx.app.inject({ method: 'GET', url: `/api/tags${query}`, headers });
  const names = (res: { json(): { items: { name: string }[] } }) => res.json().items.map((s) => s.name);
  const create = (payload: Record<string, unknown>) => newScript(ctx, asAdmin, projectId, payload);
  const loginAs = async (role: 'USER' | 'VIEWER') => {
    const user = await createUser(ctx.db, { role });
    return (await loginExt(ctx.app, user.email, user.password)).headers;
  };

  it('lists the most recently updated script first, without the large text fields', async () => {
    await create({ name: 'Alpha', description: 'first', testScenario: 'steps', tags: ['smoke'] });
    await create({ name: 'Beta' });

    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(names(res)).toEqual(['Beta', 'Alpha']);
    const alpha = res.json().items[1];
    expect(alpha).toMatchObject({
      projectId,
      name: 'Alpha',
      description: 'first',
      language: 'TypeScript',
      framework: 'Playwright',
      scriptType: 'E2E',
      version: 1,
      status: 'ACTIVE',
      lifecycleState: 'SAVED',
      tags: ['smoke'],
      updatedBy: 'Ada Admin',
    });
    expect(alpha).not.toHaveProperty('content');
    expect(alpha).not.toHaveProperty('testScenario');

    // Order follows the last update, not creation.
    await ctx.db('test_scripts').where({ name: 'Alpha' }).update({ updated_at: new Date(Date.now() + 60_000) });
    expect(names(await list())).toEqual(['Alpha', 'Beta']);
  });

  it('returns only the scripts of the requested project', async () => {
    await create({ name: 'Mine' });
    const other = await newProject(ctx, asAdmin, 'Other');
    await newScript(ctx, asAdmin, other, { name: 'Theirs' });

    expect(names(await list())).toEqual(['Mine']);
    expect(names(await list('', asAdmin, other))).toEqual(['Theirs']);
  });

  it('searches name, description, test scenario, and tag names, ignoring case, but not content', async () => {
    await create({ name: 'Login Flow' });
    await create({ name: 'A', description: 'covers LOGIN errors' });
    await create({ name: 'B', testScenario: 'the user tries to login twice' });
    await create({ name: 'C', tags: ['login-suite'] });
    await create({ name: 'Unrelated', content: '// login appears only in the code\n' });

    expect(names(await list('?search=login')).sort()).toEqual(['A', 'B', 'C', 'Login Flow']);
    expect(names(await list('?search=%20LOGIN%20')).sort()).toEqual(['A', 'B', 'C', 'Login Flow']);
    expect(names(await list('?search=nothing-like-this'))).toEqual([]);
  });

  it('treats %, _, and backslash in a search as literal characters', async () => {
    await create({ name: '100% Coverage' });
    await create({ name: 'snake_case' });
    await create({ name: 'Plain' });

    expect(names(await list('?search=%25'))).toEqual(['100% Coverage']);
    expect(names(await list('?search=_'))).toEqual(['snake_case']);
    expect(names(await list('?search=%5C'))).toEqual([]);
  });

  it('filters by one exact tag, ignoring case', async () => {
    await create({ name: 'Tagged', tags: ['Smoke'] });
    await create({ name: 'Near miss', tags: ['smoke-test'] });
    await create({ name: 'Untagged' });

    expect(names(await list('?tag=smoke'))).toEqual(['Tagged']);
    expect(names(await list('?tag=SMOKE'))).toEqual(['Tagged']);
    expect(names(await list('?tag=smo'))).toEqual([]);
    expect(names(await list('?tag=%25'))).toEqual([]);
  });

  it('combines search and tag filter', async () => {
    await create({ name: 'Login smoke', tags: ['smoke'] });
    await create({ name: 'Login regression', tags: ['regression'] });
    await create({ name: 'Checkout smoke', tags: ['smoke'] });

    expect(names(await list('?search=login&tag=smoke'))).toEqual(['Login smoke']);
  });

  it('paginates and validates paging input', async () => {
    for (const name of ['One', 'Two', 'Three']) await create({ name });

    const page2 = await list('?page=2&pageSize=2');
    expect(page2.json()).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(names(page2)).toEqual(['One']);
    expect(names(await list('?page=9'))).toEqual([]);
    expect((await list('?pageSize=100')).statusCode).toBe(200);

    const invalid = [
      '?page=0',
      '?pageSize=0',
      '?pageSize=101',
      '?page=abc',
      '?page=400000000000000000',
      '?status=ARCHIVED',
      '?status=NOPE',
      '?search=%00',
      '?tag=%00',
    ];
    for (const query of invalid) {
      const res = await list(query);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('shows deleted scripts only to an ADMIN who asks for them', async () => {
    await create({ name: 'Live' });
    await ctx.db('test_scripts').insert({ project_id: projectId, name: 'Gone', script_content: '//', status: 'DELETED' });

    expect(names(await list())).toEqual(['Live']);
    expect(names(await list('?status=DELETED'))).toEqual(['Gone']);

    for (const role of ['USER', 'VIEWER'] as const) {
      const headers = await loginAs(role);
      expect((await list('', headers)).statusCode).toBe(200);
      const denied = await list('?status=DELETED', headers);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('answers 404 for an unknown or deleted project and still lists an archived one', async () => {
    await create({ name: 'Kept' });
    expect((await list('', asAdmin, 9999)).statusCode).toBe(404);
    for (const bad of ['abc', '0', '1.5']) expect((await list('', asAdmin, bad)).statusCode).toBe(400);

    const setStatus = (status: string) =>
      ctx.app.inject({ method: 'PUT', url: `/api/projects/${projectId}`, headers: asAdmin, payload: { status } });
    await setStatus('ARCHIVED');
    expect(names(await list())).toEqual(['Kept']);

    await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect((await list()).statusCode).toBe(404);
  });

  it('requires a session to list scripts or tags', async () => {
    const noSession = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/scripts` });
    expect(noSession.statusCode).toBe(401);
    expect((await tagList('', {})).statusCode).toBe(401);
  });

  it('lists tag names alphabetically, filtered by a literal search, at most fifty', async () => {
    await create({ name: 'A', tags: ['smoke', 'Regression', 'checkout', '100.5'] });
    expect((await tagList()).json()).toEqual({ items: ['100.5', 'checkout', 'Regression', 'smoke'] });
    expect((await tagList('?search=REG')).json().items).toEqual(['Regression']);
    expect((await tagList('?search=%25')).json().items).toEqual([]);
    expect((await tagList('?search=_')).json().items).toEqual([]);
    for (const role of ['USER', 'VIEWER'] as const) {
      expect((await tagList('', await loginAs(role))).statusCode).toBe(200);
    }
    expect((await tagList(`?search=${'x'.repeat(41)}`)).statusCode).toBe(400);

    await ctx.db('tags').insert(Array.from({ length: 60 }, (_, i) => ({ name: `bulk-${String(i).padStart(2, '0')}` })));
    const capped = (await tagList()).json().items;
    expect(capped).toHaveLength(50);
    expect(capped[0]).toBe('100.5');
  });
});
