export const PlaywrightCodegen = {
  actionToCode(action, language = 'typescript') {
    const map = {
      navigate:    a => `await page.goto('${a.url}');`,
      click:       a => `await page.${a.locator || `locator('${a.selector}')`}.click();`,
      fill:        a => `await page.${a.locator || `locator('${a.selector}')`}.fill('${a.value || ''}');`,
      clear:       a => `await page.${a.locator || `locator('${a.selector}')`}.clear();`,
      press:       a => `await page.keyboard.press('${a.key}');`,
      type:        a => `await page.keyboard.type('${a.text}');`,
      select:      a => `await page.${a.locator || `locator('${a.selector}')`}.selectOption('${a.value}');`,
      check:       a => `await page.${a.locator || `locator('${a.selector}')`}.check();`,
      uncheck:     a => `await page.${a.locator || `locator('${a.selector}')`}.uncheck();`,
      hover:       a => `await page.${a.locator || `locator('${a.selector}')`}.hover();`,
      focus:       a => `await page.${a.locator || `locator('${a.selector}')`}.focus();`,
      screenshot:  a => `await page.screenshot({ path: 'screenshot.png'${a.fullPage ? ', fullPage: true' : ''} });`,
      wait:        a => a.selector ? `await page.waitForSelector('${a.selector}');` : `await page.waitForLoadState('networkidle');`,
      assertText:  a => `await expect(page.${a.locator || `locator('${a.selector}')`}).toContainText('${a.value}');`,
      assertUrl:   a => `await expect(page).toHaveURL('${a.url}');`,
      assertTitle: a => `await expect(page).toHaveTitle('${a.title}');`,
      upload:      a => `await page.${a.locator || `locator('${a.selector}')`}.setInputFiles('${a.file}');`,
    };
    const fn = map[action.type];
    return fn ? fn(action) : `// Unknown action: ${action.type}`;
  },

  // Recording fires one 'fill' per keystroke — keep only the final value per field
  normalizeActions(actions) {
    const normalized = [];
    for (const a of actions) {
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
