import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createPlatformClient } from '../utils/platform-client.js';

const USER = { id: 1, email: 'ada@example.com', displayName: 'Ada', role: 'ADMIN' };

function json(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe('platform client', () => {
  let saved;
  let calls;
  let responder;
  let client;

  beforeEach(() => {
    saved = { url: '', token: '', user: null };
    calls = [];
    responder = () => json(200, {});
    client = createPlatformClient({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return responder(url, init);
      },
      storage: {
        getPlatform: async () => saved,
        savePlatform: async (next) => {
          saved = next;
        },
      },
    });
  });

  it('login posts extension credentials and stores url, token, and user but never the password', async () => {
    responder = () => json(200, { user: USER, token: 'tok-123', expiresAt: '2030-01-01T00:00:00.000Z' });
    const user = await client.login(' http://localhost:3000/// ', 'ada@example.com', 'pw-secret');

    assert.deepEqual(user, USER);
    assert.equal(calls[0].url, 'http://localhost:3000/api/auth/login');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), {
      email: 'ada@example.com',
      password: 'pw-secret',
      client: 'extension',
    });
    assert.deepEqual(saved, { url: 'http://localhost:3000', token: 'tok-123', user: USER });
    assert.ok(!JSON.stringify(saved).includes('pw-secret'));
  });

  it('login surfaces the server error message and stores nothing', async () => {
    responder = () => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password.' } });
    await assert.rejects(client.login('http://localhost:3000', 'a@b.co', 'x'), /Invalid email or password\./);
    assert.equal(saved.token, '');
  });

  it('stores nothing when the address answers 200 but not as the platform does', async () => {
    for (const answer of [{}, { ok: true }, { token: 'x' }, { token: '', user: USER }, { token: 5, user: USER }]) {
      responder = () => json(200, answer);
      await assert.rejects(client.login('http://localhost:3000', 'a@b.co', 'x'), /did not answer like the Playwright Platform/);
    }
    assert.equal(saved.token, '');
  });

  it('rejects a URL that is not http or https before any request', async () => {
    await assert.rejects(client.login('localhost:3000', 'a@b.co', 'x'), /must start with http/);
    await assert.rejects(client.login('javascript:alert(1)', 'a@b.co', 'x'), /must start with http/);
    assert.equal(calls.length, 0);
  });

  it('refuses plain http for a host that is not this machine, before any request', async () => {
    await assert.rejects(client.login('http://platform.example.com', 'a@b.co', 'x'), /https/);
    await assert.rejects(client.login('http://192.168.1.20:3000', 'a@b.co', 'x'), /https/);
    assert.equal(calls.length, 0);

    responder = () => json(200, { user: USER, token: 't', expiresAt: '2030-01-01T00:00:00.000Z' });
    await client.login('http://127.0.0.1:3000', 'a@b.co', 'x');
    await client.login('https://platform.example.com', 'a@b.co', 'x');
    assert.equal(calls.length, 2);
  });

  it('explains an unreachable platform', async () => {
    client = createPlatformClient({
      fetchFn: async () => {
        throw new TypeError('Failed to fetch');
      },
      storage: { getPlatform: async () => saved, savePlatform: async () => {} },
    });
    await assert.rejects(
      client.login('http://localhost:3000', 'a@b.co', 'x'),
      /Cannot reach the platform at http:\/\/localhost:3000/,
    );
  });

  it('me sends the bearer token and returns the user', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(200, { user: USER, csrfToken: null });
    assert.deepEqual(await client.me(), USER);
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
  });

  it('me returns null and forgets the token when the session has ended', async () => {
    saved = { url: 'http://localhost:3000', token: 'old', user: USER };
    responder = () => json(401, { error: { code: 'UNAUTHENTICATED', message: 'Sign in to continue.' } });
    assert.equal(await client.me(), null);
    assert.deepEqual(saved, { url: 'http://localhost:3000', token: '', user: null });
  });

  it('me returns null without a request when not signed in', async () => {
    assert.equal(await client.me(), null);
    assert.equal(calls.length, 0);
  });

  it('logout clears the token even if the server call fails, and keeps the url', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => {
      throw new TypeError('Failed to fetch');
    };
    await client.logout();
    assert.deepEqual(saved, { url: 'http://localhost:3000', token: '', user: null });
  });

  it('listProjects returns the items array', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(200, { items: [{ id: 7, name: 'Shop' }], total: 1, page: 1, pageSize: 100 });
    assert.deepEqual(await client.listProjects(), [{ id: 7, name: 'Shop' }]);
    assert.equal(calls[0].url, 'http://localhost:3000/api/projects?pageSize=100');
  });

  it('listProjects requires a sign-in', async () => {
    await assert.rejects(client.listProjects(), /Sign in to the platform first/);
  });

  const SCRIPT = {
    name: 'Login Test',
    description: 'Signs in',
    content: "test('a', async () => {});",
    source: 'RECORDED',
    language: 'TypeScript',
  };

  it('saveScript posts the script with the bearer token and returns the created script', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(201, { script: { id: 9, name: 'Login Test', version: 1 } });

    const script = await client.saveScript(7, SCRIPT);

    assert.deepEqual(script, { id: 9, name: 'Login Test', version: 1 });
    assert.equal(calls[0].url, 'http://localhost:3000/api/projects/7/scripts');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
    assert.deepEqual(JSON.parse(calls[0].init.body), SCRIPT);
  });

  it('saveScript sends an empty description when none is given', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(201, { script: { id: 9 } });
    const { description, ...withoutDescription } = SCRIPT;
    await client.saveScript(7, withoutDescription);
    assert.equal(JSON.parse(calls[0].init.body).description, '');
  });

  it('saveScript surfaces the server message and status when the name is taken', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () =>
      json(409, {
        error: {
          code: 'SCRIPT_NAME_TAKEN',
          message: 'A script named "Login Test" already exists in this project.',
          details: null,
        },
      });
    await assert.rejects(client.saveScript(7, SCRIPT), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already exists in this project/);
      return true;
    });
  });

  it('saveScript shows the specific validation problem, not the generic message', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () =>
      json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [{ path: 'content', message: 'Script content is too long (1,000,000 characters max).' }],
        },
      });
    await assert.rejects(client.saveScript(7, SCRIPT), /Script content is too long/);
  });

  it('saveScript requires a sign-in and sends nothing without one', async () => {
    await assert.rejects(client.saveScript(7, SCRIPT), /Sign in to the platform first/);
    assert.equal(calls.length, 0);
  });

  it('saveScript refuses a project id that is not a positive whole number', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    for (const projectId of ['7/../../users', 0, -1, 1.5, NaN, undefined]) {
      await assert.rejects(client.saveScript(projectId, SCRIPT), /Choose a project/);
    }
    assert.equal(calls.length, 0);
  });

  const SIGNED_IN = { url: 'http://localhost:3000', token: 'tok-123', user: USER };

  it("listScripts asks for a project's scripts, with the search text when given", async () => {
    saved = SIGNED_IN;
    responder = () => json(200, { items: [{ id: 3, name: 'Login Test' }], total: 1, page: 1, pageSize: 100 });
    assert.deepEqual(await client.listScripts(7), [{ id: 3, name: 'Login Test' }]);
    assert.equal(calls[0].url, 'http://localhost:3000/api/projects/7/scripts?pageSize=100');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');

    await client.listScripts(7, '  log in & out ');
    assert.equal(calls[1].url, 'http://localhost:3000/api/projects/7/scripts?pageSize=100&search=log+in+%26+out');
  });

  it('getScript returns the script with its content', async () => {
    saved = SIGNED_IN;
    responder = () => json(200, { script: { id: 3, content: 'x' } });
    assert.deepEqual(await client.getScript(3), { id: 3, content: 'x' });
    assert.equal(calls[0].url, 'http://localhost:3000/api/scripts/3');
  });

  it('Jenkins settings: reads them, and saves without a token unless one was typed', async () => {
    saved = SIGNED_IN;
    const settings = { configured: true, baseUrl: 'http://localhost:7070', username: 'ci', jobName: 'run', hasToken: true };
    responder = () => json(200, { settings });
    assert.deepEqual(await client.getJenkinsSettings(), settings);
    assert.equal(calls[0].url, 'http://localhost:3000/api/jenkins/settings');

    const kept = await client.saveJenkinsSettings({ baseUrl: 'http://localhost:7070', username: 'ci', jobName: 'run', token: '' });
    assert.deepEqual(kept, settings);
    assert.equal(calls[1].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].init.body), { baseUrl: 'http://localhost:7070', username: 'ci', jobName: 'run' });

    await client.saveJenkinsSettings({ baseUrl: 'http://localhost:7070', username: 'ci', jobName: '', token: 'secret' });
    assert.deepEqual(JSON.parse(calls[2].init.body), { baseUrl: 'http://localhost:7070', username: 'ci', token: 'secret' });
  });

  it('testJenkins sends only the fields that were filled in', async () => {
    saved = SIGNED_IN;
    const result = { ok: true, version: '2.555.2', pipelinePlugin: true, message: 'Connected to Jenkins 2.555.2.' };
    responder = () => json(200, result);
    assert.deepEqual(await client.testJenkins({ baseUrl: 'http://localhost:7070', username: '', token: 'secret' }), result);
    assert.equal(calls[0].url, 'http://localhost:3000/api/jenkins/test');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { baseUrl: 'http://localhost:7070', token: 'secret' });

    await client.testJenkins();
    assert.deepEqual(JSON.parse(calls[1].init.body), {});
  });

  it('createJenkinsJob, runScript, and stopExecution post without a body', async () => {
    saved = SIGNED_IN;
    responder = (url) =>
      url.endsWith('/jenkins/job')
        ? json(200, { created: true, jobUrl: 'http://localhost:7070/job/run/' })
        : json(url.endsWith('/run') ? 201 : 200, { execution: { id: 12, status: 'QUEUED' } });

    assert.deepEqual(await client.createJenkinsJob(), { created: true, jobUrl: 'http://localhost:7070/job/run/' });
    assert.deepEqual(await client.runScript(3), { id: 12, status: 'QUEUED' });
    assert.deepEqual(await client.stopExecution(12), { id: 12, status: 'QUEUED' });

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'http://localhost:3000/api/jenkins/job',
        'http://localhost:3000/api/scripts/3/run',
        'http://localhost:3000/api/executions/12/stop',
      ],
    );
    for (const call of calls) {
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.body, undefined);
      // The server refuses a JSON content type that comes with no body.
      assert.equal(call.init.headers['Content-Type'], undefined);
    }
  });

  it('getExecution and listExecutions read runs', async () => {
    saved = SIGNED_IN;
    responder = (url) =>
      url.includes('/scripts/') ? json(200, { items: [{ id: 12 }] }) : json(200, { execution: { id: 12 } });
    assert.deepEqual(await client.getExecution(12), { id: 12 });
    assert.equal(calls[0].url, 'http://localhost:3000/api/executions/12');
    assert.deepEqual(await client.listExecutions(3), [{ id: 12 }]);
    assert.equal(calls[1].url, 'http://localhost:3000/api/scripts/3/executions?limit=10');
    await client.listExecutions(3, 5);
    assert.equal(calls[2].url, 'http://localhost:3000/api/scripts/3/executions?limit=5');
    await client.listExecutions(3, 500);
    assert.equal(calls[3].url, 'http://localhost:3000/api/scripts/3/executions?limit=10');
  });

  it('a refused run carries the server code and details, so the panel can show the run in progress', async () => {
    saved = SIGNED_IN;
    responder = () =>
      json(409, {
        error: {
          code: 'RUN_IN_PROGRESS',
          message: 'This script is already running. Wait for that run to finish, or stop it.',
          details: { executionId: 12 },
        },
      });
    await assert.rejects(client.runScript(3), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'RUN_IN_PROGRESS');
      assert.deepEqual(err.details, { executionId: 12 });
      assert.match(err.message, /already running/);
      return true;
    });
  });

  it('the new methods refuse ids that are not positive whole numbers, and need a sign-in', async () => {
    saved = SIGNED_IN;
    for (const bad of ['3/../../users', 0, -1, 1.5, NaN, undefined]) {
      await assert.rejects(client.listScripts(bad), /Choose a project/);
      await assert.rejects(client.getScript(bad), /Choose a script/);
      await assert.rejects(client.runScript(bad), /Choose a script/);
      await assert.rejects(client.listExecutions(bad), /Choose a script/);
      await assert.rejects(client.getExecution(bad), /Choose a run/);
      await assert.rejects(client.stopExecution(bad), /Choose a run/);
    }
    assert.equal(calls.length, 0);

    saved = { url: '', token: '', user: null };
    await assert.rejects(client.getJenkinsSettings(), /Sign in to the platform first/);
    await assert.rejects(client.runScript(3), /Sign in to the platform first/);
    assert.equal(calls.length, 0);
  });
});

