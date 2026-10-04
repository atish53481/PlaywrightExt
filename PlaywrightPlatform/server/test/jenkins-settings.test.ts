import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';

describe('jenkins settings', () => {
  let ctx: TestContext;
  let stub: JenkinsStub;
  let asAdmin: Record<string, string>;
  let asUser: Record<string, string>;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
    stub = await startJenkinsStub();
  });
  afterAll(async () => {
    await stub.close();
    await closeApp(ctx);
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    stub.reset();
    const admin = await createUser(ctx.db, { role: 'ADMIN' });
    const user = await createUser(ctx.db, { role: 'USER' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    asUser = (await loginExt(ctx.app, user.email, user.password)).headers;
  });

  const call = (method: 'GET' | 'PUT' | 'POST', url: string, headers: Record<string, string>, payload?: object) =>
    ctx.app.inject({ method, url: `/api/jenkins/${url}`, headers, payload });
  const save = (payload: object, headers = asAdmin) => call('PUT', 'settings', headers, payload);
  const good = () => ({ baseUrl: `${stub.url}/`, username: stub.username, token: stub.token });

  it('reports not configured before anything is saved', async () => {
    const res = await call('GET', 'settings', asAdmin);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      configured: false,
      baseUrl: '',
      username: '',
      jobName: 'playwright-platform-run',
      hasToken: false,
    });
  });

  it('saves settings, encrypts the token, and never returns it', async () => {
    const res = await save(good());
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      configured: true,
      baseUrl: stub.url,
      username: 'ci-user',
      jobName: 'playwright-platform-run',
      hasToken: true,
    });
    expect(res.body).not.toContain('ci-token');

    const row = await ctx.db('jenkins_configurations').first();
    expect(row.name).toBe('default');
    expect(row.secret_ciphertext).toMatch(/^v1:/);
    expect(row.secret_ciphertext).not.toContain('ci-token');

    const audit = await ctx.db('audit_logs').where({ action: 'jenkins.settings.update' }).first();
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain('ci-token');
  });

  it('keeps the stored token when a later save omits it, and requires it on the first save', async () => {
    const first = await save({ baseUrl: stub.url, username: 'ci-user' });
    expect(first.statusCode).toBe(400);
    expect(first.json().error.message).toBe('Enter the Jenkins API token.');

    await save(good());
    const before = (await ctx.db('jenkins_configurations').first()).secret_ciphertext;
    const second = await save({ baseUrl: stub.url, username: 'ci-user', jobName: 'other-job' });
    expect(second.statusCode).toBe(200);
    expect(second.json().settings.jobName).toBe('other-job');
    expect((await ctx.db('jenkins_configurations').first()).secret_ciphertext).toBe(before);
    expect(await ctx.db('jenkins_configurations').count('* as n').first()).toEqual({ n: 1 });
  });

  it('validates each field', async () => {
    const longUrl = 'http://x/' + 'a'.repeat(300);
    const bad = [
      { ...good(), baseUrl: 'localhost:7070' },
      { ...good(), baseUrl: longUrl },
      { ...good(), username: '' },
      { ...good(), username: 'u'.repeat(101) },
      { ...good(), token: 't'.repeat(201) },
      { ...good(), jobName: 'has space' },
      { ...good(), jobName: 'a/b' },
    ];
    for (const payload of bad) expect((await save(payload)).statusCode).toBe(400);
  });

  it('lets only an ADMIN change settings, and hides the address from other roles', async () => {
    expect((await save(good(), asUser)).statusCode).toBe(403);
    expect((await call('POST', 'test', asUser, {})).statusCode).toBe(403);
    expect((await call('POST', 'job', asUser)).statusCode).toBe(403);
    expect((await call('GET', 'settings', {})).statusCode).toBe(401);

    await save(good());
    const seen = (await call('GET', 'settings', asUser)).json().settings;
    expect(seen).toEqual({ configured: true, baseUrl: '', username: '', jobName: 'playwright-platform-run', hasToken: true });
  });

  it('tests a connection with values that are not saved yet', async () => {
    const res = await call('POST', 'test', asAdmin, good());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      version: '2.555.2',
      pipelinePlugin: true,
      message: 'Connected to Jenkins 2.555.2.',
    });
    expect(await ctx.db('jenkins_configurations').first()).toBeUndefined();
  });

  it('tests the saved connection when the body is empty, and needs one to be saved', async () => {
    const none = await call('POST', 'test', asAdmin, {});
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('JENKINS_NOT_CONFIGURED');
    await save(good());
    expect((await call('POST', 'test', asAdmin, {})).json().ok).toBe(true);
  });

  it('explains a failed connection test without failing the request', async () => {
    const wrong = await call('POST', 'test', asAdmin, { ...good(), token: 'nope' });
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json()).toMatchObject({ ok: false, version: null, message: 'Jenkins refused the username or API token.' });

    stub.failWith = 503;
    expect((await call('POST', 'test', asAdmin, good())).json()).toMatchObject({ ok: false, message: 'Jenkins answered with status 503.' });
    stub.failWith = null;

    stub.plugins = [];
    const noPlugin = (await call('POST', 'test', asAdmin, good())).json();
    expect(noPlugin).toMatchObject({ ok: true, pipelinePlugin: false });
    expect(noPlugin.message).toContain('Pipeline plugin is not installed');

    // A Jenkins user who may run builds but not view plugins is still connected.
    stub.plugins = ['workflow-aggregator'];
    stub.forbidPluginList = true;
    const hidden = (await call('POST', 'test', asAdmin, good())).json();
    expect(hidden).toMatchObject({ ok: true, version: '2.555.2', pipelinePlugin: false });
    expect(hidden.message).toContain('may not list plugins');
  });

  it('creates the job, then updates it, and records both', async () => {
    const none = await call('POST', 'job', asAdmin);
    expect(none.statusCode).toBe(409);

    await save(good());
    const created = await call('POST', 'job', asAdmin);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ created: true, jobUrl: `${stub.url}/job/playwright-platform-run/` });
    expect(stub.configs.get('playwright-platform-run')).toContain('<flow-definition');
    // The job is made for the configured Playwright image.
    expect(stub.configs.get('playwright-platform-run')).toContain('<name>PLAYWRIGHT_IMAGE</name>');
    expect(stub.configs.get('playwright-platform-run')).toContain(`<defaultValue>${ctx.config.playwrightDockerImage}</defaultValue>`);

    expect((await call('POST', 'job', asAdmin)).json().created).toBe(false);
    expect(await ctx.db('audit_logs').where({ action: 'jenkins.job.create' }).count('* as n').first()).toEqual({ n: 2 });
  });

  it('answers 502 when Jenkins fails during job creation', async () => {
    await save(good());
    stub.failWith = 503;
    const down = await call('POST', 'job', asAdmin);
    expect(down.statusCode).toBe(502);
    expect(down.json().error.code).toBe('JENKINS_UNREACHABLE');
    stub.failWith = 403;
    const refused = await call('POST', 'job', asAdmin);
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error.code).toBe('JENKINS_REJECTED');
    expect(refused.json().error.message).toBe('Jenkins refused the username or API token. Check Settings → Jenkins.');
  });
});
