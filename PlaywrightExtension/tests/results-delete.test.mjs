import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { deleteControls, resultRows } from '../utils/execution-view.js';
import { createPlatformClient } from '../utils/platform-client.js';

const SIGNED_IN = { url: 'http://localhost:3000', token: 'tok-1', user: { id: 1, role: 'USER' } };

describe('platform client: results and delete', () => {
  let calls;
  let responder;
  let saved;
  let client;

  beforeEach(() => {
    calls = [];
    saved = SIGNED_IN;
    responder = () => ({ ok: true, status: 200, json: async () => ({}) });
    client = createPlatformClient({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return responder(url, init);
      },
      storage: { getPlatform: async () => saved, savePlatform: async () => {} },
    });
  });

  it('listExecutionResults reads the tests of a run', async () => {
    const items = [{ name: 'login > signs in', status: 'PASSED', durationMs: 1200, errorMessage: null }];
    responder = () => ({ ok: true, status: 200, json: async () => ({ items }) });
    assert.deepEqual(await client.listExecutionResults(12), items);
    assert.equal(calls[0].url, 'http://localhost:3000/api/executions/12/results');
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1');
  });

  it('deleteScript sends DELETE and accepts an empty answer', async () => {
    responder = () => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    await client.deleteScript(7);
    assert.equal(calls[0].url, 'http://localhost:3000/api/scripts/7');
    assert.equal(calls[0].init.method, 'DELETE');
  });

  it('deleteScript passes on the refusal code when a run is in progress', async () => {
    responder = () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'RUN_IN_PROGRESS', message: 'This script is already running.' } }),
    });
    await assert.rejects(client.deleteScript(7), (err) => err.code === 'RUN_IN_PROGRESS' && err.status === 409);
  });

  it('refuses ids that are not positive whole numbers, and needs a sign-in', async () => {
    for (const bad of [0, -1, 1.5, '7', null, undefined]) {
      await assert.rejects(client.listExecutionResults(bad), /Choose a run/);
      await assert.rejects(client.deleteScript(bad), /Choose a script/);
    }
    assert.equal(calls.length, 0);
    saved = { url: 'http://localhost:3000', token: '', user: null };
    await assert.rejects(client.deleteScript(7), /Sign in/);
    await assert.rejects(client.listExecutionResults(7), /Sign in/);
  });
});

describe('result rows', () => {
  it('turns each test into a label, a class, a name, a duration, and its error', () => {
    assert.deepEqual(
      resultRows([
        { name: 'login > signs in', status: 'PASSED', durationMs: 850, errorMessage: null },
        { name: 'login > bad password', status: 'FAILED', durationMs: 3400, errorMessage: 'expected title' },
        { name: 'cart > later', status: 'SKIPPED', durationMs: 0, errorMessage: null },
      ]),
      [
        { label: 'Passed', className: 'run-status run-ok', name: 'login > signs in', duration: '850ms', error: '', links: [] },
        { label: 'Failed', className: 'run-status run-bad', name: 'login > bad password', duration: '3.4s', error: 'expected title', links: [] },
        { label: 'Skipped', className: 'run-status run-off', name: 'cart > later', duration: '', error: '', links: [] },
      ],
    );
  });

  it('links a test to the files its build kept, only when they are under the Jenkins address', () => {
    const base = 'http://localhost:7070';
    const artifact = `${base}/job/run/41/artifact/test-results/a`;
    const [row] = resultRows(
      [{
        name: 'a',
        status: 'FAILED',
        durationMs: 5,
        errorMessage: null,
        screenshotUrl: `${artifact}/test-failed-1.png`,
        videoUrl: 'javascript:alert(1)',
        traceUrl: 'http://evil.example/trace.zip',
      }],
      base,
    );
    assert.deepEqual(row.links, [{ label: 'Screenshot', href: `${artifact}/test-failed-1.png` }]);
    // A panel that does not know the Jenkins address still refuses anything but http and https.
    const [loose] = resultRows([{ name: 'a', status: 'FAILED', videoUrl: 'javascript:alert(1)', traceUrl: `${artifact}/trace.zip` }]);
    assert.deepEqual(loose.links, [{ label: 'Trace', href: `${artifact}/trace.zip` }]);
  });

  it('never takes a label or a class from the server, and survives a bad answer', () => {
    const [row] = resultRows([{ name: 42, status: '<img onerror=x>', durationMs: 'soon', errorMessage: { a: 1 } }]);
    assert.deepEqual(row, { label: 'Unknown', className: 'run-status run-off', name: '42', duration: '', error: '', links: [] });
    assert.deepEqual(resultRows(null), []);
    assert.deepEqual(resultRows({ items: [] }), []);
  });
});

describe('delete controls', () => {
  const base = { projectStatus: 'ACTIVE', execution: null };

  it('offers Delete to ADMIN and USER in an active project only', () => {
    assert.deepEqual(deleteControls({ ...base, role: 'ADMIN' }), { showDelete: true, deleteDisabled: false });
    assert.deepEqual(deleteControls({ ...base, role: 'USER' }), { showDelete: true, deleteDisabled: false });
    assert.equal(deleteControls({ ...base, role: 'VIEWER' }).showDelete, false);
    assert.equal(deleteControls({ ...base, role: undefined }).showDelete, false);
    assert.equal(deleteControls({ ...base, role: 'ADMIN', projectStatus: 'ARCHIVED' }).showDelete, false);
  });

  it('disables Delete while a run is unfinished', () => {
    for (const status of ['QUEUED', 'RUNNING']) {
      assert.equal(deleteControls({ ...base, role: 'USER', execution: { status } }).deleteDisabled, true);
    }
    assert.equal(deleteControls({ ...base, role: 'USER', execution: { status: 'FAILED' } }).deleteDisabled, false);
  });
});
