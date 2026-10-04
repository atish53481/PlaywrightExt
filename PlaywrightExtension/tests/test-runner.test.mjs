import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestRunner } from '../utils/test-runner.js';
import { PlaywrightCodegen } from '../utils/playwright-codegen.js';

const at = (selector) => ({ selector, locator: `locator('${selector}')` });

test('every recorded action is written as its Playwright call', () => {
  const code = (action) => PlaywrightCodegen.actionToCode(action);
  assert.equal(code({ type: 'hover', ...at('#menu') }), `await page.locator('#menu').hover();`);
  assert.equal(code({ type: 'dblclick', ...at('#row') }), `await page.locator('#row').dblclick();`);
  assert.equal(code({ type: 'rightClick', ...at('#row') }), `await page.locator('#row').click({ button: 'right' });`);
  assert.equal(code({ type: 'select', ...at('#country'), value: 'nl' }), `await page.locator('#country').selectOption('nl');`);
  assert.equal(code({ type: 'check', ...at('#agree') }), `await page.locator('#agree').check();`);
  assert.equal(code({ type: 'uncheck', ...at('#agree') }), `await page.locator('#agree').uncheck();`);
  assert.equal(code({ type: 'drag', ...at('#card'), target: at('#done') }), `await page.locator('#card').dragTo(page.locator('#done'));`);
  assert.equal(code({ type: 'upload', ...at('#file'), files: ['a.pdf'] }), `await page.locator('#file').setInputFiles('a.pdf');`);
  assert.equal(code({ type: 'upload', ...at('#file'), files: ['a.pdf', "b's.png"] }), `await page.locator('#file').setInputFiles(['a.pdf', 'b\\'s.png']);`);
  assert.equal(code({ type: 'press', key: 'Control+s' }), `await page.keyboard.press('Control+s');`);
});

test('a role locator is read with its name, and with whether the whole name is asked for', () => {
  const [loose, exact] = TestRunner.parse([
    `await page.getByRole('button', { name: 'Save' }).click();`,
    `await page.getByRole('button', { name: 'Save', exact: true }).click();`,
  ].join('\n'));
  assert.deepEqual([loose.locator.method, loose.locator.value, loose.locator.name, loose.locator.exact], ['getByRole', 'button', 'Save', false]);
  assert.equal(exact.locator.exact, true);
});

test('a hover is kept only where it does something the next step does not', () => {
  const types = (actions) => PlaywrightCodegen.normalizeActions(actions).map((a) => `${a.type} ${a.selector}`);
  // Resting on a button before clicking it is the click.
  assert.deepEqual(types([{ type: 'hover', ...at('#save') }, { type: 'click', ...at('#save') }]), ['click #save']);
  assert.deepEqual(types([{ type: 'hover', ...at('#name') }, { type: 'fill', ...at('#name'), value: 'a' }]), ['fill #name']);
  // A menu opened by a hover, then an item in it: both steps are needed.
  assert.deepEqual(
    types([{ type: 'hover', ...at('#menu') }, { type: 'hover', ...at('#sub') }, { type: 'click', ...at('#item') }]),
    ['hover #menu', 'hover #sub', 'click #item'],
  );
  assert.deepEqual(
    types([{ type: 'hover', ...at('#menu') }, { type: 'hover', ...at('#menu') }, { type: 'click', ...at('#item') }]),
    ['hover #menu', 'click #item'],
  );
  // A hover that nothing follows, or that the page is left after, brought out nothing that was used.
  assert.deepEqual(types([{ type: 'click', ...at('#logout') }, { type: 'hover', ...at('#title') }]), ['click #logout']);
  assert.deepEqual(
    PlaywrightCodegen.normalizeActions([{ type: 'hover', ...at('#title') }, { type: 'navigate', url: 'https://example.test/' }]).map((a) => a.type),
    ['navigate'],
  );
});

test('the click that puts the caret in a field is not a step when the field is then filled', () => {
  const types = (actions) => PlaywrightCodegen.normalizeActions(actions).map((a) => `${a.type} ${a.selector}${a.value ? `=${a.value}` : ''}`);
  assert.deepEqual(
    types([
      { type: 'click', ...at('#user') }, { type: 'fill', ...at('#user'), value: 'A' }, { type: 'fill', ...at('#user'), value: 'Admin' },
      { type: 'click', ...at('#login') },
    ]),
    ['fill #user=Admin', 'click #login'],
  );
  // A click on one element and a fill of another are two steps.
  assert.deepEqual(
    types([{ type: 'click', ...at('#open') }, { type: 'fill', ...at('#user'), value: 'a' }]),
    ['click #open', 'fill #user=a'],
  );
});

