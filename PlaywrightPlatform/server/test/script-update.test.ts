import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';
import { SAMPLE, breakAudit, newProject, newScript, postScript, repairAudit } from './script-helpers';

const NEXT = `${SAMPLE}\n// second version\n`;

describe('scripts: update and delete', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;
  let projectId: number;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await repairAudit(ctx.db);
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN', displayName: 'Ada Admin' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    projectId = await newProject(ctx, asAdmin);
  });
  afterEach(() => repairAudit(ctx.db));

  const put = (id: number, payload: unknown, headers = asAdmin) =>
    ctx.app.inject({ method: 'PUT', url: `/api/scripts/${id}`, headers, payload: payload as object });
  const del = (id: number, headers = asAdmin) =>
    ctx.app.inject({ method: 'DELETE', url: `/api/scripts/${id}`, headers });
  const get = (id: number, headers = asAdmin) =>
    ctx.app.inject({ method: 'GET', url: `/api/scripts/${id}`, headers });
  const versionsOf = (id: number) => ctx.db('test_script_versions').where({ script_id: id }).orderBy('version');
  const auditFor = (action: string) => ctx.db('audit_logs').where({ action }).orderBy('id');
  const setProject = (payload: object) =>
    ctx.app.inject({ method: 'PUT', url: `/api/projects/${projectId}`, headers: asAdmin, payload });
  const loginAs = async (role: 'USER' | 'VIEWER', displayName?: string) => {
    const user = await createUser(ctx.db, { role, displayName });
    return (await loginExt(ctx.app, user.email, user.password)).headers;
  };

  it('changes metadata without creating a version', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { tags: ['smoke'] });
    await ctx.db('test_scripts').where({ id: script.id }).update({ lifecycle_state: 'PASSED' });
    const asEditor = await loginAs('USER', 'Uma User');

    const res = await put(
      script.id,
      { name: '  Login v2 ', description: 'new', testScenario: 'steps', tags: ['regression'] },
      asEditor,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({
      name: 'Login v2',
      description: 'new',
      testScenario: 'steps',
      tags: ['regression'],
      version: 1,
      content: SAMPLE,
      lifecycleState: 'PASSED',
      updatedBy: 'Uma User',
    });
    expect(await versionsOf(script.id)).toHaveLength(1);

    const audit = await auditFor('script.update');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toEqual({ changed: ['name', 'description', 'testScenario', 'tags'] });
    expect(await auditFor('script.version')).toHaveLength(0);
  });

  it('creates a new version when the content changes', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await ctx.db('test_scripts').where({ id: script.id }).update({ lifecycle_state: 'PASSED' });

    const res = await put(script.id, { content: NEXT, baseVersion: 1, changeSummary: 'Add assertion' });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({ version: 2, content: NEXT, lifecycleState: 'SAVED' });

    const versions = await versionsOf(script.id);
    expect(versions.map((v) => [v.version, v.source, v.change_summary, v.script_content])).toEqual([
      [1, 'MANUAL', '', SAMPLE],
      [2, 'MANUAL', 'Add assertion', NEXT],
    ]);
    expect(versions[1].created_by).toBe(admin.id);

    const audit = await auditFor('script.version');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toEqual({ version: 2, changed: ['content'] });
    expect(await auditFor('script.update')).toHaveLength(0);
  });

  it('records metadata and content changed together as one new version', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: NEXT, baseVersion: 1, tags: ['smoke'] });
    expect(res.json().script).toMatchObject({ version: 2, tags: ['smoke'] });
    expect((await auditFor('script.version'))[0].details).toEqual({ version: 2, changed: ['tags', 'content'] });
  });

  it('creates nothing when the content is unchanged', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: SAMPLE, baseVersion: 1, changeSummary: 'nothing really' });
    expect(res.statusCode).toBe(200);
    expect(res.json().script.version).toBe(1);
    expect(await versionsOf(script.id)).toHaveLength(1);
    expect(await auditFor('script.version')).toHaveLength(0);
    expect(await auditFor('script.update')).toHaveLength(0);
  });

  it('treats the same text with Windows line endings as unchanged', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: SAMPLE.replace(/\n/g, '\r\n'), baseVersion: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({ version: 1, content: SAMPLE });
    expect(await versionsOf(script.id)).toHaveLength(1);
  });

  it('updates metadata but not the version when the content sent is unchanged', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: SAMPLE, baseVersion: 1, description: 'changed' });
    expect(res.json().script).toMatchObject({ version: 1, description: 'changed' });
    expect((await auditFor('script.update'))[0].details).toEqual({ changed: ['description'] });
  });

  it('refuses content based on a stale version and says who saved the current one', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const asEditor = await loginAs('USER', 'Uma User');
    expect((await put(script.id, { content: NEXT, baseVersion: 1 })).statusCode).toBe(200);

    const stale = await put(script.id, { content: '// mine\n', baseVersion: 1 }, asEditor);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2, updatedBy: 'Ada Admin' },
    });
    // Even text identical to the current content is refused: the caller has not seen v2.
    expect((await put(script.id, { content: NEXT, baseVersion: 1 }, asEditor)).statusCode).toBe(409);

    expect((await get(script.id)).json().script).toMatchObject({ version: 2, content: NEXT });
    expect(await versionsOf(script.id)).toHaveLength(2);

    // Metadata needs no base version and still works.
    expect((await put(script.id, { description: 'still editable' }, asEditor)).statusCode).toBe(200);
  });

  it.each([
    ['an empty body', {}],
    ['only a change summary', { changeSummary: 'just this' }],
    ['only a base version', { baseVersion: 1 }],
    ['content without a base version', { content: '// x\n' }],
    ['a base version of zero', { content: '// x\n', baseVersion: 0 }],
    ['a base version sent as text', { content: '// x\n', baseVersion: '1' }],
    ['an empty name', { name: '' }],
    ['empty content', { content: '', baseVersion: 1 }],
    ['content over the limit', { content: 'x'.repeat(1_000_001), baseVersion: 1 }],
    ['an invalid tag', { tags: ['bad/tag'] }],
    ['a null character', { description: 'bad\u0000text' }],
  ])('rejects %s', async (_label, payload) => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect((await get(script.id)).json().script).toMatchObject({ name: 'Login Test', version: 1 });
  });

  it('names the missing field when content arrives without a base version', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: '// x\n' });
    expect(res.json().error.details).toContainEqual({
      path: 'baseVersion',
      message: 'baseVersion is required when content is sent.',
    });
  });

  it('accepts a 2 MB body on update', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: '"'.repeat(1_000_000), baseVersion: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().script.version).toBe(2);
  });

  it('refuses a rename to a name another script uses, ignoring case', async () => {
    const alpha = await newScript(ctx, asAdmin, projectId, { name: 'Alpha' });
    await newScript(ctx, asAdmin, projectId, { name: 'Beta' });

    const clash = await put(alpha.id, { name: 'BETA', content: NEXT, baseVersion: 1 });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({
      code: 'SCRIPT_NAME_TAKEN',
      message: 'A script named "BETA" already exists in this project.',
    });
    // The whole change is undone, including the new version.
    expect((await get(alpha.id)).json().script).toMatchObject({ name: 'Alpha', version: 1 });
    expect(await versionsOf(alpha.id)).toHaveLength(1);

    expect((await put(alpha.id, { name: 'ALPHA' })).json().script.name).toBe('ALPHA');
  });

  it('replaces and clears tags', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { tags: ['smoke', 'auth'] });
    expect((await put(script.id, { tags: ['regression', 'AUTH'] })).json().script.tags).toEqual(['auth', 'regression']);
    expect((await put(script.id, { tags: [] })).json().script.tags).toEqual([]);
    expect(await ctx.db('script_tags').where({ script_id: script.id })).toHaveLength(0);
    expect(await ctx.db('tags')).toHaveLength(3); // tag rows are never deleted
  });

  it('lets exactly one of two simultaneous saves from the same base win', async () => {
    for (let round = 0; round < 5; round += 1) {
      const script = await newScript(ctx, asAdmin, projectId, { name: `Race ${round}` });
      const results = await Promise.all([
        put(script.id, { content: '// first\n', baseVersion: 1 }),
        put(script.id, { content: '// second\n', baseVersion: 1 }),
      ]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      const winner = results.find((res) => res.statusCode === 200)!;
      const loser = results.find((res) => res.statusCode === 409)!;
      expect(loser.json().error.code).toBe('VERSION_CONFLICT');

      const versions = await versionsOf(script.id);
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(versions[1].script_content).toBe(winner.json().script.content);
    }
  });

  it('refuses writes in an archived project and hides the scripts of a deleted one', async () => {
    const script = await newScript(ctx, asAdmin, projectId);

    await setProject({ status: 'ARCHIVED' });
    const refused = [
      await put(script.id, { name: 'X' }),
      await put(script.id, { content: NEXT, baseVersion: 1 }),
      await del(script.id),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROJECT_NOT_ACTIVE');
    }
    expect((await get(script.id)).statusCode).toBe(200);

    await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: asAdmin });
    for (const res of [await put(script.id, { name: 'X' }), await del(script.id), await get(script.id)]) {
      expect(res.statusCode).toBe(404);
    }
    const row = await ctx.db('test_scripts').where({ id: script.id }).first();
    expect(row).toMatchObject({ name: 'Login Test', status: 'ACTIVE', version: 1 });
  });

  it('soft-deletes: the row and history stay, the script disappears, the name is reusable', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { name: 'Doomed', tags: ['smoke'] });
    await put(script.id, { content: NEXT, baseVersion: 1 });

    const res = await del(script.id);
    expect(res.statusCode).toBe(204);

    const row = await ctx.db('test_scripts').where({ id: script.id }).first();
    expect(row).toMatchObject({ status: 'DELETED', deleted_by: admin.id });
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(await versionsOf(script.id)).toHaveLength(2);

    expect((await get(script.id)).statusCode).toBe(404);
    expect((await put(script.id, { name: 'X' })).statusCode).toBe(404);
    expect((await del(script.id)).statusCode).toBe(404);

    const listUrl = `/api/projects/${projectId}/scripts`;
    const live = await ctx.app.inject({ method: 'GET', url: listUrl, headers: asAdmin });
    expect(live.json().items).toEqual([]);
    const deleted = await ctx.app.inject({ method: 'GET', url: `${listUrl}?status=DELETED`, headers: asAdmin });
    expect(deleted.json().items.map((s: { name: string }) => s.name)).toEqual(['Doomed']);

    expect((await postScript(ctx, asAdmin, projectId, { name: 'Doomed' })).statusCode).toBe(201);

    const audit = await auditFor('script.delete');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ resource_id: String(script.id), user_id: admin.id });
    expect(audit[0].details).toEqual({ name: 'Doomed', version: 2 });
  });

  it('lets a USER update and delete, and refuses a VIEWER', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const asViewer = await loginAs('VIEWER');
    for (const res of [await put(script.id, { name: 'Nope' }, asViewer), await del(script.id, asViewer)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }

    const asUser = await loginAs('USER');
    expect((await put(script.id, { name: 'By User' }, asUser)).statusCode).toBe(200);
    expect((await del(script.id, asUser)).statusCode).toBe(204);
  });

  it('requires a session', async () => {
    const calls = [
      ctx.app.inject({ method: 'PUT', url: '/api/scripts/1', payload: { name: 'X' } }),
      ctx.app.inject({ method: 'DELETE', url: '/api/scripts/1' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('enforces CSRF on cookie-authenticated update and delete', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const web = await loginWeb(ctx.app, admin.email, admin.password);
    const url = `/api/scripts/${script.id}`;

    const putWithout = await ctx.app.inject({ method: 'PUT', url, cookies: web.cookies, payload: { name: 'No Token' } });
    const delWithout = await ctx.app.inject({ method: 'DELETE', url, cookies: web.cookies });
    for (const res of [putWithout, delWithout]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_INVALID');
    }

    const putWith = await ctx.app.inject({
      method: 'PUT',
      url,
      cookies: web.cookies,
      headers: web.headers,
      payload: { name: 'With Token' },
    });
    expect(putWith.statusCode).toBe(200);
    const delWith = await ctx.app.inject({ method: 'DELETE', url, cookies: web.cookies, headers: web.headers });
    expect(delWith.statusCode).toBe(204);
  });

  it('rolls update and delete back when the audit row cannot be written', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await breakAudit(ctx.db);

    expect((await put(script.id, { content: NEXT, baseVersion: 1, tags: ['x'] })).statusCode).toBe(500);
    expect((await put(script.id, { name: 'Renamed' })).statusCode).toBe(500);
    expect((await del(script.id)).statusCode).toBe(500);

    await repairAudit(ctx.db);
    expect((await get(script.id)).json().script).toMatchObject({
      name: 'Login Test',
      version: 1,
      content: SAMPLE,
      status: 'ACTIVE',
      tags: [],
    });
    expect(await versionsOf(script.id)).toHaveLength(1);
  });

  it('drops a deleted script from the project overview', async () => {
    const keep = await newScript(ctx, asAdmin, projectId, { name: 'Keep' });
    const drop = await newScript(ctx, asAdmin, projectId, { name: 'Drop' });
    await del(drop.id);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect(detail.json().overview).toMatchObject({ totalScripts: 1, notExecuted: 1 });
    expect((await get(keep.id)).statusCode).toBe(200);
  });

  it('never writes script content into an audit row', async () => {
    const first = 'CONTENT-MARKER-ONE-7c21';
    const second = 'CONTENT-MARKER-TWO-88ab';
    const script = await newScript(ctx, asAdmin, projectId, { content: `// ${first}\n` });
    await put(script.id, { content: `// ${second}\n`, baseVersion: 1, changeSummary: 'swap' });
    await put(script.id, { name: 'Renamed' });
    await del(script.id);

    const rows = await ctx.db('audit_logs').where({ resource: 'script' }).orderBy('id');
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'script.create',
      'script.version',
      'script.update',
      'script.delete',
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(first);
    expect(stored).not.toContain(second);
  });
});
