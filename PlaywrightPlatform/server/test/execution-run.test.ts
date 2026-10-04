import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/security/tokens';
import { JOB, run, startRun, startWorld, type RunWorld } from './execution-helpers';
import { closeApp } from './helpers';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';
import { newScript, SAMPLE } from './script-helpers';

describe('executions: start and read a run', () => {
  let stub: JenkinsStub;
  let world: RunWorld;

  beforeAll(async () => {
    stub = await startJenkinsStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    world = await startWorld(stub);
  });
  afterEach(() => closeApp(world.ctx));

  const rows = () => world.ctx.db('test_executions').orderBy('id');

  it('starts a run: records it, triggers Jenkins with the three parameters, and answers QUEUED', async () => {
    const res = await run(world);
    expect(res.statusCode).toBe(201);
    expect(res.json().execution).toMatchObject({
      id: 1,
      projectId: world.projectId,
      scriptId: world.scriptId,
      scriptName: 'Login Test',
      scriptVersion: 1,
      status: 'QUEUED',
      stage: 'QUEUED',
      buildNumber: null,
      buildUrl: null,
      reportUrl: null,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errorMessage: null,
      triggeredBy: 'Uma User',
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });

    const token = stub.lastParams.RUN_TOKEN;
    expect(stub.lastParams.EXECUTION_ID).toBe('1');
    expect(stub.lastParams.PLATFORM_URL).toBe(world.ctx.config.publicUrl);
    // The image the tests run in is the server's setting, sent with every run.
    expect(stub.lastParams.PLAYWRIGHT_IMAGE).toBe('mcr.microsoft.com/playwright:v1.63.0-noble');
    expect(stub.lastParams.PLAYWRIGHT_IMAGE).toBe(world.ctx.config.playwrightDockerImage);
    // What the reports call the run, and what the test file is named in the build.
    expect(stub.lastParams.RUN_LABEL).toBe('Run #1 - Login Test - v1');
    expect(stub.lastParams.SPEC_NAME).toBe('login-test');
    // Started without a choice: a screenshot of every test, and video for failed tests only.
    expect(stub.lastParams).toMatchObject({ SCREENSHOTS: 'on', VIDEO: 'off' });
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = await rows();
    expect(row.trigger_type).toBe('MANUAL');
    expect(row.callback_token_hash).toBe(hashToken(token));
    expect(stub.queue.has(row.jenkins_queue_id)).toBe(true);
    const job = await world.ctx.db('project_ci_jobs').first();
    expect(job).toMatchObject({ id: row.jenkins_job_id, project_id: world.projectId, job_name: JOB });

    // The token goes to the build and nowhere else.
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain(row.callback_token_hash);
    const audit = await world.ctx.db('audit_logs').where({ action: 'execution.run' }).first();
    expect(audit.resource_id).toBe('1');
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('passes on what the person chose to record for every test', async () => {
    const start = (payload: object) =>
      world.ctx.app.inject({ method: 'POST', url: `/api/scripts/${world.scriptId}/run`, headers: world.asUser, payload });
    const finishLast = async () => {
      await world.ctx.db('test_executions').update({ status: 'ABORTED', stage: 'COMPLETED' });
    };

    expect((await start({ screenshots: false, video: true })).statusCode).toBe(201);
    expect(stub.lastParams).toMatchObject({ SCREENSHOTS: 'off', VIDEO: 'on' });
    await finishLast();

    expect((await start({ screenshots: true, video: true, anything: 'else' })).statusCode).toBe(201);
    expect(stub.lastParams).toMatchObject({ SCREENSHOTS: 'on', VIDEO: 'on' });
    await finishLast();

    // Only true and false are a choice.
    const bad = await start({ video: 'on; rm -rf /' });
    expect(bad.statusCode).toBe(400);
  });

  it('records the version that was current when Run was pressed', async () => {
    const saved = await world.ctx.app.inject({
      method: 'PUT',
      url: `/api/scripts/${world.scriptId}`,
      headers: world.asUser,
      payload: { content: `${SAMPLE}\n// second version\n`, baseVersion: 1 },
    });
    expect(saved.statusCode).toBe(200);
    expect((await run(world)).json().execution.scriptVersion).toBe(2);
  });

  it('refuses a VIEWER, a missing session, and an unknown script', async () => {
    expect((await run(world, world.asViewer)).statusCode).toBe(403);
    expect((await run(world, {})).statusCode).toBe(401);
    expect((await run(world, world.asUser, 999)).statusCode).toBe(404);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a run in an archived project', async () => {
    const archived = await world.ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${world.projectId}`,
      headers: world.asAdmin,
      payload: { status: 'ARCHIVED' },
    });
    expect(archived.statusCode).toBe(200);
    const res = await run(world);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROJECT_NOT_ACTIVE');
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a run before Jenkins is set up', async () => {
    await world.ctx.db('jenkins_configurations').del();
    const res = await run(world);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('JENKINS_NOT_CONFIGURED');
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a second run of a script while one is unfinished', async () => {
    const first = await startRun(world, stub);
    const second = await run(world, world.asAdmin);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: 'RUN_IN_PROGRESS', details: { executionId: first.id } });

    // Another script in the same project is free to run, and reuses the project's link to the job.
    const other = await newScript(world.ctx, world.asAdmin, world.projectId, { name: 'Other Test' });
    expect((await run(world, world.asUser, other.id)).statusCode).toBe(201);
    expect(await world.ctx.db('project_ci_jobs').count('* as n').first()).toEqual({ n: 1 });
  });

  it('two simultaneous runs: one starts, the other is told a run is in progress', async () => {
    const results = await Promise.all([run(world, world.asUser), run(world, world.asAdmin)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect(await rows()).toHaveLength(1);
    expect(stub.requests.filter((req) => req.path.endsWith('/buildWithParameters'))).toHaveLength(1);
  });

  it('Jenkins down: the run is kept as ERROR and the answer is 502', async () => {
    stub.failWith = 503;
    const res = await run(world);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('JENKINS_UNREACHABLE');

    const [row] = await rows();
    expect(row).toMatchObject({ status: 'ERROR', stage: 'COMPLETED', callback_token_hash: null });
    expect(row.error_message).toContain('Jenkins answered with status 503.');
    expect(row.completed_at).toBeInstanceOf(Date);

    // A start that failed does not block the next try.
    stub.failWith = null;
    expect((await run(world)).statusCode).toBe(201);
  });

  it('Jenkins without the job, or refusing the token: ERROR run and 502 with what to do', async () => {
    stub.jobs.clear();
    const missing = await run(world);
    expect(missing.statusCode).toBe(502);
    expect(missing.json().error).toMatchObject({
      code: 'JENKINS_REJECTED',
      message: 'Jenkins does not have the job. Press Create Job under Settings → Jenkins.',
    });

    stub.jobs.add(JOB);
    stub.failWith = 403;
    const refused = await run(world);
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toMatchObject({
      code: 'JENKINS_REJECTED',
      message: 'Jenkins refused the username or API token. Check Settings → Jenkins.',
    });
    expect((await rows()).map((row: { status: string }) => row.status)).toEqual(['ERROR', 'ERROR']);
  });

  it('reads a run: any signed-in role, 404 for an unknown id, 401 without a session', async () => {
    const { id } = await startRun(world, stub);
    const get = (headers: Record<string, string>, target = id) =>
      world.ctx.app.inject({ method: 'GET', url: `/api/executions/${target}`, headers });

    const seen = await get(world.asViewer);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().execution).toMatchObject({ id, status: 'QUEUED', triggeredBy: 'Uma User' });
    expect((await get(world.asUser, 999)).statusCode).toBe(404);
    expect((await get({})).statusCode).toBe(401);
  });

  it("lists a script's runs newest first, limited, without asking Jenkins", async () => {
    const finishAll = () => world.ctx.db('test_executions').update({ status: 'PASSED', stage: 'COMPLETED' });
    await startRun(world, stub);
    await finishAll();
    await startRun(world, stub);
    await finishAll();
    await startRun(world, stub);
    const asked = stub.requests.length;

    const list = (query = '', headers: Record<string, string> = world.asViewer, scriptId = world.scriptId) =>
      world.ctx.app.inject({ method: 'GET', url: `/api/scripts/${scriptId}/executions${query}`, headers });

    const all = await list();
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((item: { id: number }) => item.id)).toEqual([3, 2, 1]);
    expect(all.json().items[0]).toMatchObject({ status: 'QUEUED', scriptName: 'Login Test' });
    expect((await list('?limit=2')).json().items).toHaveLength(2);
    expect((await list('?limit=0')).statusCode).toBe(400);
    expect((await list('?limit=51')).statusCode).toBe(400);
    expect((await list('', world.asViewer, 999)).statusCode).toBe(404);
    expect((await list('', {})).statusCode).toBe(401);
    expect(stub.requests.length).toBe(asked);
  });
});