test('.first(), .nth(), and .last() say which of several matches a step acts on', () => {
  const steps = TestRunner.parse([
    `await page.getByRole('button', { name: 'Delete' }).click();`,
    `await page.getByRole('button', { name: 'Delete' }).first().click();`,
    `await page.getByText('Edit').nth(2).click();`,
    `await page.getByTitle('Close').last().click();`,
    `await page.getByAltText('Company logo').click();`,
  ].join('\n'));
  assert.deepEqual(steps.map((step) => step.action), ['click', 'click', 'click', 'click', 'click']);
  assert.deepEqual(steps.map((step) => step.locator.pick), [null, 0, 2, 'last', null]);
  assert.deepEqual(steps.slice(3).map((step) => step.locator.method), ['getByTitle', 'getByAltText']);
});

test('a dialog is answered, and a new tab waited for, before the step that brings it up', () => {
  const code = PlaywrightCodegen.actionsToTest([
    { type: 'navigate', url: 'https://shop.test/' },
    { type: 'click', ...at('#delete'), url: 'https://shop.test/' },
    { type: 'dialog', kind: 'confirm', message: 'Sure?', accept: false },
    { type: 'click', ...at('#rename'), url: 'https://shop.test/' },
    { type: 'dialog', kind: 'prompt', message: 'Name?', accept: true, text: "O'Brien" },
    { type: 'click', ...at('#report'), url: 'https://shop.test/' },
    { type: 'popup', opened: 1 },
    { type: 'click', ...at('#print'), url: 'https://shop.test/report', page: 1 },
  ]);
  const lines = code.split('\n').map((line) => line.trim());
  const before = (first, second) => lines.indexOf(first) >= 0 && lines.indexOf(first) + 1 === lines.indexOf(second);
  assert.ok(before(`page.once('dialog', dialog => dialog.dismiss());`, `await page.locator('#delete').click();`));
  assert.ok(before(`page.once('dialog', dialog => dialog.accept('O\\'Brien'));`, `await page.locator('#rename').click();`));
  assert.ok(before(`const page1Promise = page.waitForEvent('popup');`, `await page.locator('#report').click();`));
  assert.ok(before(`await page.locator('#report').click();`, `const page1 = await page1Promise;`));
  assert.ok(lines.includes(`await page1.locator('#print').click();`));
  // Run on Page cannot answer a dialog or follow a new tab: those lines are shown as not run.
  const steps = TestRunner.parse(code);
  assert.deepEqual(steps.filter((step) => step.action === 'skip').length, 4);
});

test('the address is checked after a step that leads to another page', () => {
  const code = PlaywrightCodegen.actionsToTest([
    { type: 'navigate', url: 'https://app.test/login' },
    { type: 'fill', ...at('#user'), value: 'a', url: 'https://app.test/login' },
    { type: 'click', ...at('#login'), url: 'https://app.test/login' },
    { type: 'click', ...at('#menu'), url: 'https://app.test/dashboard?tab=1' },
    { type: 'navigate', url: 'https://app.test/#/reports' },
    { type: 'click', ...at('#logout'), url: 'https://app.test/#/reports' },
    { type: 'hover', ...at('#title'), url: 'https://app.test/login' },
    { type: 'end', url: 'https://app.test/login' },
  ]);
  const lines = code.split('\n').map((line) => line.trim()).slice(3, -1);
  assert.deepEqual(lines, [
    `await page.goto('https://app.test/login');`,
    `await page.locator('#user').fill('a');`,
    `await page.locator('#login').click();`,
    `await expect(page).toHaveURL(/\\/dashboard/);`,
    `await page.locator('#menu').click();`,
    `await expect(page).toHaveURL(/#\\/reports/);`,
    `await page.locator('#logout').click();`,
    `await expect(page).toHaveURL(/\\/login/);`,
  ]);
  const check = TestRunner.parse(code).find((step) => step.action === 'assertURL');
  assert.equal(new RegExp(check.pattern, check.flags).test('https://app.test/dashboard?tab=1'), true);
});

