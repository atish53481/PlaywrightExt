import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB, poll, run, setBuild, STARTED, startRun, startWorld, type RunWorld } from './execution-helpers';
import { closeApp } from './helpers';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';
import { newScript, SAMPLE } from './script-helpers';

type Headers = Record<string, string>;

const COUNTS = { total: 1, passed: 1, failed: 0, skipped: 0 };
const PASSED_BUILD = { building: false, result: 'SUCCESS' as const, duration: 1_000 };

describe('executions: stop and the pipeline endpoints', () => {
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

  const row = (id: number) => world.ctx.db('test_executions').where({ id }).first();
  const bearer = (token: string | null): Headers => (token === null ? {} : { authorization: `Bearer ${token}` });
  const stop = (id: number, headers: Headers = world.asUser) =>
    world.ctx.app.inject({ method: 'POST', url: `/api/executions/${id}/stop`, headers });
  const fetchScript = (id: number, token: string | null, extra: Headers = {}) =>
    world.ctx.app.inject({
      method: 'GET',
      url: `/api/executions/${id}/script`,
      headers: { ...bearer(token), ...extra },
    });
  const postResult = (id: number, token: string | null, payload: object) =>
    world.ctx.app.inject({ method: 'POST', url: `/api/executions/${id}/result`, headers: bearer(token), payload });
  const stopRequests = () => stub.requests.filter((req) => req.method === 'POST' && req.path.endsWith('/stop'));

  describe('per-test results', () => {
    const results = (id: number, headers: Headers = world.asViewer) =>
      world.ctx.app.inject({ method: 'GET', url: `/api/executions/${id}/results`, headers });
    const tests = [
      { name: 'login > signs in', status: 'PASSED', durationMs: 1200 },
      { name: 'login > rejects a bad password', status: 'FAILED', durationMs: 3400, errorMessage: 'expected title' },
      { name: 'cart > later', status: 'SKIPPED', durationMs: 0 },
    ];

    it('stores each test the build reports and serves them with the run', async () => {
      const { id, token } = await startRun(world, stub);
      const report = { total: 3, passed: 1, failed: 1, skipped: 1, tests };
      expect((await postResult(id, token, report)).statusCode).toBe(204);
      // A build that reports twice replaces what it said before.
      expect((await postResult(id, token, report)).statusCode).toBe(204);

      const res = await results(id);
      expect(res.statusCode).toBe(200);
      const none = { screenshotUrl: null, videoUrl: null, traceUrl: null };
      expect(res.json().items).toEqual([
        { name: 'login > signs in', status: 'PASSED', durationMs: 1200, errorMessage: null, ...none },
        { name: 'login > rejects a bad password', status: 'FAILED', durationMs: 3400, errorMessage: 'expected title', ...none },
        { name: 'cart > later', status: 'SKIPPED', durationMs: 0, errorMessage: null, ...none },
      ]);
    });

    it('links a failed test to its screenshot, video, and trace in the Jenkins build', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      const failed = {
        name: 'login > rejects a bad password',
        status: 'FAILED',
        durationMs: 10,
        screenshot: 'test-results/login-rejects-chromium/test-failed-1.png',
        video: 'test-results/login-rejects-chromium/video.webm',
        trace: 'test-results/login-rejects-chromium/trace.zip',
      };
      // A path that climbs out of the build's files, or is not a relative path, is not kept.
      const sneaky = { name: 'x', status: 'FAILED', durationMs: 1, screenshot: '../../secrets.png', video: '/etc/passwd', trace: 'C:\\x.zip' };
      expect((await postResult(id, token, { total: 2, passed: 0, failed: 2, skipped: 0, tests: [failed, sneaky] })).statusCode).toBe(204);

      // Before the build has a number there is nothing to link to.
      expect((await results(id)).json().items[0]).toMatchObject({ screenshotUrl: null, videoUrl: null, traceUrl: null });

      setBuild(stub, queueId, 41, { building: false, result: 'UNSTABLE', duration: 1_000 });
      await poll(world, id);
      const [first, second] = (await results(id)).json().items;
      const base = `${stub.url}/job/${JOB}/41/artifact/test-results/login-rejects-chromium`;
      expect(first).toMatchObject({
        screenshotUrl: `${base}/test-failed-1.png`,
        videoUrl: `${base}/video.webm`,
        traceUrl: `${base}/trace.zip`,
      });
      expect(second).toMatchObject({ screenshotUrl: null, videoUrl: null, traceUrl: null });
    });

    it('serves a failed test\'s screenshot from the build, to a signed-in person only', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      const shot = 'test-results/login-chromium/test-failed-1.png';
      const tests = [
        { name: 'passes', status: 'PASSED', durationMs: 1 },
        { name: 'fails', status: 'FAILED', durationMs: 1, screenshot: shot },
      ];
      await postResult(id, token, { total: 2, passed: 1, failed: 1, skipped: 0, tests });
      const image = (index: number, headers: Headers = world.asViewer) =>
        world.ctx.app.inject({ method: 'GET', url: `/api/executions/${id}/results/${index}/screenshot`, headers });

      // No build yet, so nothing to fetch.
      expect((await image(1)).statusCode).toBe(404);

      setBuild(stub, queueId, 41, { building: false, result: 'UNSTABLE', duration: 1_000 });
      await poll(world, id);
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      stub.artifacts.set(`${JOB}/41/${shot}`, { contentType: 'image/png', body: png });

      const res = await image(1);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.rawPayload.equals(png)).toBe(true);
      // The platform asked Jenkins with its own credentials.
      expect(stub.requests.at(-1)).toMatchObject({ method: 'GET', path: `/job/${JOB}/41/artifact/${shot}` });

      expect((await image(0)).statusCode).toBe(404); // that test has no screenshot
      expect((await image(7)).statusCode).toBe(404);
      expect((await image(1, {})).statusCode).toBe(401);

      // Only an image is passed on, whatever the build archived under that name.
      stub.artifacts.set(`${JOB}/41/${shot}`, { contentType: 'text/html', body: Buffer.from('<script>1</script>') });
      expect((await image(1)).statusCode).toBe(404);
    });

    it('keeps with a run the skills its script version was made with', async () => {
      const created = await world.ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${world.projectId}/skills`,
        headers: world.asUser,
        payload: { name: 'Login rules', content: 'Prefer getByRole().' },
      });
      const skillId = created.json().skill.id;
      await world.ctx.db('script_skills').insert({ script_id: world.scriptId, script_version: 1, skill_id: skillId, skill_version: 1 });
      const { id } = await startRun(world, stub);
      expect(await world.ctx.db('execution_skill_snapshots').where({ execution_id: id })).toEqual([
        { execution_id: id, skill_id: skillId, skill_version: 1, skill_name: 'Login rules' },
      ]);
    });

    it('needs a session to read results, answers 404 for an unknown run, and an empty list before a report', async () => {
      const { id } = await startRun(world, stub);
      expect((await results(id, {})).statusCode).toBe(401);
      expect((await results(999_999)).statusCode).toBe(404);
      expect((await results(id)).json().items).toEqual([]);
    });

    it('refuses a test with an unknown status, and keeps counts when no tests are listed', async () => {
      const { id, token } = await startRun(world, stub);
      const bad = { ...COUNTS, tests: [{ name: 'x', status: 'BROKEN', durationMs: 1 }] };
      expect((await postResult(id, token, bad)).statusCode).toBe(400);
      expect((await postResult(id, token, COUNTS)).statusCode).toBe(204);
      expect((await row(id)).total_tests).toBe(1);
    });
  });

  describe('deleting a script', () => {
    const del = (scriptId: number, headers: Headers = world.asUser) =>
      world.ctx.app.inject({ method: 'DELETE', url: `/api/scripts/${scriptId}`, headers });
    const deletions = () =>
      stub.requests.filter((req) => req.method === 'POST' && req.path.endsWith('/doDelete')).map((req) => req.path);
    const finishedRun = async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41, PASSED_BUILD);
      expect((await poll(world, id)).json().execution.status).toBe('PASSED');
      return Number((await row(id)).script_id);
    };

    it('removes the script and its builds from Jenkins', async () => {
      const scriptId = await finishedRun();
      expect((await del(scriptId)).statusCode).toBe(204);
      expect(deletions()).toEqual([`/job/${JOB}/41/doDelete`]);
      expect(stub.builds.has(`${JOB}/41`)).toBe(false);
      expect((await world.ctx.db('test_scripts').where({ id: scriptId }).first()).status).toBe('DELETED');
    });

    it('refuses while a run is in progress, and deletes nothing', async () => {
      const { id } = await startRun(world, stub);
      const scriptId = Number((await row(id)).script_id);
      const res = await del(scriptId);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('RUN_IN_PROGRESS');
      expect((await world.ctx.db('test_scripts').where({ id: scriptId }).first()).status).not.toBe('DELETED');
      expect(deletions()).toEqual([]);
    });

    it('still deletes the script when Jenkins cannot be reached', async () => {
      const scriptId = await finishedRun();
      stub.failWith = 503;
      expect((await del(scriptId)).statusCode).toBe(204);
      stub.failWith = null;
      expect((await world.ctx.db('test_scripts').where({ id: scriptId }).first()).status).toBe('DELETED');
    });
  });

  describe('stop', () => {
    it('stops a queued run: taken out of the Jenkins queue and ABORTED at once', async () => {
      const { id, queueId } = await startRun(world, stub);
      const res = await stop(id);
      expect(res.statusCode).toBe(200);
      expect(res.json().execution).toMatchObject({ status: 'ABORTED', stage: 'COMPLETED', buildNumber: null });
      expect(stub.queue.get(queueId)!.cancelled).toBe(true);
      expect((await row(id)).callback_token_hash).toBeNull();
      const audit = await world.ctx.db('audit_logs').where({ action: 'execution.stop' }).first();
      expect(audit.resource_id).toBe(String(id));
    });

    it('stops a running build', async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41);
      await poll(world, id);
      const res = await stop(id, world.asAdmin);
      expect(res.statusCode).toBe(200);
      expect(res.json().execution).toMatchObject({ status: 'ABORTED', stage: 'COMPLETED', buildNumber: 41 });
      expect(stopRequests().map((req) => req.path)).toEqual([`/job/${JOB}/41/stop`]);
    });

    it('stops a build that started without anyone polling', async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41);
      // Nobody polled: the stored run is still QUEUED and has no build number.
      const res = await stop(id);
      expect(res.json().execution).toMatchObject({ status: 'ABORTED', buildNumber: 41 });
      expect(stopRequests()).toHaveLength(1);
      expect(stub.queue.get(queueId)!.cancelled).toBe(false);
    });

    it('refuses a VIEWER, a missing session, an unknown run, and a run that has already finished', async () => {
      const { id, queueId } = await startRun(world, stub);
      expect((await stop(id, world.asViewer)).statusCode).toBe(403);
      expect((await stop(id, {})).statusCode).toBe(401);
      expect((await stop(999)).statusCode).toBe(404);

      // The build ended without anyone polling; stop learns that and says so.
      setBuild(stub, queueId, 41, PASSED_BUILD);
      const res = await stop(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EXECUTION_FINISHED');
      expect((await row(id)).status).toBe('PASSED');
      expect(stopRequests()).toHaveLength(0);
      // And again, now that the stored status is final.
      expect((await stop(id)).statusCode).toBe(409);
    });

    it('answers 502 and changes nothing when Jenkins cannot be reached', async () => {
      const { id } = await startRun(world, stub);
      stub.failWith = 503;
      const res = await stop(id);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('JENKINS_UNREACHABLE');
      expect((await row(id)).status).toBe('QUEUED');
      expect(await world.ctx.db('audit_logs').where({ action: 'execution.stop' }).first()).toBeUndefined();
    });
  });

  describe('pipeline endpoints', () => {
    it('serves the script to the build and records the build number it reports', async () => {
      const { id, token } = await startRun(world, stub);
      const res = await fetchScript(id, token, { 'x-build-number': '41' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).toBe(SAMPLE);
      expect(await row(id)).toMatchObject({
        status: 'QUEUED',
        jenkins_build_number: 41,
        report_url: `${stub.url}/job/${JOB}/41/artifact/playwright-report/index.html`,
      });

      // The number lets a poll find the build after Jenkins has forgotten the queue item.
      stub.queue.clear();
      stub.builds.set(`${JOB}/41`, { building: true, result: null, timestamp: STARTED, duration: 0 });
      expect((await poll(world, id)).json().execution).toMatchObject({ status: 'RUNNING', buildNumber: 41 });
    });

    it('ignores a build number that is not a positive whole number, and keeps the first one', async () => {
      const { id, token } = await startRun(world, stub);
      for (const bad of ['abc', '0', '-3', '1.5', '99999999999']) {
        expect((await fetchScript(id, token, { 'x-build-number': bad })).statusCode).toBe(200);
      }
      expect((await row(id)).jenkins_build_number).toBeNull();

      await fetchScript(id, token, { 'x-build-number': '41' });
      await fetchScript(id, token, { 'x-build-number': '42' });
      expect((await row(id)).jenkins_build_number).toBe(41);
    });

    it('serves the recorded version after the script is edited, deleted, and its project archived', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      const edited = await world.ctx.app.inject({
        method: 'PUT',
        url: `/api/scripts/${world.scriptId}`,
        headers: world.asUser,
        payload: { content: `${SAMPLE}\n// newer\n`, baseVersion: 1 },
      });
      expect(edited.statusCode).toBe(200);
      expect((await fetchScript(id, token)).body).toBe(SAMPLE);

      // The API refuses to delete a script while it runs, so the row is marked directly: the
      // build must still get its script whatever has become of the row.
      await world.ctx.db('test_scripts').where({ id: world.scriptId }).update({ status: 'DELETED' });
      const archived = await world.ctx.app.inject({
        method: 'PUT',
        url: `/api/projects/${world.projectId}`,
        headers: world.asAdmin,
        payload: { status: 'ARCHIVED' },
      });
      expect(archived.statusCode).toBe(200);
      expect((await fetchScript(id, token)).body).toBe(SAMPLE);

      // The run itself can still finish and be read.
      setBuild(stub, queueId, 41, PASSED_BUILD);
      expect((await poll(world, id)).json().execution).toMatchObject({
        status: 'PASSED',
        scriptName: 'Login Test',
        scriptVersion: 1,
      });
    });

    it('refuses a missing, wrong, or foreign token, and a session token', async () => {
      const first = await startRun(world, stub);
      const other = await newScript(world.ctx, world.asAdmin, world.projectId, { name: 'Other Test' });
      expect((await run(world, world.asUser, other.id)).statusCode).toBe(201);
      const foreignToken = stub.lastParams.RUN_TOKEN;
      const sessionToken = world.asUser.authorization.slice('Bearer '.length);

      const refused = async (id: number, token: string | null) => {
        const script = await fetchScript(id, token);
        const result = await postResult(id, token, COUNTS);
        expect([script.statusCode, result.statusCode]).toEqual([401, 401]);
        expect(script.json().error.code).toBe('UNAUTHENTICATED');
        expect(script.body).not.toContain('@playwright/test');
      };
      await refused(first.id, null);
      await refused(first.id, 'not-the-token');
      await refused(first.id, foreignToken);
      await refused(first.id, sessionToken);
      await refused(999, first.token);
      expect((await row(first.id)).total_tests).toBe(0);

      // The right token still works after all the wrong ones.
      expect((await fetchScript(first.id, first.token)).statusCode).toBe(200);
    });

    it('refuses the token once the run has finished', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      setBuild(stub, queueId, 41, PASSED_BUILD);
      expect((await poll(world, id)).json().execution.status).toBe('PASSED');

      expect((await fetchScript(id, token)).statusCode).toBe(401);
      expect((await postResult(id, token, { ...COUNTS, total: 9 })).statusCode).toBe(401);
      expect(await row(id)).toMatchObject({ status: 'PASSED', total_tests: 0, callback_token_hash: null });
    });

    it('stores the counts and the message from the build, and never the status', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      const res = await postResult(id, token, {
        total: 3,
        passed: 2,
        failed: 1,
        skipped: 0,
        errorMessage: 'login: expected title',
        status: 'PASSED',
      });
      expect(res.statusCode).toBe(204);
      expect(await row(id)).toMatchObject({
        status: 'QUEUED',
        total_tests: 3,
        passed_tests: 2,
        failed_tests: 1,
        skipped_tests: 0,
        error_message: 'login: expected title',
      });

      // Jenkins decides the outcome; the counts and the message travel with it.
      setBuild(stub, queueId, 41, { building: false, result: 'UNSTABLE', duration: 1_000 });
      expect((await poll(world, id)).json().execution).toMatchObject({
        status: 'FAILED',
        total: 3,
        passed: 2,
        failed: 1,
        errorMessage: 'login: expected title',
      });
    });

    it('validates the report and trims a long message', async () => {
      const { id, token } = await startRun(world, stub);
      const bad = [
        {},
        { ...COUNTS, total: -1 },
        { ...COUNTS, passed: 1.5 },
        { ...COUNTS, failed: 'two' },
        { ...COUNTS, errorMessage: 7 },
      ];
      for (const payload of bad) expect((await postResult(id, token, payload)).statusCode).toBe(400);
      expect((await row(id)).total_tests).toBe(0);

      expect((await postResult(id, token, { ...COUNTS, errorMessage: 'x'.repeat(5_000) })).statusCode).toBe(204);
      expect((await row(id)).error_message).toHaveLength(2_000);
    });
  });
});
