import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { pickFixedCode } from '../utils/code-extract.js';
import { diffStats, lineDiff } from '../utils/line-diff.js';
import { createPlatformClient } from '../utils/platform-client.js';

describe('line diff', () => {
  it('marks removed and added lines and keeps the rest in order', () => {
    const before = "test('a', async ({ page }) => {\n  await page.getByText('Add to cart').click();\n});";
    const after = "test('a', async ({ page }) => {\n  await page.locator('[data-test=\"add\"]').click();\n  await expect(page).toHaveURL(/cart/);\n});";
    assert.deepEqual(lineDiff(before, after), [
      { type: 'same', text: "test('a', async ({ page }) => {" },
      { type: 'del', text: "  await page.getByText('Add to cart').click();" },
      { type: 'add', text: "  await page.locator('[data-test=\"add\"]').click();" },
      { type: 'add', text: '  await expect(page).toHaveURL(/cart/);' },
      { type: 'same', text: '});' },
    ]);
    assert.deepEqual(diffStats(lineDiff(before, after)), { added: 2, removed: 1 });
  });

  it('reports no change for the same text, whatever the line endings', () => {
    const diff = lineDiff('a\r\nb\r\n', 'a\nb\n');
    assert.deepEqual(diffStats(diff), { added: 0, removed: 0 });
    assert.ok(diff.every((line) => line.type === 'same'));
  });

  it('handles empty sides and very long texts', () => {
    assert.deepEqual(lineDiff('', 'x'), [{ type: 'add', text: 'x' }]);
    assert.deepEqual(lineDiff('x', ''), [{ type: 'del', text: 'x' }]);
    const big = Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n');
    const stats = diffStats(lineDiff(big, `${big}\nlast`));
    assert.deepEqual(stats, { added: 1, removed: 0 });
  });
});

describe('the fixed file in a Healer answer', () => {
  const F = '`'.repeat(3);
  it('takes the longest fenced block that contains a test, and nothing when there is none', () => {
    const whole = "import { test } from '@playwright/test';\n\ntest('a', async ({ page }) => {\n  await page.goto('/');\n});";
    const answer = `## Report\n\n${F}ts\npage.getByRole('button')\n${F}\n\nFixed file:\n\n${F}typescript\n${whole}\n${F}\n\n${F}ts\ntest('x', () => {});\n${F}\n`;
    assert.equal(pickFixedCode(answer), whole);
    assert.equal(pickFixedCode(`Just advice.\n\n${F}ts\npage.locator('#a')\n${F}`), '');
    assert.equal(pickFixedCode('no code at all'), '');
    assert.equal(pickFixedCode(null), '');
  });
});

describe('platform client: healed versions and screenshots', () => {
  const SIGNED_IN = { url: 'http://localhost:3000', token: 'tok-1', user: { id: 1, role: 'USER' } };
  let calls;
  let responder;
  let client;

  beforeEach(() => {
    calls = [];
    responder = () => ({ ok: true, status: 200, json: async () => ({ script: { id: 7, version: 3 } }) });
    client = createPlatformClient({
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return responder(url, init);
      },
      storage: { getPlatform: async () => SIGNED_IN, savePlatform: async () => {} },
    });
  });

  it('updateScript sends the change and returns the script', async () => {
    const patch = { content: 'fixed', baseVersion: 2, changeSummary: 'Healed', healed: true, skills: [{ id: 3, version: 1 }] };
    assert.deepEqual(await client.updateScript(7, patch), { id: 7, version: 3 });
    assert.equal(calls[0].url, 'http://localhost:3000/api/scripts/7');
    assert.equal(calls[0].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[0].init.body), patch);
  });

  it('updateScript passes on a version conflict with its code', async () => {
    responder = () => ({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'VERSION_CONFLICT', message: 'This script is now at v3.' } }),
    });
    await assert.rejects(client.updateScript(7, { content: 'x', baseVersion: 2 }), (err) => err.code === 'VERSION_CONFLICT');
  });

  it('getScreenshot returns the image, sent with the session token', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' });
    responder = () => ({ ok: true, status: 200, blob: async () => blob });
    assert.equal(await client.getScreenshot(12, 1), blob);
    assert.equal(calls[0].url, 'http://localhost:3000/api/executions/12/results/1/screenshot');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-1');

    responder = () => ({ ok: false, status: 404, blob: async () => blob });
    await assert.rejects(client.getScreenshot(12, 1), /not available/);
    for (const bad of [-1, 1.5, '1', undefined]) await assert.rejects(client.getScreenshot(12, bad), /Choose a test/);
  });

  it('listProjectSkills passes a search on, and createSkill its tags', async () => {
    responder = () => ({ ok: true, status: 200, json: async () => ({ items: [], skill: { id: 1 } }) });
    await client.listProjectSkills(5, ' login rules ');
    await client.listProjectSkills(5);
    await client.createSkill(5, { name: 'A', content: 'c', tags: ['smoke'] });
    assert.equal(calls[0].url, 'http://localhost:3000/api/projects/5/skills?search=login+rules');
    assert.equal(calls[1].url, 'http://localhost:3000/api/projects/5/skills');
    assert.deepEqual(JSON.parse(calls[2].init.body), { name: 'A', description: '', content: 'c', tags: ['smoke'] });
  });
});