test('a chain is read part by part: the row, then the button in it', () => {
  const [step] = TestRunner.parse(`await page.getByRole('row').filter({ hasText: 'Ada (admin)' }).getByRole('button', { name: 'Delete' }).click();`);
  assert.equal(step.action, 'click');
  assert.deepEqual([step.locator.method, step.locator.value, step.locator.hasText], ['getByRole', 'row', 'Ada (admin)']);
  assert.deepEqual(step.locator.then.map((part) => [part.method, part.value, part.name]), [['getByRole', 'button', 'Delete']]);
  // The value of a fill is not a part of the locator.
  const [fill] = TestRunner.parse(`await page.getByLabel('Name').fill('getByText(x)');`);
  assert.equal(fill.locator.then.length, 0);
  assert.equal(fill.value, 'getByText(x)');
});

test('the clicks that make up a double click, and the last choice of a list, are recorded once', () => {
  const types = (actions) => PlaywrightCodegen.normalizeActions(actions).map((a) => `${a.type} ${a.selector}${a.value ? `=${a.value}` : ''}`);
  assert.deepEqual(
    types([{ type: 'click', ...at('#a') }, { type: 'click', ...at('#row') }, { type: 'click', ...at('#row') }, { type: 'dblclick', ...at('#row') }]),
    ['click #a', 'dblclick #row'],
  );
  assert.deepEqual(
    types([{ type: 'select', ...at('#country'), value: 'be' }, { type: 'select', ...at('#country'), value: 'nl' }]),
    ['select #country=nl'],
  );
});

test('a drag and a file upload are shown as steps the page cannot run, a right click is read as one', () => {
  const steps = TestRunner.parse([
    `await page.locator('#card').dragTo(page.locator('#done'));`,
    `await page.locator('#file').setInputFiles('a.pdf');`,
    `await page.locator('#row').click({ button: 'right' });`,
    `await page.locator('#menu').hover();`,
  ].join('\n'));
  assert.deepEqual(steps.map((step) => step.action), ['skip', 'skip', 'click', 'hover']);
  assert.match(steps[0].label, /dragTo.*Run via Playwright/);
  assert.equal(steps[2].value, 'right');
});

test('a selector holding the other kind of quote is read whole', () => {
  const [step] = TestRunner.parse(`await page.locator('[data-test="username"]').click();`);
  assert.equal(step.action, 'click');
  assert.equal(step.locator.method, 'locator');
  assert.equal(step.locator.value, '[data-test="username"]');
});

test('fill keeps both the selector and the value', () => {
  const [step] = TestRunner.parse(`await page.locator('[data-test="password"]').fill('secret_sauce');`);
  assert.equal(step.action, 'fill');
  assert.equal(step.locator.value, '[data-test="password"]');
  assert.equal(step.value, 'secret_sauce');
});

test('a text selector is read whole', () => {
  const [step] = TestRunner.parse(`await page.locator('text="Add to cart"').click();`);
  assert.equal(step.locator.value, 'text="Add to cart"');
});

test('escaped quotes and brackets inside a string are kept', () => {
  const [step] = TestRunner.parse(`await page.getByText('It\\'s here (new)').click();`);
  assert.equal(step.locator.method, 'getByText');
  assert.equal(step.locator.value, "It's here (new)");
});

test('a role locator keeps its name', () => {
  const [step] = TestRunner.parse(`await page.getByRole('button', { name: 'Log "in"' }).click();`);
  assert.equal(step.locator.value, 'button');
  assert.equal(step.locator.name, 'Log "in"');
});

test('an assertion on an attribute selector keeps the selector and the expected text', () => {
  const [step] = TestRunner.parse(`await expect(page.locator('[data-test="title"]')).toHaveText('Products');`);
  assert.equal(step.action, 'assert');
  assert.equal(step.locator.value, '[data-test="title"]');
  assert.equal(step.expected, 'Products');
});

test('a click on the page background in an old recording is left out of the script', () => {
  const code = PlaywrightCodegen.actionsToTest([
    { type: 'navigate', url: 'https://www.saucedemo.com/' },
    { type: 'click', selector: 'text="// https://github.com/rafgraph/spa"', elementInfo: { tag: 'HTML' } },
    { type: 'click', selector: '#react-burger-menu-btn', locator: `locator('#react-burger-menu-btn')`, elementInfo: { tag: 'BUTTON' } },
  ]);
  assert.ok(!code.includes('rafgraph'));
  assert.deepEqual(TestRunner.parse(code).map((step) => step.action), ['goto', 'click']);
});

test('a recorded value with a quote survives code generation and parsing', () => {
  const code = PlaywrightCodegen.actionsToTest([
    { type: 'fill', selector: '#name', locator: `locator('#name')`, value: "O'Brien" }
  ]);
  const [step] = TestRunner.parse(code);
  assert.equal(step.action, 'fill');
  assert.equal(step.value, "O'Brien");
});