describe('platform client: projects', () => {
  let calls;
  let client;

  beforeEach(() => {
    calls = [];
    client = createPlatformClient({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        if (init.method === 'DELETE') return { ok: true, status: 204, json: async () => null };
        return json(200, { project: { id: 7, name: JSON.parse(init.body).name } });
      },
      storage: {
        getPlatform: async () => ({ url: 'http://localhost:3000', token: 'tok-1', user: USER }),
        savePlatform: async () => undefined,
      },
    });
  });

  it('creates, renames, and deletes a project with the session token', async () => {
    assert.deepEqual(await client.createProject('Checkout'), { id: 7, name: 'Checkout' });
    assert.deepEqual(await client.renameProject(7, 'Checkout v2'), { id: 7, name: 'Checkout v2' });
    await client.deleteProject(7);

    assert.deepEqual(calls.map((call) => `${call.init.method} ${call.url}`), [
      'POST http://localhost:3000/api/projects',
      'PUT http://localhost:3000/api/projects/7',
      'DELETE http://localhost:3000/api/projects/7',
    ]);
    assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Checkout', description: '' });
    assert.deepEqual(JSON.parse(calls[1].init.body), { name: 'Checkout v2' });
    for (const call of calls) assert.equal(call.init.headers.Authorization, 'Bearer tok-1');
  });

  it('refuses an id that is not a positive whole number before any request', async () => {
    for (const id of [0, -1, 1.5, '7', null]) {
      await assert.rejects(() => client.renameProject(id, 'x'), /Choose a project/);
      await assert.rejects(() => client.deleteProject(id), /Choose a project/);
    }
    assert.equal(calls.length, 0);
  });
});

