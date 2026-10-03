import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';
import { SAMPLE, breakAudit, newProject, newScript, postScript, repairAudit } from './script-helpers';

const V2 = `${SAMPLE}\n// second version\n`;

describe('scripts: versions, restore, duplicate, and download', () => {
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

  /** Pass `{}` as headers for a call without a session. */
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    headers: Record<string, string> = asAdmin,
    payload?: object,
  ) => ctx.app.inject({ method, url: `/api${url}`, headers, payload });
  const save = (id: number, content: string, baseVersion: number, changeSummary = '') =>
    call('PUT', `/scripts/${id}`, asAdmin, { content, baseVersion, changeSummary });
  const versionRows = (id: number) => ctx.db('test_script_versions').where({ script_id: id }).orderBy('version');
  const loginAs = async (role: 'USER' | 'VIEWER') => {
    const user = await createUser(ctx.db, { role });
    return (await loginExt(ctx.app, user.email, user.password)).headers;
  };

  it('lists versions newest first without their content', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { source: 'RECORDED', changeSummary: 'From the recorder' });
    await save(script.id, V2, 1, 'Add assertion');

    const res = await call('GET', `/scripts/${script.id}/versions`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toMatchObject([
      { version: 2, source: 'MANUAL', changeSummary: 'Add assertion', createdBy: 'Ada Admin', size: V2.length },
      { version: 1, source: 'RECORDED', changeSummary: 'From the recorder', createdBy: 'Ada Admin', size: SAMPLE.length },
    ]);
    expect(res.json().items[0]).not.toHaveProperty('content');
    expect(new Date(res.json().items[0].createdAt).getTime()).not.toBeNaN();

    expect((await call('GET', '/scripts/9999/versions')).statusCode).toBe(404);
  });

  it('fetches one version with its content', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    const one = await call('GET', `/scripts/${script.id}/versions/1`);
    expect(one.statusCode).toBe(200);
    expect(one.json().version).toMatchObject({ version: 1, content: SAMPLE, source: 'MANUAL', size: SAMPLE.length });

    const missing = await call('GET', `/scripts/${script.id}/versions/9`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Version not found.');
    expect((await call('GET', '/scripts/9999/versions/1')).json().error.message).toBe('Script not found.');
    for (const bad of ['0', 'abc', '1.5', '99999999999']) {
      expect((await call('GET', `/scripts/${script.id}/versions/${bad}`)).statusCode).toBe(400);
    }
  });

  it('restores an old version as a new one and leaves history untouched', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    await ctx.db('test_scripts').where({ id: script.id }).update({ lifecycle_state: 'PASSED' });

    const res = await call('POST', `/scripts/${script.id}/versions/1/restore`);
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({ version: 3, content: SAMPLE, lifecycleState: 'SAVED' });

    const rows = await versionRows(script.id);
    expect(rows.map((r) => [r.version, r.source, r.change_summary, r.script_content])).toEqual([
      [1, 'MANUAL', '', SAMPLE],
      [2, 'MANUAL', '', V2],
      [3, 'RESTORED', 'Restored from v1', SAMPLE],
    ]);
  });

  it('refuses to restore the latest version, an unknown version, or anything in an archived project', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    const latest = await call('POST', `/scripts/${script.id}/versions/2/restore`);
    expect(latest.statusCode).toBe(409);
    expect(latest.json().error).toMatchObject({ code: 'ALREADY_CURRENT', message: 'v2 is already the latest version.' });

    const unknown = await call('POST', `/scripts/${script.id}/versions/7/restore`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Version not found.');
    expect((await call('POST', `/scripts/${script.id}/versions/abc/restore`)).statusCode).toBe(400);

    await call('PUT', `/projects/${projectId}`, asAdmin, { status: 'ARCHIVED' });
    for (const url of [`/scripts/${script.id}/versions/1/restore`, `/scripts/${script.id}/duplicate`]) {
      const res = await call('POST', url);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROJECT_NOT_ACTIVE');
    }
    expect(await versionRows(script.id)).toHaveLength(2);
    expect(await ctx.db('test_scripts')).toHaveLength(1);
  });

  it('duplicates content, metadata, and tags into an independent script', async () => {
    const original = await newScript(ctx, asAdmin, projectId, {
      description: 'Signs in',
      testScenario: 'steps',
      language: 'JavaScript',
      scriptType: 'API',
      tags: ['smoke', 'auth'],
    });
    await save(original.id, V2, 1);

    const res = await call('POST', `/scripts/${original.id}/duplicate`);
    expect(res.statusCode).toBe(201);
    const copy = res.json().script;
    expect(copy).toMatchObject({
      projectId,
      name: 'Login Test (copy)',
      description: 'Signs in',
      testScenario: 'steps',
      language: 'JavaScript',
      scriptType: 'API',
      tags: ['auth', 'smoke'],
      content: V2,
      version: 1,
      lifecycleState: 'SAVED',
    });
    expect(copy.id).not.toBe(original.id);

    const history = await call('GET', `/scripts/${copy.id}/versions`);
    expect(history.json().items).toMatchObject([
      { version: 1, source: 'MANUAL', changeSummary: 'Duplicated from Login Test v2' },
    ]);

    // Changing the copy leaves the original alone.
    await save(copy.id, '// changed copy\n', 1);
    expect((await call('GET', `/scripts/${original.id}`)).json().script).toMatchObject({ version: 2, content: V2 });
    expect(await versionRows(original.id)).toHaveLength(2);
  });

  it('accepts a name for the copy and refuses one that is taken', async () => {
    const original = await newScript(ctx, asAdmin, projectId);

    const named = await call('POST', `/scripts/${original.id}/duplicate`, asAdmin, { name: '  Second Copy ' });
    expect(named.json().script.name).toBe('Second Copy');
    expect((await call('POST', `/scripts/${original.id}/duplicate`)).statusCode).toBe(201);

    const clash = await call('POST', `/scripts/${original.id}/duplicate`);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({
      code: 'SCRIPT_NAME_TAKEN',
      message: 'A script named "Login Test (copy)" already exists in this project.',
    });
    expect((await call('POST', `/scripts/${original.id}/duplicate`, asAdmin, { name: '' })).statusCode).toBe(400);
    expect((await call('POST', '/scripts/9999/duplicate')).statusCode).toBe(404);
    expect(await ctx.db('test_scripts')).toHaveLength(3);
  });

  it('shortens a long name so the default copy name still fits', async () => {
    const original = await newScript(ctx, asAdmin, projectId, { name: 'N'.repeat(200) });
    const copy = (await call('POST', `/scripts/${original.id}/duplicate`)).json().script;
    expect(copy.name).toHaveLength(200);
    expect(copy.name.endsWith(' (copy)')).toBe(true);
  });

  it('downloads the latest content as a file', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    const res = await call('GET', `/scripts/${script.id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="login-test.spec.ts"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(V2);

    const js = await newScript(ctx, asAdmin, projectId, { name: 'Plain JS', language: 'JavaScript' });
    const jsRes = await call('GET', `/scripts/${js.id}/download`);
    expect(jsRes.headers['content-disposition']).toBe('attachment; filename="plain-js.spec.js"');
  });

  it('downloads one chosen version', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    expect((await call('GET', `/scripts/${script.id}/download?version=1`)).body).toBe(SAMPLE);
    expect((await call('GET', `/scripts/${script.id}/download?version=2`)).body).toBe(V2);
    expect((await call('GET', `/scripts/${script.id}/download?version=9`)).statusCode).toBe(404);
    expect((await call('GET', `/scripts/${script.id}/download?version=abc`)).statusCode).toBe(400);
    expect((await call('GET', '/scripts/9999/download')).statusCode).toBe(404);
  });

  it.each([
    ['../../etc/passwd', 'etc-passwd.spec.ts'],
    ['a"; filename="evil.exe', 'a-filename-evil-exe.spec.ts'],
    ['line\r\nSet-Cookie: x=1', 'line-set-cookie-x-1.spec.ts'],
    ['Ünïcödé Tést', 'unicode-test.spec.ts'],
    ['日本語', 'script.spec.ts'],
    ['x'.repeat(200), `${'x'.repeat(80)}.spec.ts`],
  ])('builds a safe file name from the script name %j', async (name, expected) => {
    const script = await newScript(ctx, asAdmin, projectId, { name });
    const res = await call('GET', `/scripts/${script.id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${expected}"`);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('lets a VIEWER read history and download, and only writers restore or duplicate', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    const asViewer = await loginAs('VIEWER');
    const asUser = await loginAs('USER');

    const reads = [
      `/scripts/${script.id}/versions`,
      `/scripts/${script.id}/versions/1`,
      `/scripts/${script.id}/download`,
    ];
    for (const headers of [asViewer, asUser]) {
      for (const url of reads) expect((await call('GET', url, headers)).statusCode).toBe(200);
    }

    const writes = [`/scripts/${script.id}/versions/1/restore`, `/scripts/${script.id}/duplicate`];
    for (const url of writes) {
      const denied = await call('POST', url, asViewer);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('FORBIDDEN');
    }
    expect((await call('POST', writes[0], asUser)).statusCode).toBe(200);
    expect((await call('POST', writes[1], asUser)).statusCode).toBe(201);
  });

  it('requires a session', async () => {
    const calls = [
      call('GET', '/scripts/1/versions', {}),
      call('GET', '/scripts/1/versions/1', {}),
      call('POST', '/scripts/1/versions/1/restore', {}),
      call('POST', '/scripts/1/duplicate', {}),
      call('GET', '/scripts/1/download', {}),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('enforces CSRF on cookie-authenticated restore and duplicate', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    const web = await loginWeb(ctx.app, admin.email, admin.password);
    const restoreUrl = `/api/scripts/${script.id}/versions/1/restore`;
    const duplicateUrl = `/api/scripts/${script.id}/duplicate`;

    for (const url of [restoreUrl, duplicateUrl]) {
      const without = await ctx.app.inject({ method: 'POST', url, cookies: web.cookies });
      expect(without.statusCode).toBe(403);
      expect(without.json().error.code).toBe('CSRF_INVALID');
    }
    const restored = await ctx.app.inject({ method: 'POST', url: restoreUrl, cookies: web.cookies, headers: web.headers });
    expect(restored.statusCode).toBe(200);
    const copied = await ctx.app.inject({ method: 'POST', url: duplicateUrl, cookies: web.cookies, headers: web.headers });
    expect(copied.statusCode).toBe(201);

    // Reads need no token.
    const read = await ctx.app.inject({ method: 'GET', url: `/api/scripts/${script.id}/download`, cookies: web.cookies });
    expect(read.statusCode).toBe(200);
  });

  it('audits restore and duplicate without the content', async () => {
    const marker = 'CONTENT-MARKER-RESTORE-5d10';
    const script = await newScript(ctx, asAdmin, projectId, { content: `// ${marker}\n` });
    await save(script.id, V2, 1);
    await call('POST', `/scripts/${script.id}/versions/1/restore`);
    const copy = (await call('POST', `/scripts/${script.id}/duplicate`)).json().script;

    const rows = await ctx
      .db('audit_logs')
      .whereIn('action', ['script.restore', 'script.duplicate'])
      .orderBy('id');
    expect(rows.map((r: { action: string; resource_id: string }) => [r.action, r.resource_id])).toEqual([
      ['script.restore', String(script.id)],
      ['script.duplicate', String(copy.id)],
    ]);
    expect(rows[0].details).toEqual({ fromVersion: 1, version: 3 });
    expect(rows[1].details).toEqual({ fromScriptId: script.id, fromVersion: 3, name: 'Login Test (copy)' });
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it('rolls restore and duplicate back when the audit row cannot be written', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    await breakAudit(ctx.db);

    expect((await call('POST', `/scripts/${script.id}/versions/1/restore`)).statusCode).toBe(500);
    expect((await call('POST', `/scripts/${script.id}/duplicate`)).statusCode).toBe(500);

    await repairAudit(ctx.db);
    expect(await versionRows(script.id)).toHaveLength(2);
    expect(await ctx.db('test_scripts')).toHaveLength(1);
    expect((await call('GET', `/scripts/${script.id}`)).json().script).toMatchObject({ version: 2, content: V2 });
  });

  it('answers 404 on every script route once the project is deleted', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    expect((await call('DELETE', `/projects/${projectId}`)).statusCode).toBe(204);

    const calls = [
      call('GET', `/projects/${projectId}/scripts`),
      postScript(ctx, asAdmin, projectId, { name: 'New' }),
      call('GET', `/scripts/${script.id}`),
      call('PUT', `/scripts/${script.id}`, asAdmin, { name: 'X' }),
      call('DELETE', `/scripts/${script.id}`),
      call('POST', `/scripts/${script.id}/duplicate`),
      call('GET', `/scripts/${script.id}/versions`),
      call('GET', `/scripts/${script.id}/versions/1`),
      call('POST', `/scripts/${script.id}/versions/1/restore`),
      call('GET', `/scripts/${script.id}/download`),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(404);
  });
});
