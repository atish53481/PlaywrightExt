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

  it('rejects a URL that is not http or https before any request', async () => {
    await assert.rejects(client.login('localhost:3000', 'a@b.co', 'x'), /must start with http/);
    await assert.rejects(client.login('javascript:alert(1)', 'a@b.co', 'x'), /must start with http/);
    assert.equal(calls.length, 0);
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
});
