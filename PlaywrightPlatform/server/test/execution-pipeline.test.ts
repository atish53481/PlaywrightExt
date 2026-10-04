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

  describe('reports', () => {
    const links = (id: number, headers: Headers = world.asViewer) =>
      world.ctx.app.inject({ method: 'GET', url: `/api/executions/${id}/reports`, headers });
    const open = (url: string) => world.ctx.app.inject({ method: 'GET', url });
    const html = (text: string) => ({ contentType: 'text/html;charset=utf-8', body: Buffer.from(text) });

    it('offers a link for each report the build archived, once the run has finished', async () => {
      const { id, queueId } = await startRun(world, stub);
      expect((await links(id)).json().reports).toEqual({ overview: null, playwright: null, allure: null });

      setBuild(stub, queueId, 41, PASSED_BUILD);
      await poll(world, id);
      // A build from before the Allure report was added has only the Playwright one.
      stub.artifacts.set(`${JOB}/41/playwright-report/index.html`, html('<html><head></head><body>pw</body></html>'));
      const first = (await links(id)).json().reports;
      expect(first.playwright).toMatch(/^\/api\/reports\/[^/]+\/playwright\/index\.html$/);
      expect(first.allure).toBeNull();

      stub.artifacts.set(`${JOB}/41/allure-report/index.html`, html('<html><head></head><body>allure</body></html>'));
      expect((await links(id)).json().reports.allure).toMatch(/^\/api\/reports\/[^/]+\/allure\/index\.html$/);

      expect((await links(id, {})).statusCode).toBe(401);
      expect((await links(999_999)).statusCode).toBe(404);
    });

    it('serves the report through its link, without a session, sandboxed, and able to run', async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41, PASSED_BUILD);
      await poll(world, id);
      stub.artifacts.set(`${JOB}/41/playwright-report/index.html`, html('<html><head><title>r</title></head><body>pw</body></html>'));
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      // Whatever type Jenkins gives a file, the type sent on comes from its name.
      stub.artifacts.set(`${JOB}/41/playwright-report/data/shot.png`, { contentType: 'text/html', body: png });
      const url: string = (await links(id)).json().reports.playwright;

      const page = await open(url);
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      // Not the site's own policy, which would block the report's scripts; and no access to the site.
      expect(page.headers['content-security-policy']).toBe('sandbox allow-scripts allow-popups allow-downloads');
      expect(page.body).toMatch(/^<html><head><script>.*localStorage.*<\/script><title>r<\/title>/);
      expect(page.body).toContain('<body>pw</body>');
      expect(stub.requests.at(-1)).toMatchObject({ method: 'GET', path: `/job/${JOB}/41/artifact/playwright-report/index.html` });

      const image = await open(url.replace('index.html', 'data/shot.png'));
      expect(image.statusCode).toBe(200);
      expect(image.headers['content-type']).toBe('image/png');
      expect(image.rawPayload.equals(png)).toBe(true);

      expect((await open(url.replace('index.html', 'missing.js'))).statusCode).toBe(404);
      // The link opens the report folders only, and nothing above them.
      expect((await open(url.replace('playwright/index.html', 'playwright/..%2F..%2Fconfig.xml'))).statusCode).toBe(400);
      expect((await open(url.replace('/playwright/', '/other/'))).statusCode).toBe(400);
    });

    it('opens the run on a page of its own: the script, the result of each test, and both reports', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      const tests = [
        { name: 'cart > adds <b>one</b> item', status: 'PASSED', durationMs: 1200 },
        { name: 'cart > checks out', status: 'FAILED', durationMs: 3400, errorMessage: 'expected "Thank you" & got <none>' },
      ];
      await postResult(id, token, { total: 2, passed: 1, failed: 1, skipped: 0, tests });
      setBuild(stub, queueId, 41, { building: false, result: 'UNSTABLE', duration: 5_000 });
      await poll(world, id);
      stub.artifacts.set(`${JOB}/41/playwright-report/index.html`, html('<html></html>'));

      const overview: string = (await links(id)).json().reports.overview;
      expect(overview).toMatch(/^\/api\/reports\/[^/]+\/$/);
      const page = await open(overview);
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
      // Nothing may run on the page; it may only frame the reports.
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.headers['content-security-policy']).toContain("frame-src 'self'");
      expect(page.body).not.toContain('<script');

      // Which script, which version, which run, who started it, and how it ended.
      expect(page.body).toContain('<h1>Login Test</h1>');
      expect(page.body).toContain('version 1 · run #' + id);
      expect(page.body).toContain('Jenkins build 41');
      expect(page.body).toContain('Uma User');
      expect(page.body).toContain('<span class="badge bad">Failed</span>');
      expect(page.body).toContain('1 passed');
      expect(page.body).toContain('1 failed');
      // Each test, with text from the build escaped.
      expect(page.body).toContain('cart &#62; adds &#60;b&#62;one&#60;/b&#62; item');
      expect(page.body).toContain('expected &#34;Thank you&#34; &#38; got &#60;none&#62;');
      expect(page.body).not.toContain('<b>one</b>');

      // Only the report the build archived is offered, by a link relative to the page.
      expect(page.body).toContain('<iframe id="frame-playwright" src="playwright/index.html"');
      expect(page.body).not.toContain('id="frame-allure"');
      expect((await open(overview + 'playwright/index.html')).statusCode).toBe(200);

      // The address without its last slash leads to the page.
      const bare = await open(overview.slice(0, -1));
      expect(bare.statusCode).toBe(302);
      expect(bare.headers.location).toBe(`${overview.split('/')[3]}/`);
      expect((await open('/api/reports/not-a-link/')).statusCode).toBe(401);
    });

    it('gives a finished run the link to its report page, in a run and in the history', async () => {
      const { id, queueId } = await startRun(world, stub);
      const history = () =>
        world.ctx.app.inject({ method: 'GET', url: `/api/scripts/${world.scriptId}/executions`, headers: world.asViewer });
      expect((await poll(world, id)).json().execution.runReportUrl).toBeNull();
      expect((await history()).json().items[0].runReportUrl).toBeNull();

      setBuild(stub, queueId, 41, PASSED_BUILD);
      const link: string = (await poll(world, id)).json().execution.runReportUrl;
      expect(link).toMatch(/^\/api\/reports\/[^/]+\/$/);
      expect((await history()).json().items[0].runReportUrl).toMatch(/^\/api\/reports\/[^/]+\/$/);
      // Made without asking Jenkins, and it opens.
      stub.failWith = 503;
      expect((await history()).json().items[0].runReportUrl).toMatch(/^\/api\/reports\//);
      expect((await open(link)).statusCode).toBe(200);
      stub.failWith = null;
    });

    it('shows scripts that were run together on one page', async () => {
      const first = await startRun(world, stub);
      setBuild(stub, first.queueId, 41, PASSED_BUILD);
      await poll(world, first.id);

      const other = await newScript(world.ctx, world.asAdmin, world.projectId, { name: 'Check <out>' });
      const started = await run(world, world.asUser, other.id);
      const second: number = started.json().execution.id;
      const row = await world.ctx.db('test_executions').where({ id: second }).first('jenkins_queue_id');
      await postResult(second, stub.lastParams.RUN_TOKEN, { total: 2, passed: 1, failed: 1, skipped: 0, errorMessage: 'pay: no <button>\nmore' });
      setBuild(stub, row.jenkins_queue_id, 42, { building: false, result: 'UNSTABLE', duration: 2_000 });
      await poll(world, second);

      const batch = (payload: object, headers: Headers = world.asViewer) =>
        world.ctx.app.inject({ method: 'POST', url: '/api/executions/batch-report', headers, payload });
      const made = await batch({ ids: [first.id, second, first.id] });
      expect(made.statusCode).toBe(200);
      const url: string = made.json().url;
      expect(url).toMatch(/^\/api\/batch-reports\/b[^/]+\/$/);

      const page = await open(url);
      expect(page.statusCode).toBe(200);
      expect(page.headers['content-security-policy']).toContain("default-src 'none'");
      expect(page.body).not.toContain('<script');
      expect(page.body).toContain('<h1>2 scripts run together</h1>');
      expect(page.body).toContain('all finished');
      expect(page.body).toContain('<span class="badge ok">1 passed</span>');
      expect(page.body).toContain('<span class="badge bad">1 failed</span>');
      expect(page.body).toContain('Login Test');
      expect(page.body).toContain('Check &#60;out&#62;');
      expect(page.body).toContain('pay: no &#60;button&#62;');
      expect(page.body).not.toContain('more');
      // Each script links to its own report page, which opens.
      const links = [...page.body.matchAll(/href="(\/api\/reports\/[^"]+\/)"/g)].map((match) => match[1]);
      expect(links).toHaveLength(2);
      expect((await open(links[1])).body).toContain('<h1>Check &#60;out&#62;</h1>');

      expect((await batch({ ids: [first.id] }, {})).statusCode).toBe(401);
      expect((await batch({ ids: [first.id, 999_999] })).statusCode).toBe(404);
      expect((await batch({ ids: [] })).statusCode).toBe(400);
      expect((await batch({ ids: ['1; drop'] })).statusCode).toBe(400);

      // A link for one run does not open the page for several, nor the other way round.
      const token = url.split('/')[3];
      const single = links[0].split('/')[3];
      expect((await open(`/api/batch-reports/${single}/`)).statusCode).toBe(401);
      expect((await open(`/api/reports/${token}/`)).statusCode).toBe(401);
      expect((await open(url.replace(/-\d+\./, '-999.'))).statusCode).toBe(401);
      world.clock.t += 60 * 60_000 + 1_000;
      expect((await open(url)).statusCode).toBe(401);
    });

    it('says why there is nothing to open when the build archived no report', async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41, { building: false, result: 'FAILURE', duration: 1_000 });
      await poll(world, id);
      const reports = (await links(id)).json().reports;
      expect(reports).toMatchObject({ playwright: null, allure: null });
      const page = await open(reports.overview);
      expect(page.statusCode).toBe(200);
      expect(page.body).toContain('archived no report');
      expect(page.body).toContain('The build failed before the tests ran');
      expect(page.body).not.toContain('<iframe');
    });

    it('refuses a link that was changed, belongs to another run, or has expired', async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41, PASSED_BUILD);
      await poll(world, id);
      stub.artifacts.set(`${JOB}/41/playwright-report/index.html`, html('<html></html>'));
      const url: string = (await links(id)).json().reports.playwright;
      const token = url.split('/')[3];
      const [run, expires, signature] = token.split('.');
      expect(run).toBe(String(id));

      for (const forged of [`${id + 1}.${expires}.${signature}`, `${run}.${Number(expires) + 60}.${signature}`, 'x']) {
        const res = await open(url.replace(token, forged));
        expect(res.statusCode).toBe(401);
        expect(res.json().error.code).toBe('REPORT_LINK_EXPIRED');
      }

      expect((await open(url)).statusCode).toBe(200);
      world.clock.t += 60 * 60_000 + 1_000;
      expect((await open(url)).statusCode).toBe(401);
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
