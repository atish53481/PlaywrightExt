import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';
import { SAMPLE, breakAudit, newProject, newScript, postScript, repairAudit } from './script-helpers';

describe('scripts: create and read', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;
  let projectId: number;

  beforeAll(async () => {
    // Script tests send more requests per minute than the default limit allows.
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

  const get = (id: number | string, headers = asAdmin) =>
    ctx.app.inject({ method: 'GET', url: `/api/scripts/${id}`, headers });
  const setProject = (payload: object) =>
    ctx.app.inject({ method: 'PUT', url: `/api/projects/${projectId}`, headers: asAdmin, payload });

  it('creates the script and its first version', async () => {
    const res = await postScript(ctx, asAdmin, projectId, {
      description: 'Signs in',
      testScenario: 'Open login, sign in, land on the dashboard',
      tags: ['smoke'],
    });
    expect(res.statusCode).toBe(201);
    const script = res.json().script;
    expect(script).toMatchObject({
      projectId,
      name: 'Login Test',
      description: 'Signs in',
      testScenario: 'Open login, sign in, land on the dashboard',
      content: SAMPLE,
      language: 'TypeScript',
      framework: 'Playwright',
      scriptType: 'E2E',
      version: 1,
      status: 'ACTIVE',
      lifecycleState: 'SAVED',
      tags: ['smoke'],
      updatedBy: 'Ada Admin',
    });
    expect(script.id).toBeGreaterThan(0);
    expect(new Date(script.createdAt).getTime()).not.toBeNaN();
    expect(new Date(script.updatedAt).getTime()).not.toBeNaN();

    const row = await ctx.db('test_scripts').where({ id: script.id }).first();
    expect(row).toMatchObject({ created_by: admin.id, updated_by: admin.id, version: 1, script_content: SAMPLE });
    const versions = await ctx.db('test_script_versions').where({ script_id: script.id });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      script_content: SAMPLE,
      source: 'MANUAL',
      change_summary: '',
      created_by: admin.id,
    });
  });

  it('applies defaults and trims text fields', async () => {
    const res = await postScript(ctx, asAdmin, projectId, { name: '  Checkout  ', description: '  spaced  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json().script).toMatchObject({
      name: 'Checkout',
      description: 'spaced',
      testScenario: '',
      tags: [],
      language: 'TypeScript',
      scriptType: 'E2E',
    });
  });

  it('records language, type, source, and change summary', async () => {
    const res = await postScript(ctx, asAdmin, projectId, {
      language: 'JavaScript',
      scriptType: 'API',
      source: 'GENERATED',
      changeSummary: 'From the generator',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().script).toMatchObject({ language: 'JavaScript', scriptType: 'API' });
    const version = await ctx.db('test_script_versions').first();
    expect(version).toMatchObject({ source: 'GENERATED', change_summary: 'From the generator' });
  });

  it('accepts only the sources a client may claim', async () => {
    for (const source of ['MANUAL', 'GENERATED', 'RECORDED', 'IMPORTED']) {
      expect((await postScript(ctx, asAdmin, projectId, { name: `From ${source}`, source })).statusCode).toBe(201);
    }
    for (const source of ['RESTORED', 'HEALED', 'NOPE']) {
      expect((await postScript(ctx, asAdmin, projectId, { name: `From ${source}`, source })).statusCode).toBe(400);
    }
  });

  it('stores content with unix line endings whatever the client sent', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { content: 'one\r\ntwo\rthree\n' });
    expect(script.content).toBe('one\ntwo\nthree\n');
    const version = await ctx.db('test_script_versions').first();
    expect(version.script_content).toBe('one\ntwo\nthree\n');
  });

  it('rejects a name already used in the project, ignoring case, and allows it in another project', async () => {
    await newScript(ctx, asAdmin, projectId, { name: 'Login Test' });
    const clash = await postScript(ctx, asAdmin, projectId, { name: '  login test ' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({
      code: 'SCRIPT_NAME_TAKEN',
      message: 'A script named "login test" already exists in this project.',
    });
    expect(await ctx.db('test_scripts')).toHaveLength(1);
    expect(await ctx.db('test_script_versions')).toHaveLength(1);

    const other = await newProject(ctx, asAdmin, 'Other');
    expect((await postScript(ctx, asAdmin, other, { name: 'Login Test' })).statusCode).toBe(201);
  });

  it('accepts every text field at its limit', async () => {
    const res = await postScript(ctx, asAdmin, projectId, {
      name: 'n'.repeat(200),
      description: 'd'.repeat(2000),
      testScenario: 's'.repeat(5000),
      changeSummary: 'c'.repeat(500),
    });
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a 201-character name', { name: 'n'.repeat(201) }],
    ['a 2,001-character description', { description: 'd'.repeat(2001) }],
    ['a 5,001-character test scenario', { testScenario: 's'.repeat(5001) }],
    ['empty content', { content: '' }],
    ['missing content', { content: undefined }],
    ['a 501-character change summary', { changeSummary: 'c'.repeat(501) }],
    ['an unknown language', { language: 'Python' }],
    ['an unknown script type', { scriptType: 'UNIT' }],
    ['a null character in the name', { name: 'Bad\u0000Name' }],
    ['a null character in the description', { description: 'bad\u0000text' }],
    ['a null character in the test scenario', { testScenario: 'bad\u0000text' }],
    ['a null character in the content', { content: 'bad\u0000code' }],
    ['a name that is not a string', { name: 42 }],
  ])('rejects %s', async (_label, payload) => {
    const res = await postScript(ctx, asAdmin, projectId, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await ctx.db('test_scripts')).toHaveLength(0);
  });

  it('accepts 1,000,000 characters even when JSON escaping doubles the request size', async () => {
    // Every quote travels as \" on the wire, so this body is 2,000,000 bytes: above Fastify's
    // 1 MiB default and just under the 2 MB limit these routes raise it to.
    const res = await postScript(ctx, asAdmin, projectId, { content: '"'.repeat(1_000_000) });
    expect(res.statusCode).toBe(201);
    const row = await ctx.db('test_script_versions').first(ctx.db.raw('char_length(script_content) as size'));
    expect(row.size).toBe(1_000_000);
  });

  it('rejects 1,000,001 characters as a validation error', async () => {
    const res = await postScript(ctx, asAdmin, projectId, { content: 'x'.repeat(1_000_001) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0]).toEqual({
      path: 'content',
      message: 'Script content is too long (1,000,000 characters max).',
    });
  });

  it('answers 413 PAYLOAD_TOO_LARGE when the request body exceeds 2 MB', async () => {
    // 700,000 three-byte characters: inside the character limit, but a 2.1 MB body.
    const res = await postScript(ctx, asAdmin, projectId, { content: '語'.repeat(700_000) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' });
    expect(await ctx.db('test_scripts')).toHaveLength(0);
  });

  it('answers 404 for an unknown or deleted project and 409 for an archived one', async () => {
    const unknown = await postScript(ctx, asAdmin, 9999);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Project not found.');
    for (const bad of ['abc', '0', '1.5']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${bad}/scripts`,
        headers: asAdmin,
        payload: { name: 'X', content: SAMPLE },
      });
      expect(res.statusCode).toBe(400);
    }

    await setProject({ status: 'ARCHIVED' });
    const archived = await postScript(ctx, asAdmin, projectId);
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe('PROJECT_NOT_ACTIVE');

    await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect((await postScript(ctx, asAdmin, projectId)).statusCode).toBe(404);
    expect(await ctx.db('test_scripts')).toHaveLength(0);
  });

  it('creates tags on demand, reuses a tag in its first spelling, and drops duplicates', async () => {
    const first = await newScript(ctx, asAdmin, projectId, { name: 'A', tags: ['Smoke', ' checkout-flow ', 'smoke'] });
    expect(first.tags).toEqual(['checkout-flow', 'Smoke']);

    const second = await newScript(ctx, asAdmin, projectId, { name: 'B', tags: ['SMOKE', 'v1.2 @nightly_run'] });
    expect(second.tags).toEqual(['Smoke', 'v1.2 @nightly_run']);

    expect(await ctx.db('tags').orderBy('id').pluck('name')).toEqual(['checkout-flow', 'Smoke', 'v1.2 @nightly_run']);
    expect(await ctx.db('script_tags')).toHaveLength(4);
  });

  it('rejects invalid tags and allows exactly twenty', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    const invalid: unknown[] = [
      ['bad/tag'],
      ['semi;colon'],
      ['x'.repeat(41)],
      [''],
      ['   '],
      [42],
      'not-a-list',
      [...twenty, 'one-too-many'],
    ];
    for (const tags of invalid) {
      const res = await postScript(ctx, asAdmin, projectId, { tags });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }

    // A repeated tag does not count twice: twenty distinct tags plus one repeat is still twenty.
    const ok = await postScript(ctx, asAdmin, projectId, { tags: [...twenty, 'TAG-0'] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().script.tags).toHaveLength(20);
  });

  it('survives the same new tags arriving in several requests at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        postScript(ctx, asAdmin, projectId, {
          name: `Parallel ${i}`,
          tags: i % 2 === 0 ? ['alpha', 'Beta', 'gamma'] : ['GAMMA', 'beta', 'Alpha'],
        }),
      ),
    );
    expect(results.map((res) => res.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);

    const stored: string[] = await ctx.db('tags').pluck('name');
    expect(stored.map((name) => name.toLowerCase()).sort()).toEqual(['alpha', 'beta', 'gamma']);
    for (const res of results) {
      const tags: string[] = res.json().script.tags;
      expect(tags.map((name) => name.toLowerCase())).toEqual(['alpha', 'beta', 'gamma']);
    }
  });

  it('reports the status of the owning project with the script', async () => {
    const created = await newScript(ctx, asAdmin, projectId);
    expect((await get(created.id)).json().script.projectStatus).toBe('ACTIVE');
    expect((await setProject({ status: 'ARCHIVED' })).statusCode).toBe(200);
    expect((await get(created.id)).json().script.projectStatus).toBe('ARCHIVED');
  });

  it('gets a script with its content, tags, and last editor', async () => {
    const created = await newScript(ctx, asAdmin, projectId, { tags: ['smoke'] });
    const res = await get(created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({
      id: created.id,
      name: 'Login Test',
      content: SAMPLE,
      tags: ['smoke'],
      updatedBy: 'Ada Admin',
      version: 1,
    });
  });

  it('answers 404 for an unknown or deleted script and 400 for a malformed id', async () => {
    const unknown = await get(9999);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Script not found.');

    const [gone] = await ctx
      .db('test_scripts')
      .insert({ project_id: projectId, name: 'Gone', script_content: '//', status: 'DELETED' })
      .returning('id');
    expect((await get(gone.id)).statusCode).toBe(404);

    for (const id of ['abc', '0', '1.5', '99999999999999999999']) {
      expect((await get(id)).statusCode).toBe(400);
    }
  });

  it('lets a USER create and a VIEWER only read', async () => {
    const user = await createUser(ctx.db, { role: 'USER', displayName: 'Uma User' });
    const viewer = await createUser(ctx.db, { role: 'VIEWER' });
    const asUser = (await loginExt(ctx.app, user.email, user.password)).headers;
    const asViewer = (await loginExt(ctx.app, viewer.email, viewer.password)).headers;

    const created = await postScript(ctx, asUser, projectId, { name: 'By User' });
    expect(created.statusCode).toBe(201);
    expect(created.json().script.updatedBy).toBe('Uma User');

    const denied = await postScript(ctx, asViewer, projectId, { name: 'By Viewer' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    for (const headers of [asUser, asViewer]) {
      expect((await get(created.json().script.id, headers)).statusCode).toBe(200);
    }
  });

  it('requires a session', async () => {
    const calls = [
      ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scripts`,
        payload: { name: 'X', content: SAMPLE },
      }),
      ctx.app.inject({ method: 'GET', url: '/api/scripts/1' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('enforces CSRF on a cookie-authenticated create', async () => {
    const web = await loginWeb(ctx.app, admin.email, admin.password);
    const url = `/api/projects/${projectId}/scripts`;
    const without = await ctx.app.inject({
      method: 'POST',
      url,
      cookies: web.cookies,
      payload: { name: 'No Token', content: SAMPLE },
    });
    expect(without.statusCode).toBe(403);
    expect(without.json().error.code).toBe('CSRF_INVALID');

    const withToken = await ctx.app.inject({
      method: 'POST',
      url,
      cookies: web.cookies,
      headers: web.headers,
      payload: { name: 'With Token', content: SAMPLE },
    });
    expect(withToken.statusCode).toBe(201);
  });

  it('audits creation without storing the content', async () => {
    const marker = 'UNIQUE-CONTENT-MARKER-91f3';
    const script = await newScript(ctx, asAdmin, projectId, {
      name: 'Audited',
      content: `// ${marker}\n`,
      source: 'RECORDED',
    });

    const rows = await ctx.db('audit_logs').where({ resource: 'script' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'script.create',
      result: 'SUCCESS',
      resource_id: String(script.id),
      user_id: admin.id,
      user_email: admin.email,
    });
    expect(rows[0].details).toEqual({ projectId, name: 'Audited', source: 'RECORDED', version: 1 });
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it('rolls creation back when the audit row cannot be written', async () => {
    await breakAudit(ctx.db);
    const res = await postScript(ctx, asAdmin, projectId, { name: 'Ghost', tags: ['ghost-tag'] });
    expect(res.statusCode).toBe(500);
    for (const table of ['test_scripts', 'test_script_versions', 'script_tags', 'tags']) {
      expect(await ctx.db(table)).toHaveLength(0);
    }

    await repairAudit(ctx.db);
    expect((await postScript(ctx, asAdmin, projectId, { name: 'Ghost' })).statusCode).toBe(201);
  });

  it('counts created scripts in the project overview and the project list', async () => {
    await newScript(ctx, asAdmin, projectId, { name: 'One' });
    await newScript(ctx, asAdmin, projectId, { name: 'Two' });

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect(detail.json().overview).toMatchObject({
      totalScripts: 2,
      passedScripts: 0,
      failedScripts: 0,
      notExecuted: 2,
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/projects', headers: asAdmin });
    expect(list.json().items[0].scriptCount).toBe(2);
  });
});
