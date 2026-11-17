import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestRunner, RunController } from '../utils/test-runner.js';
import { PlaywrightCodegen } from '../utils/playwright-codegen.js';

const at = (selector) => ({ selector, locator: `locator('${selector}')` });

// A runner whose steps do nothing in a page: a step fails when its `fails` counts down past 0.
function runnerFor(steps) {
  const runner = Object.create(TestRunner);
  runner.ran = [];
  runner.runOne = async (step) => {
    runner.ran.push(step.label);
    if (step.fails > 0) { step.fails -= 1; return `failed: ${step.label}`; }
    return null;
  };
  return runner;
}
const steps = (...labels) => labels.map((label) => ({ action: 'click', label }));
// Lets the run reach the point where it waits.
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the checks made with the recorder tools are written as Playwright assertions', () => {
  const code = (action) => PlaywrightCodegen.actionToCode(action);
  assert.equal(code({ type: 'assertVisible', ...at('#title') }), `await expect(page.locator('#title')).toBeVisible();`);
  assert.equal(code({ type: 'assertText', ...at('#msg'), value: "it's done" }), `await expect(page.locator('#msg')).toContainText('it\\'s done');`);
  assert.equal(code({ type: 'assertValue', ...at('#name'), value: 'Ada' }), `await expect(page.locator('#name')).toHaveValue('Ada');`);
  assert.equal(code({ type: 'assertChecked', ...at('#agree'), checked: true }), `await expect(page.locator('#agree')).toBeChecked();`);
  assert.equal(code({ type: 'assertChecked', ...at('#agree'), checked: false }), `await expect(page.locator('#agree')).not.toBeChecked();`);
});

test('a check of a hovered element keeps the hover, and a check between two fills keeps both', () => {
  const kept = PlaywrightCodegen.normalizeActions([
    { type: 'hover', ...at('#menu') },
    { type: 'assertVisible', ...at('#menu') },
    { type: 'fill', ...at('#name'), value: 'A' },
    { type: 'assertValue', ...at('#name'), value: 'A' },
    { type: 'fill', ...at('#name'), value: 'Ad' },
  ]);
  assert.deepEqual(kept.map((a) => a.type), ['hover', 'assertVisible', 'fill', 'assertValue', 'fill']);
});

test('the recorded checks are steps the Live runner reads back', () => {
  const [visible, checked, unchecked] = TestRunner.parse([
    `await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible();`,
    `await expect(page.getByRole('checkbox', { name: 'Agree' })).toBeChecked();`,
    `await expect(page.getByRole('checkbox', { name: 'Agree' })).not.toBeChecked();`,
  ].join('\n'));
  assert.deepEqual([visible.action, visible.assertion], ['assert', 'toBeVisible']);
  assert.deepEqual([checked.assertion, checked.negated], ['toBeChecked', false]);
  assert.deepEqual([unchecked.assertion, unchecked.negated], ['toBeChecked', true]);
});

test('a step knows its locator as it is written, without the action after it', () => {
  const [click, chained, check] = TestRunner.parse([
    `  await page.getByRole('button', { name: 'Save (2)' }).click();`,
    `await page.getByRole('row').filter({ hasText: 'Ada' }).getByRole('button', { name: 'Delete' }).first().click();`,
    `await expect(page.locator('[data-test="badge"]')).toContainText('1');`,
  ].join('\n'));
  assert.equal(click.locator.src, `page.getByRole('button', { name: 'Save (2)' })`);
  assert.equal(chained.locator.src, `page.getByRole('row').filter({ hasText: 'Ada' }).getByRole('button', { name: 'Delete' }).first()`);
  assert.equal(check.locator.src, `page.locator('[data-test="badge"]')`);
  // The same text read on its own gives the same locator: what the debugger puts in a step.
  const picked = TestRunner.parseLocator(`page.getByRole('button', { name: 'Save (2)' })`);
  assert.deepEqual([picked.method, picked.value, picked.name, picked.src], ['getByRole', 'button', 'Save (2)', click.locator.src]);
  assert.equal(TestRunner.parseLocator('page.title()'), null);
});

