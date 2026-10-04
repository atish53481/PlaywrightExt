import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { failureText, playwrightOutcome, runUntilPassing } from '../utils/heal-run.js';

const FENCE = '`'.repeat(3);
const GOOD = `import { test, expect } from '@playwright/test';\n\ntest('a', async ({ page }) => {\n  await page.locator('#ok').click();\n});`;
const BAD = GOOD.replace('#ok', '#wrong');
// A healer's answer: a report with the complete fixed file in a fenced block.
const report = (code) => `## Root cause\nWrong locator.\n\n${FENCE}typescript\n${code}\n${FENCE}\n`;
const PASSED = { output: 'Running 1 test\n  1 passed (2.1s)\n', exitCode: 0 };
const FAILED = { output: 'Running 1 test\n  1) a\n    Error: locator(\'#wrong\') not found\n  1 failed\n', exitCode: 1 };

describe('how a Playwright run ended', () => {
  it('is read from the exit code and the counts the runner prints', () => {
    assert.equal(playwrightOutcome('  3 passed (4.0s)', 0), 'passed');
    assert.equal(playwrightOutcome('  1 failed\n  2 passed (4.0s)', 1), 'failed');
    assert.equal(playwrightOutcome('Error: Cannot find module \'../pages/LoginPage\'', 1), 'failed');
    // A test the healer switched off did not pass: nothing ran.
    assert.equal(playwrightOutcome('  1 skipped', 0), 'skipped');
    assert.equal(playwrightOutcome('  1 skipped\n  2 passed (3s)', 0), 'passed');
    // The runner colours its output.
    assert.equal(playwrightOutcome('  \u001b[32m1 passed\u001b[39m (1s)', 0), 'passed');
  });

  it('gives the healer the end of the output, without colour codes', () => {
    assert.equal(failureText('\u001b[31mError: boom\u001b[39m\n'), 'Error: boom');
    assert.equal(failureText(`${'x'.repeat(9000)}END`).length, 6000);
    assert.ok(failureText(`${'x'.repeat(9000)}END`).endsWith('END'));
  });
});

describe('running a test until it passes', () => {
  it('runs once when the test passes, and asks no healer', async () => {
    let healed = 0;
    const result = await runUntilPassing({ code: GOOD, run: async () => PASSED, heal: async () => { healed += 1; return ''; } });
    assert.deepEqual(result, { outcome: 'passed', code: GOOD, heals: 0, reason: '' });
    assert.equal(healed, 0);
  });

  it('has a failed test fixed and runs the fix, and reports the code that passed', async () => {
    const runs = [];
    const asked = [];
    const snapshot = '# Page snapshot\n- button "OK" [ref=e2]';
    const result = await runUntilPassing({
      code: BAD,
      run: async (code) => { runs.push(code); return code.includes('#ok') ? PASSED : { ...FAILED, pageContext: snapshot }; },
      heal: async (code, error, context) => { asked.push({ code, error, context }); return report(GOOD); },
    });
    assert.deepEqual(result, { outcome: 'passed', code: GOOD, heals: 1, reason: '' });
    assert.deepEqual(runs, [BAD, GOOD]);
    assert.equal(asked[0].code, BAD);
    assert.match(asked[0].error, /#wrong.*not found/);
    // The healer is shown the page as Playwright saw it, and told to write one file.
    assert.match(asked[0].context, /ONE self-contained spec file/);
    assert.match(asked[0].context, /button "OK"/);
  });

  it('stops after the tries it is given, and never calls a failed test passed', async () => {
    let n = 0;
    const events = [];
    const result = await runUntilPassing({
      code: BAD,
      run: async () => FAILED,
      // Each fix is told which one it is, so a later one can be done by a stronger healer.
      heal: async (code, error, context, attempt) => { n += 1; assert.equal(attempt, n); return report(BAD.replace('#wrong', `#wrong${n}`)); },
      maxHeals: 2,
      onEvent: (event) => events.push(`${event.type} ${event.attempt}`),
    });
    assert.equal(result.outcome, 'failed');
    assert.equal(result.heals, 2);
    assert.deepEqual(events, ['run 1', 'heal 1', 'run 2', 'heal 2', 'run 3']);
  });

  it('gives up when the healer has nothing new, cannot be reached, or there is none', async () => {
    const same = await runUntilPassing({ code: BAD, run: async () => FAILED, heal: async () => report(BAD) });
    assert.equal(same.outcome, 'failed');
    assert.match(same.reason, /no changed test/);
    const none = await runUntilPassing({ code: BAD, run: async () => FAILED, heal: async () => 'I cannot tell.' });
    assert.match(none.reason, /no changed test/);
    const down = await runUntilPassing({ code: BAD, run: async () => FAILED, heal: async () => { throw new Error('API key missing'); } });
    assert.match(down.reason, /API key missing/);
    const alone = await runUntilPassing({ code: BAD, run: async () => FAILED });
    assert.deepEqual(alone, { outcome: 'failed', code: BAD, heals: 0, reason: '' });
  });

  it('reports a test the healer switched off as skipped, not passed', async () => {
    const skipped = GOOD.replace("test('a'", "test.skip('a'");
    const result = await runUntilPassing({
      code: BAD,
      run: async (code) => (code.includes('test.skip') ? { output: '  1 skipped', exitCode: 0 } : FAILED),
      heal: async () => report(skipped),
    });
    assert.equal(result.outcome, 'skipped');
    assert.equal(result.heals, 1);
  });

  it('runs page classes and the tests that import them as the one file the runner is given', async () => {
    const answer = [
      FENCE + 'typescript', `import { Page } from '@playwright/test';`, 'export class LoginPage { constructor(readonly page: Page) {} }', FENCE,
      FENCE + 'typescript', `import { test, expect } from '@playwright/test';`, `import { LoginPage } from '../pages/LoginPage';`, `test('a', async ({ page }) => { new LoginPage(page); });`, FENCE,
    ].join('\n');
    let given = '';
    await runUntilPassing({ code: answer, run: async (code) => { given = code; return PASSED; } });
    assert.ok(!given.includes('../pages/LoginPage'));
    assert.ok(!given.includes(FENCE));
    assert.equal(given.match(/from '@playwright\/test'/g).length, 1);
    assert.match(given, /class LoginPage/);
  });
});
