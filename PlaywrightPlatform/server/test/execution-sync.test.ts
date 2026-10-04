import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB, poll, run, setBuild, STARTED, startRun, startWorld, type RunWorld } from './execution-helpers';
import { closeApp } from './helpers';
import { startJenkinsStub, type JenkinsStub, type StubBuild } from './jenkins-stub';
import { SAMPLE } from './script-helpers';

/** A build that ended after 65 seconds. Add the result. */
const ENDED = { building: false, duration: 65_000 };

describe('executions: sync with Jenkins', () => {
  let stub: JenkinsStub;
  let world: RunWorld;
  let nextBuild: number;

  beforeAll(async () => {
    stub = await startJenkinsStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    world = await startWorld(stub);
    nextBuild = 41;
  });
  afterEach(() => closeApp(world.ctx));

  const row = (id: number) => world.ctx.db('test_executions').where({ id }).first();
  const scriptState = async (): Promise<string> =>
    (await world.ctx.db('test_scripts').where({ id: world.scriptId }).first()).lifecycle_state;
  const build = (number: number): StubBuild => {
    const found = stub.builds.get(`${JOB}/${number}`);
    if (!found) throw new Error(`the stub has no build ${number}`);
    return found;
  };

  /** Starts a run, lets Jenkins end its build with `result`, and returns the run as read back. */
  const endWith = async (result: StubBuild['result'], prepare?: (id: number) => Promise<unknown>) => {
    const started = await startRun(world, stub);
    if (prepare) await prepare(started.id);
    setBuild(stub, started.queueId, nextBuild++, { ...ENDED, result });
    const res = await poll(world, started.id);
    expect(res.statusCode).toBe(200);
    return res.json().execution;
  };

  it('stays QUEUED while Jenkins has not started the build', async () => {
    const { id } = await startRun(world, stub);
    expect((await poll(world, id)).json().execution).toMatchObject({
      status: 'QUEUED',
      stage: 'QUEUED',
      buildNumber: null,
      buildUrl: null,
    });
  });

  it('a cancelled queue item ends the run as ABORTED', async () => {
    const { id, queueId } = await startRun(world, stub);
    stub.queue.get(queueId)!.cancelled = true;
    const execution = (await poll(world, id)).json().execution;
    expect(execution).toMatchObject({ status: 'ABORTED', stage: 'COMPLETED', buildNumber: null });
    expect(execution.completedAt).not.toBeNull();
    expect((await row(id)).callback_token_hash).toBeNull();
    expect(await scriptState()).toBe('SAVED');
  });

  it('a running build is RUNNING, with its number, links, and start time', async () => {
    const { id, queueId } = await startRun(world, stub);
    setBuild(stub, queueId, 41);
    const execution = (await poll(world, id)).json().execution;
    expect(execution).toMatchObject({
      status: 'RUNNING',
      stage: 'RUNNING',
      buildNumber: 41,
      buildUrl: `${stub.url}/job/${JOB}/41/`,
      reportUrl: `${stub.url}/job/${JOB}/41/artifact/playwright-report/index.html`,
      startedAt: new Date(STARTED).toISOString(),
      completedAt: null,
      durationMs: null,
    });
    expect((await row(id)).report_url).toBe(execution.reportUrl);
  });

  it('SUCCESS is PASSED, with duration and completion time, and marks the script', async () => {
    const execution = await endWith('SUCCESS');
    expect(execution).toMatchObject({
      status: 'PASSED',
      stage: 'COMPLETED',
      buildNumber: 41,
      errorMessage: null,
      startedAt: new Date(STARTED).toISOString(),
      completedAt: new Date(STARTED + 65_000).toISOString(),
      durationMs: 65_000,
    });
    expect((await row(execution.id)).callback_token_hash).toBeNull();
    expect(await scriptState()).toBe('PASSED');

    // The web app's project overview counts scripts by that state.
    const project = await world.ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${world.projectId}`,
      headers: world.asViewer,
    });
    expect(project.json().overview).toMatchObject({ passedScripts: 1, notExecuted: 0 });
  });

  it('answers with the stored run when the saved Jenkins token can no longer be read', async () => {
    const { id } = await startRun(world, stub);
    // As after SECRETS_ENCRYPTION_KEY was changed.
    await world.ctx.db('jenkins_configurations').update({ secret_ciphertext: 'not-a-ciphertext' });
    const res = await poll(world, id);
    expect(res.statusCode).toBe(200);
    expect(res.json().execution.status).toBe('QUEUED');
  });

  it('UNSTABLE is FAILED when the build reported tests, and marks the script', async () => {
    const reported = (id: number) =>
      world.ctx.db('test_executions').where({ id }).update({ total_tests: 2, passed_tests: 1, failed_tests: 1 });
    expect((await endWith('UNSTABLE', reported)).status).toBe('FAILED');
    expect(await scriptState()).toBe('FAILED');
  });

  it('UNSTABLE with no tests reported is ERROR, with the reason the build gave when there is one', async () => {
    expect(await endWith('UNSTABLE')).toMatchObject({
      status: 'ERROR',
      errorMessage: 'No tests ran: the script could not be loaded, or has no tests. Open the Jenkins build for the log.',
    });
    // An ERROR says nothing about the script.
    expect(await scriptState()).toBe('SAVED');

    // A script that does not compile: Playwright reports the reason, and no tests.
    const explained = (id: number) =>
      world.ctx.db('test_executions').where({ id }).update({ error_message: 'SyntaxError: Unexpected token' });
    expect(await endWith('UNSTABLE', explained)).toMatchObject({
      status: 'ERROR',
      errorMessage: 'SyntaxError: Unexpected token',
    });
  });

  it('FAILURE is FAILED when the build reported tests, and ERROR when it did not', async () => {
    const reported = (id: number) =>
      world.ctx.db('test_executions').where({ id }).update({ total_tests: 3, passed_tests: 2, failed_tests: 1 });
    expect(await endWith('FAILURE', reported)).toMatchObject({
      status: 'FAILED',
      total: 3,
      passed: 2,
      failed: 1,
      errorMessage: null,
    });
    expect(await scriptState()).toBe('FAILED');

    expect(await endWith('FAILURE')).toMatchObject({
      status: 'ERROR',
      stage: 'COMPLETED',
      errorMessage: 'The build failed before the tests ran. Open the Jenkins build for the log.',
    });
    // An ERROR says nothing about the script, so the state stays as the last real result left it.
    expect(await scriptState()).toBe('FAILED');
  });

  it('an aborted build is ABORTED, a build that never ran is ERROR, and neither marks the script', async () => {
    expect((await endWith('ABORTED')).status).toBe('ABORTED');
    expect(await endWith('NOT_BUILT')).toMatchObject({
      status: 'ERROR',
      errorMessage: 'The build ended without running the tests. Open the Jenkins build for the log.',
    });
    expect(await scriptState()).toBe('SAVED');
  });

  it('a queue item or a build that Jenkins no longer has ends the run as ERROR', async () => {
    const queued = await startRun(world, stub);
    stub.queue.clear();
    expect((await poll(world, queued.id)).json().execution).toMatchObject({
      status: 'ERROR',
      stage: 'COMPLETED',
      errorMessage: 'Jenkins no longer has this run. Open the job in Jenkins to see what happened.',
    });

    const running = await startRun(world, stub);
    setBuild(stub, running.queueId, 41);
    expect((await poll(world, running.id)).json().execution.status).toBe('RUNNING');
    stub.builds.clear();
    expect((await poll(world, running.id)).json().execution).toMatchObject({ status: 'ERROR', buildNumber: 41 });
  });

  it('a run still queued after 10 minutes ends as ERROR and leaves the Jenkins queue', async () => {
    const { id, queueId } = await startRun(world, stub);
    world.clock.t += 9 * 60_000;
    expect((await poll(world, id)).json().execution.status).toBe('QUEUED');
    world.clock.t += 60_000;
    expect((await poll(world, id)).json().execution).toMatchObject({
      status: 'ERROR',
      stage: 'COMPLETED',
      errorMessage: 'Jenkins did not start the build. Check that an agent is online.',
    });
    expect(stub.queue.get(queueId)!.cancelled).toBe(true);
  });

  it('asks Jenkins at most once every 2 seconds for a run', async () => {
    const { id } = await startRun(world, stub);
    const get = () => world.ctx.app.inject({ method: 'GET', url: `/api/executions/${id}`, headers: world.asUser });
    await get();
    const afterFirst = stub.requests.length;
    await get();
    await get();
    expect(stub.requests.length).toBe(afterFirst);
    world.clock.t += 2_000;
    await get();
    expect(stub.requests.length).toBe(afterFirst + 1);
  });

  it('a Jenkins error during sync changes nothing', async () => {
    const { id, queueId } = await startRun(world, stub);
    setBuild(stub, queueId, 41);
    await poll(world, id);
    const before = await row(id);

    for (const status of [503, 401]) {
      stub.failWith = status;
      const res = await poll(world, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().execution).toMatchObject({ status: 'RUNNING', buildNumber: 41 });
    }
    expect(await row(id)).toEqual(before);

    // Jenkins is back: the run carries on from where it was.
    stub.failWith = null;
    Object.assign(build(41), { ...ENDED, result: 'SUCCESS' });
    expect((await poll(world, id)).json().execution.status).toBe('PASSED');
  });

  it('a final status never changes, and Jenkins is not asked again', async () => {
    const execution = await endWith('SUCCESS');
    build(41).result = 'FAILURE';
    const asked = stub.requests.length;
    expect((await poll(world, execution.id)).json().execution.status).toBe('PASSED');
    expect(stub.requests.length).toBe(asked);
  });

  it('a late answer from Jenkins cannot reopen a finished run', async () => {
    const { id } = await startRun(world, stub);
    // The build has reported its number, but nobody has polled yet: the stored status is QUEUED.
    await world.ctx.db('test_executions').where({ id }).update({ jenkins_build_number: 41 });
    stub.builds.set(`${JOB}/41`, { building: true, result: null, timestamp: STARTED, duration: 0 });

    // The first poll's answer ("still running") is held back while the build ends and a
    // second poll records the result.
    const held = stub.holdNext();
    const slow = poll(world, id);
    await held.arrived;
    Object.assign(build(41), { ...ENDED, result: 'SUCCESS' });
    expect((await poll(world, id)).json().execution.status).toBe('PASSED');

    held.release();
    expect((await slow).json().execution.status).toBe('PASSED');
    expect(await row(id)).toMatchObject({ status: 'PASSED', stage: 'COMPLETED' });
  });

  it('a run of an older version does not mark the script', async () => {
    const started = await startRun(world, stub);
    const saved = await world.ctx.app.inject({
      method: 'PUT',
      url: `/api/scripts/${world.scriptId}`,
      headers: world.asUser,
      payload: { content: `${SAMPLE}\n// edited while the run was in progress\n`, baseVersion: 1 },
    });
    expect(saved.statusCode).toBe(200);

    setBuild(stub, started.queueId, 41, { ...ENDED, result: 'SUCCESS' });
    expect((await poll(world, started.id)).json().execution).toMatchObject({ status: 'PASSED', scriptVersion: 1 });
    expect(await scriptState()).toBe('SAVED');
  });

  it('a run nobody watched is brought up to date before a new run is refused', async () => {
    const first = await startRun(world, stub);
    setBuild(stub, first.queueId, 41, { ...ENDED, result: 'SUCCESS' });
    // Nobody polled, so the stored status is still QUEUED.
    expect((await row(first.id)).status).toBe('QUEUED');

    expect((await run(world)).statusCode).toBe(201);
    expect((await row(first.id)).status).toBe('PASSED');
  });
});