test('a plain run goes through every step and counts how each ended', async () => {
  const list = [...steps('a', 'b'), { action: 'skip', label: 'c', reason: 'page-object' }, { action: 'click', label: 'd', fails: 1 }];
  const runner = runnerFor(list);
  const seen = [];
  const summary = await runner.run(list, (i, status) => { if (status !== 'running') seen.push(`${i}:${status}`); });
  assert.deepEqual(summary, { passed: 2, failed: 1, skipped: 1, stopped: false });
  assert.deepEqual(seen, ['0:passed', '1:passed', '2:skipped', '3:failed']);
  assert.deepEqual(runner.ran, ['a', 'b', 'd']);
});

test('a debugged run waits before its first step, and runs one step at a time', async () => {
  const list = steps('a', 'b', 'c');
  const runner = runnerFor(list);
  const controller = new RunController({ startPaused: true });
  const waits = [];
  controller.onPause = (i, info) => waits.push([i, info.failed, controller.waiting]);
  const done = runner.run(list, () => {}, controller);

  await settle();
  // The run is already waiting when onPause is told, so the buttons drawn there are right.
  assert.deepEqual(waits, [[0, false, true]]);
  assert.deepEqual(runner.ran, []);

  controller.step();
  await settle();
  assert.deepEqual(runner.ran, ['a']);
  assert.deepEqual(waits.at(-1), [1, false, true]);

  controller.resume();
  assert.deepEqual(await done, { passed: 3, failed: 0, skipped: 0, stopped: false });
  assert.deepEqual(runner.ran, ['a', 'b', 'c']);
});

test('a breakpoint stops the run before its step, not after', async () => {
  const list = steps('a', 'b', 'c');
  const runner = runnerFor(list);
  const controller = new RunController();
  assert.equal(controller.toggleBreakpoint(2), true);
  const done = runner.run(list, () => {}, controller);
  await settle();
  assert.deepEqual(runner.ran, ['a', 'b']);
  assert.equal(controller.waiting, true);
  assert.equal(controller.toggleBreakpoint(2), false);
  controller.resume();
  assert.equal((await done).passed, 3);
});

test('a failed step of a debugged run waits, and passes when it is run again with a new locator', async () => {
  const list = [...steps('a'), { action: 'click', label: 'broken', fails: 1, locator: { src: 'old' } }, ...steps('c')];
  const runner = runnerFor(list);
  const controller = new RunController({ pauseOnFail: true });
  const waits = [];
  controller.onPause = (i, info) => waits.push([i, info.failed]);
  const statuses = [];
  const done = runner.run(list, (i, status) => statuses.push(`${i}:${status}`), controller);

  await settle();
  assert.deepEqual(waits, [[1, true]]);
  // The step is read again when it is retried: the debugger gave it another locator meanwhile.
  list[1] = { ...list[1], locator: { src: 'new' } };
  controller.retry();
  assert.deepEqual(await done, { passed: 3, failed: 0, skipped: 0, stopped: false });
  assert.deepEqual(statuses, ['0:running', '0:passed', '1:running', '1:failed', '1:running', '1:passed', '2:running', '2:passed']);
});

test('a failed step that is not run again stays failed, and the run goes on', async () => {
  const list = [{ action: 'click', label: 'broken', fails: 5 }, ...steps('b')];
  const runner = runnerFor(list);
  const controller = new RunController({ pauseOnFail: true });
  const done = runner.run(list, () => {}, controller);
  await settle();
  controller.resume();
  assert.deepEqual(await done, { passed: 1, failed: 1, skipped: 0, stopped: false });
});

test('a stopped run leaves the steps it did not reach, and tells which they are', async () => {
  const list = steps('a', 'b', 'c');
  const runner = runnerFor(list);
  const controller = new RunController({ startPaused: true });
  const statuses = [];
  const done = runner.run(list, (i, status) => statuses.push(`${i}:${status}`), controller);
  await settle();
  controller.step();
  await settle();
  controller.stop();
  assert.deepEqual(await done, { passed: 1, failed: 0, skipped: 0, stopped: true });
  assert.deepEqual(runner.ran, ['a']);
  assert.deepEqual(statuses, ['0:running', '0:passed', '1:stopped', '2:stopped']);
});
