import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';
import { newProject, newScript } from './script-helpers';

type Headers = Record<string, string>;

const CONTENT = '# Login Automation Skill\n\n## Rules\n\n- Use TypeScript.\n- Prefer getByRole().\n';

describe('skills', () => {
  let ctx: TestContext;
  let asAdmin: Headers;
  let asUser: Headers;
  let asViewer: Headers;
  let projectId: number;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    const admin = await createUser(ctx.db, { role: 'ADMIN' });
    const user = await createUser(ctx.db, { role: 'USER' });
    const viewer = await createUser(ctx.db, { role: 'VIEWER' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    asUser = (await loginExt(ctx.app, user.email, user.password)).headers;
    asViewer = (await loginExt(ctx.app, viewer.email, viewer.password)).headers;
    projectId = await newProject(ctx, asAdmin);
  });

  const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, headers: Headers, payload?: object) =>
    ctx.app.inject({ method, url: `/api${url}`, headers, payload });
  const addProjectSkill = async (payload: object = {}, headers: Headers = asUser, project = projectId) => {
    const res = await call('POST', `/projects/${project}/skills`, headers, { name: 'Login rules', content: CONTENT, ...payload });
    if (res.statusCode !== 201) throw new Error(`skill create failed: ${res.statusCode} ${res.body}`);
    return res.json().skill;
  };
  const addGlobalSkill = async (payload: object = {}) => {
    const res = await call('POST', '/skills', asAdmin, { name: 'Playwright standards', content: CONTENT, ...payload });
    if (res.statusCode !== 201) throw new Error(`skill create failed: ${res.statusCode} ${res.body}`);
    return res.json().skill;
  };
  const list = async (project = projectId, headers: Headers = asViewer) =>
    (await call('GET', `/projects/${project}/skills`, headers)).json().items;

  it('creates a project skill with its first version, and lists it attached and enabled', async () => {
    const skill = await addProjectSkill({ description: 'How we test login', fileName: 'login-automation.skill.md' });
    expect(skill).toMatchObject({
      name: 'Login rules',
      description: 'How we test login',
      scope: 'PROJECT',
      projectId,
      fileName: 'login-automation.skill.md',
      version: 1,
      status: 'ACTIVE',
      content: CONTENT,
    });
    expect(await ctx.db('skill_versions').where({ skill_id: skill.id }).pluck('version')).toEqual([1]);

    expect(await list()).toEqual([
      expect.objectContaining({ id: skill.id, name: 'Login rules', scope: 'PROJECT', version: 1, attached: true, enabled: true, priority: 100 }),
    ]);
    expect((await list())[0].content).toBeUndefined();
    expect((await call('GET', `/skills/${skill.id}`, asViewer)).json().skill.content).toBe(CONTENT);
    const audit = await ctx.db('audit_logs').where({ action: 'skill.create' }).first();
    expect(audit.resource_id).toBe(String(skill.id));
  });

  it('keeps writing for ADMIN and USER, global skills for ADMIN, and reading for anyone signed in', async () => {
    const body = { name: 'X', content: CONTENT };
    expect((await call('POST', `/projects/${projectId}/skills`, asViewer, body)).statusCode).toBe(403);
    expect((await call('POST', '/skills', asUser, body)).statusCode).toBe(403);
    expect((await call('GET', `/projects/${projectId}/skills`, {})).statusCode).toBe(401);

    const global = await addGlobalSkill();
    expect((await call('PUT', `/skills/${global.id}`, asUser, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await call('DELETE', `/skills/${global.id}`, asUser)).statusCode).toBe(403);
    expect((await call('PUT', `/skills/${global.id}`, asAdmin, { name: 'Standards' })).statusCode).toBe(200);
  });

  it('attaches a global skill to a project, switches it off, orders it, and detaches it', async () => {
    const global = await addGlobalSkill();
    expect(await list()).toEqual([expect.objectContaining({ id: global.id, scope: 'GLOBAL', attached: false, enabled: false })]);

    const link = (payload: object, headers: Headers = asUser) =>
      call('PUT', `/projects/${projectId}/skills/${global.id}`, headers, payload);
    expect((await link({ attached: true }, asViewer)).statusCode).toBe(403);
    expect((await link({ attached: true })).json().skill).toMatchObject({ attached: true, enabled: true, priority: 100 });
    expect((await link({ enabled: false, priority: 5 })).json().skill).toMatchObject({ attached: true, enabled: false, priority: 5 });
    // The skill itself is one row however many projects use it.
    const other = await newProject(ctx, asAdmin, 'Bank');
    await call('PUT', `/projects/${other}/skills/${global.id}`, asUser, { attached: true });
    expect(await ctx.db('skills').count('* as n').first()).toEqual({ n: 1 });

    expect((await link({ attached: false })).json().skill).toMatchObject({ attached: false, enabled: false });
    expect(await ctx.db('project_skills').where({ project_id: projectId })).toHaveLength(0);

    // A project's own skill can be switched off but not detached, and belongs to that project only.
    const own = await addProjectSkill();
    const ownLink = (payload: object, project = projectId) => call('PUT', `/projects/${project}/skills/${own.id}`, asUser, payload);
    expect((await ownLink({ enabled: false })).json().skill).toMatchObject({ attached: true, enabled: false });
    expect((await ownLink({ attached: false })).statusCode).toBe(400);
    expect((await ownLink({ attached: true }, other)).statusCode).toBe(404);
  });

  it('makes a new version when the content changes, lists versions, and restores one', async () => {
    const skill = await addProjectSkill();
    const put = (payload: object) => call('PUT', `/skills/${skill.id}`, asUser, payload);

    const renamed = (await put({ name: 'Login standards' })).json().skill;
    expect(renamed).toMatchObject({ name: 'Login standards', version: 1 });
    expect((await put({ content: CONTENT })).json().skill.version).toBe(1);

    const edited = (await put({ content: `${CONTENT}- Capture a trace on failure.\r\n`, changeSummary: 'Added tracing' })).json().skill;
    expect(edited.version).toBe(2);
    expect(edited.content.endsWith('- Capture a trace on failure.\n')).toBe(true);

    const versions = (await call('GET', `/skills/${skill.id}/versions`, asViewer)).json().items;
    expect(versions.map((v: { version: number; changeSummary: string }) => [v.version, v.changeSummary])).toEqual([
      [2, 'Added tracing'],
      [1, ''],
    ]);
    expect((await call('GET', `/skills/${skill.id}/versions/1`, asViewer)).json().version.content).toBe(CONTENT);

    const restored = await call('POST', `/skills/${skill.id}/versions/1/restore`, asUser);
    expect(restored.statusCode).toBe(200);
    expect(restored.json().skill).toMatchObject({ version: 3, content: CONTENT });
    expect((await call('POST', `/skills/${skill.id}/versions/9/restore`, asUser)).statusCode).toBe(404);
  });

  it('validates what is stored', async () => {
    const post = (payload: object) => call('POST', `/projects/${projectId}/skills`, asUser, payload);
    expect((await post({ name: '  ', content: CONTENT })).statusCode).toBe(400);
    expect((await post({ name: 'A', content: '' })).statusCode).toBe(400);
    expect((await post({ name: 'A', content: 'x'.repeat(200_001) })).statusCode).toBe(400);
    expect((await post({ name: 'A', content: 'bad\u0000byte' })).statusCode).toBe(400);
    for (const fileName of ['../secrets.skill.md', 'a/b.skill.md', 'c:\\x.md', 'notes.txt', '.md']) {
      expect((await post({ name: 'A', content: CONTENT, fileName })).statusCode).toBe(400);
    }

    await addProjectSkill();
    const clash = await post({ name: 'login RULES', content: CONTENT });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.code).toBe('SKILL_NAME_TAKEN');
    // The same name is free in another project.
    const other = await newProject(ctx, asAdmin, 'Bank');
    await addProjectSkill({}, asUser, other);

    expect((await call('GET', '/skills/999999', asViewer)).statusCode).toBe(404);
    expect((await call('GET', '/projects/999999/skills', asViewer)).statusCode).toBe(404);

    await call('PUT', `/projects/${projectId}`, asAdmin, { status: 'ARCHIVED' });
    const archived = await post({ name: 'B', content: CONTENT });
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe('PROJECT_NOT_ACTIVE');
  });

  it('takes only plain whole numbers as ids in an address', async () => {
    const skill = await addProjectSkill();
    for (const odd of ['1e0', '0x1', '1.0', '+1', ' 1', '01']) {
      expect((await call('GET', `/skills/${encodeURIComponent(odd)}`, asViewer)).statusCode, odd).toBe(400);
      expect((await call('GET', `/projects/${encodeURIComponent(odd)}/skills`, asViewer)).statusCode, odd).toBe(400);
      expect((await call('GET', `/projects/${encodeURIComponent(odd)}`, asViewer)).statusCode, odd).toBe(400);
    }
    expect((await call('GET', `/skills/${skill.id}`, asViewer)).statusCode).toBe(200);
  });

  it('archives a skill: gone from lists and from the agent context, kept in the database', async () => {
    const skill = await addProjectSkill();
    expect((await call('DELETE', `/skills/${skill.id}`, asViewer)).statusCode).toBe(403);
    expect((await call('DELETE', `/skills/${skill.id}`, asUser)).statusCode).toBe(204);
    expect(await list()).toEqual([]);
    expect((await call('GET', `/projects/${projectId}/skills/context`, asViewer)).json().skills).toEqual([]);
    expect((await ctx.db('skills').where({ id: skill.id }).first()).status).toBe('ARCHIVED');
    // The name is free again.
    await addProjectSkill();
  });

  it('builds the agent context: enabled skills only, in priority order, project before global', async () => {
    const b = await addProjectSkill({ name: 'B rules', content: 'b' });
    const a = await addProjectSkill({ name: 'A rules', content: 'a' });
    const off = await addProjectSkill({ name: 'Off', content: 'off' });
    const g = await addGlobalSkill({ name: 'Global rules', content: 'g' });
    const unattached = await addGlobalSkill({ name: 'Unattached', content: 'u' });
    const link = (id: number, payload: object) => call('PUT', `/projects/${projectId}/skills/${id}`, asUser, payload);
    await link(off.id, { enabled: false });
    await link(g.id, { attached: true });
    await link(b.id, { priority: 1 });

    const res = await call('GET', `/projects/${projectId}/skills/context`, asViewer);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      project: 'Shop',
      skills: [
        { id: b.id, name: 'B rules', version: 1, content: 'b' },
        { id: a.id, name: 'A rules', version: 1, content: 'a' },
        { id: g.id, name: 'Global rules', version: 1, content: 'g' },
      ],
    });
    expect(unattached.id).toBeGreaterThan(0);
  });

  it('tags skills and finds them by name, description, or tag', async () => {
    const login = await addProjectSkill({ name: 'Login rules', description: 'Sign-in standards', tags: ['Smoke', 'auth', 'smoke'] });
    expect(login.tags).toEqual(['auth', 'Smoke']);
    await addProjectSkill({ name: 'Cart rules', description: 'Checkout', tags: ['regression'] });

    const find = async (search: string) =>
      (await call('GET', `/projects/${projectId}/skills?search=${encodeURIComponent(search)}`, asViewer)).json().items.map((s: { name: string }) => s.name);
    expect(await find('login')).toEqual(['Login rules']);
    expect(await find('checkout')).toEqual(['Cart rules']);
    expect(await find('SMOKE')).toEqual(['Login rules']);
    expect(await find('100%')).toEqual([]);
    expect((await list())[0].tags).toBeDefined();

    const retagged = (await call('PUT', `/skills/${login.id}`, asUser, { tags: ['security'] })).json().skill;
    expect(retagged).toMatchObject({ tags: ['security'], version: 1 });
    expect((await call('PUT', `/skills/${login.id}`, asUser, { tags: ['bad/tag'] })).statusCode).toBe(400);
  });

  it('stores a healed version of a script with the skills the Healer was given', async () => {
    const skill = await addProjectSkill();
    const script = await newScript(ctx, asUser, projectId, { skills: [{ id: skill.id, version: 1 }] });
    await call('PUT', `/skills/${skill.id}`, asUser, { content: `${CONTENT}more\n` });

    const healed = await call('PUT', `/scripts/${script.id}`, asUser, {
      content: `${script.content}// healed\n`,
      baseVersion: 1,
      changeSummary: 'Healed after Jenkins run #7',
      healed: true,
      skills: [{ id: skill.id, version: 2 }],
    });
    expect(healed.statusCode).toBe(200);
    expect(healed.json().script.version).toBe(2);
    const versions = await ctx.db('test_script_versions').where({ script_id: script.id }).orderBy('version');
    expect(versions.map((v: { source: string }) => v.source)).toEqual(['MANUAL', 'HEALED']);
    expect(await ctx.db('script_skills').where({ script_id: script.id }).orderBy('script_version')).toEqual([
      { script_id: script.id, script_version: 1, skill_id: skill.id, skill_version: 1 },
      { script_id: script.id, script_version: 2, skill_id: skill.id, skill_version: 2 },
    ]);
    expect((await call('GET', `/scripts/${script.id}/skills`, asViewer)).json().items).toEqual([
      { id: skill.id, name: 'Login rules', version: 2 },
    ]);
    // An ordinary edit is still MANUAL.
    await call('PUT', `/scripts/${script.id}`, asUser, { content: `${script.content}// again\n`, baseVersion: 2 });
    expect((await ctx.db('test_script_versions').where({ script_id: script.id, version: 3 }).first()).source).toBe('MANUAL');
  });

  it('records the skill versions a script was made with', async () => {
    const skill = await addProjectSkill();
    await call('PUT', `/skills/${skill.id}`, asUser, { content: `${CONTENT}more\n` });
    const script = await newScript(ctx, asUser, projectId, {
      // A version that does not exist is dropped rather than refused: the script must still save.
      skills: [{ id: skill.id, version: 2 }, { id: skill.id, version: 2 }, { id: 424242, version: 1 }],
    });
    expect(await ctx.db('script_skills').where({ script_id: script.id })).toEqual([
      { script_id: script.id, script_version: 1, skill_id: skill.id, skill_version: 2 },
    ]);
    const res = await call('GET', `/scripts/${script.id}/skills`, asViewer);
    expect(res.json().items).toEqual([{ id: skill.id, name: 'Login rules', version: 2 }]);
  });
});
