import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TestRunner } from '../utils/test-runner.js';
import { PlaywrightCodegen } from '../utils/playwright-codegen.js';

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
