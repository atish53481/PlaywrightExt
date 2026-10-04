// A recorded value goes inside '...' in the generated code.
const q = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
const loc = (a) => a.locator || `locator('${q(a.selector)}')`;

export const PlaywrightCodegen = {
  actionToCode(action, language = 'typescript') {
    const map = {
      navigate:    a => `await page.goto('${q(a.url)}');`,
      click:       a => `await page.${loc(a)}.click();`,
      fill:        a => `await page.${loc(a)}.fill('${q(a.value)}');`,
      clear:       a => `await page.${loc(a)}.clear();`,
      press:       a => `await page.keyboard.press('${q(a.key)}');`,
      type:        a => `await page.keyboard.type('${q(a.text)}');`,
      select:      a => `await page.${loc(a)}.selectOption('${q(a.value)}');`,
      check:       a => `await page.${loc(a)}.check();`,
      uncheck:     a => `await page.${loc(a)}.uncheck();`,
      hover:       a => `await page.${loc(a)}.hover();`,
      focus:       a => `await page.${loc(a)}.focus();`,
      screenshot:  a => `await page.screenshot({ path: 'screenshot.png'${a.fullPage ? ', fullPage: true' : ''} });`,
      wait:        a => a.selector ? `await page.waitForSelector('${q(a.selector)}');` : `await page.waitForLoadState('networkidle');`,
      assertText:  a => `await expect(page.${loc(a)}).toContainText('${q(a.value)}');`,
      assertUrl:   a => `await expect(page).toHaveURL('${q(a.url)}');`,
      assertTitle: a => `await expect(page).toHaveTitle('${q(a.title)}');`,
      upload:      a => `await page.${loc(a)}.setInputFiles('${q(a.file)}');`,
    };
    const fn = map[action.type];
    return fn ? fn(action) : `// Unknown action: ${action.type}`;
  },

  // Recording fires one 'fill' per keystroke — keep only the final value per field.
  // A click on the page background (<html> or <body>) is dropped: it does nothing a test
  // could repeat. The recorder no longer records one, but a recording saved earlier may hold one.
  normalizeActions(actions) {
    const normalized = [];
    for (const a of actions) {
      if (a.type === 'click' && ['HTML', 'BODY'].includes(a.elementInfo?.tag)) continue;
      const prev = normalized[normalized.length - 1];
      if (a.type === 'fill' && prev?.type === 'fill' && prev.selector === a.selector) {
        normalized[normalized.length - 1] = a;
      } else {
        normalized.push(a);
      }
    }
    return normalized;
  },

  // Flags clicks that fell back to a bare text="..." locator (no id/data-testid/
  // aria-label/placeholder/name was available — see content.js getBestLocatorText)
  // whose text implies a prior state-change (Remove/Delete/Cancel/...) with no
  // earlier action in the same recording suggesting that state was created
  // (Add/Create/Enable/...). Heuristic, not semantic — flags recordings that are
  // likely to fail on a fresh run because a setup step was never captured.
  detectRiskyActions(actions) {
    // Deliberately narrow to object create/destroy pairs — generic form/session
    // words (login, submit, confirm, save...) appear in nearly every recording
    // and would neuter detection if included (verified via self-test).
    const REMOVAL_WORDS = ['remove', 'delete', 'cancel', 'undo', 'disable', 'unsubscribe'];
    const CREATION_WORDS = ['add', 'create', 'enable', 'subscribe'];
    const textOf = (a) => {
      const m = /^text="(.*)"$/.exec(a.selector || '');
      return (m ? m[1] : a.value || a.selector || '').toLowerCase();
    };

    const risky = [];
    actions.forEach((a, i) => {
      if (a.type !== 'click') return;
      const m = /^text="(.*)"$/.exec(a.selector || '');
      if (!m) return;
      const text = m[1].toLowerCase();
      if (!REMOVAL_WORDS.some(w => text.includes(w))) return;
      const hasEarlierCreation = actions.slice(0, i).some(prior => CREATION_WORDS.some(w => textOf(prior).includes(w)));
      if (!hasEarlierCreation) {
        risky.push({ index: i, action: a, reason: `click text="${m[1]}" looks state-dependent but no earlier action in this recording suggests that state was created` });
      }
    });
    return risky;
  },

  actionsToTest(actions, testName = 'Recorded test', language = 'typescript') {
    const header = language === 'typescript'
      ? `import { test, expect } from '@playwright/test';\n\ntest('${testName}', async ({ page }) => {`
      : `const { test, expect } = require('@playwright/test');\n\ntest('${testName}', async ({ page }) => {`;
    const body = this.normalizeActions(actions).map(a => `  ${this.actionToCode(a, language)}`).join('\n');
    return `${header}\n${body}\n});`;
  },

  generatePOMClass(pageName, locators, language = 'typescript') {
    const className = pageName.replace(/\s+/g, '') + 'Page';
    if (language === 'typescript') {
      const props = locators.map(l => `  readonly ${l.name}: Locator;`).join('\n');
      const inits = locators.map(l => `    this.${l.name} = page.${l.locator};`).join('\n');
      return `import { Page, Locator } from '@playwright/test';\n\nexport class ${className} {\n  readonly page: Page;\n${props}\n\n  constructor(page: Page) {\n    this.page = page;\n${inits}\n  }\n\n  async navigate() {\n    await this.page.goto('/');\n  }\n}`;
    }
    return `class ${className} {\n  constructor(page) {\n    this.page = page;\n${locators.map(l => `    this.${l.name} = page.${l.locator};`).join('\n')}\n  }\n}`;
  }
};