describe('platform client: what a run records', () => {
  it('sends the choice of screenshots and video with the run, as two booleans', async () => {
    const calls = [];
    const client = createPlatformClient({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return json(201, { execution: { id: 12, status: 'QUEUED' } });
      },
      storage: {
        getPlatform: async () => ({ url: 'http://localhost:3000', token: 'tok-1', user: USER }),
        savePlatform: async () => undefined,
      },
    });

    await client.runScript(3, { screenshots: true, video: false });
    await client.runScript(3, { screenshots: 0, video: 'yes', extra: 'dropped' });
    await client.runScript(3);

    assert.deepEqual(JSON.parse(calls[0].init.body), { screenshots: true, video: false });
    assert.deepEqual(JSON.parse(calls[1].init.body), { screenshots: false, video: true });
    // Without a choice no body is sent, and the server applies its own.
    assert.equal(calls[2].init.body, undefined);
    for (const call of calls) assert.equal(call.url, 'http://localhost:3000/api/scripts/3/run');
  });
});

describe('platform client: one report for several runs', () => {
  it('asks for the page of the given runs and returns its path', async () => {
    const calls = [];
    const client = createPlatformClient({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return json(200, { url: '/api/batch-reports/b12-13.1790000000.sig/' });
      },
      storage: {
        getPlatform: async () => ({ url: 'http://localhost:3000', token: 'tok-1', user: USER }),
        savePlatform: async () => undefined,
      },
    });

    assert.equal(await client.getBatchReportPath([12, 13]), '/api/batch-reports/b12-13.1790000000.sig/');
    assert.equal(calls[0].url, 'http://localhost:3000/api/executions/batch-report');
    assert.deepEqual(JSON.parse(calls[0].init.body), { ids: [12, 13] });
    assert.equal(await client.platformUrl(), 'http://localhost:3000');

    for (const bad of [[], null, [0], [1, '2'], [1.5]]) {
      await assert.rejects(() => client.getBatchReportPath(bad), /Choose a run/);
    }
    assert.equal(calls.length, 1);
  });
});
