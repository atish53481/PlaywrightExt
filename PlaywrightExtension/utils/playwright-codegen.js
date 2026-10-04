// A recorded value goes inside '...' in the generated code.
const q = (value) => String(value ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n');
const loc = (a) => a.locator || `locator('${q(a.selector)}')`;

export const PlaywrightCodegen = {
  actionToCode(action, language = 'typescript', p = 'page') {
    const map = {
      navigate:    a => `await ${p}.goto('${q(a.url)}');`,
      reload:      () => `await ${p}.reload();`,
      goBack:      () => `await ${p}.goBack();`,
      click:       a => `await ${p}.${loc(a)}.click();`,
      fill:        a => `await ${p}.${loc(a)}.fill('${q(a.value)}');`,
      clear:       a => `await ${p}.${loc(a)}.clear();`,
      press:       a => `await ${p}.keyboard.press('${q(a.key)}');`,
      type:        a => `await ${p}.keyboard.type('${q(a.text)}');`,
      select:      a => `await ${p}.${loc(a)}.selectOption('${q(a.value)}');`,
      check:       a => `await ${p}.${loc(a)}.check();`,
      uncheck:     a => `await ${p}.${loc(a)}.uncheck();`,
      hover:       a => `await ${p}.${loc(a)}.hover();`,
      dblclick:    a => `await ${p}.${loc(a)}.dblclick();`,
      rightClick:  a => `await ${p}.${loc(a)}.click({ button: 'right' });`,
      drag:        a => `await ${p}.${loc(a)}.dragTo(${p}.${loc(a.target || {})});`,
      focus:       a => `await ${p}.${loc(a)}.focus();`,
      screenshot:  a => `await ${p}.screenshot({ path: 'screenshot.png'${a.fullPage ? ', fullPage: true' : ''} });`,
      wait:        a => a.selector ? `await ${p}.waitForSelector('${q(a.selector)}');` : `await ${p}.waitForLoadState('networkidle');`,
      assertText:  a => `await expect(${p}.${loc(a)}).toContainText('${q(a.value)}');`,
      assertUrl:   a => `await expect(${p}).toHaveURL('${q(a.url)}');`,
      assertTitle: a => `await expect(${p}).toHaveTitle('${q(a.title)}');`,
      // Only the names of the chosen files are known; the test needs their paths.
      upload:      a => {
        const files = Array.isArray(a.files) && a.files.length > 0 ? a.files : [a.file];
        const list = files.map(file => `'${q(file)}'`).join(', ');
        return `await ${p}.${loc(a)}.setInputFiles(${files.length > 1 ? `[${list}]` : list});`;
      },
    };
    const fn = map[action.type];
    return fn ? fn(action) : `// Unknown action: ${action.type}`;
  },

  // Recording fires one 'fill' per keystroke — keep only the final value per field.
  // A click on the page background (<html> or <body>) is dropped: it does nothing a test
  // could repeat. The recorder no longer records one, but a recording saved earlier may hold one.
  // A hover on the element the next step acts on adds nothing, and the two clicks a double
  // click is made of are not steps of their own. Nor is the click that puts the caret in a
  // field before it is filled: fill() focuses the field. A hover is a step only for what it
  // brings out, so one that the page is left after, or that the recording ends on, is dropped.
  normalizeActions(actions) {
    const normalized = [];
    const last = () => normalized[normalized.length - 1];
    for (const a of actions) {
      if (a.type === 'click' && ['HTML', 'BODY'].includes(a.elementInfo?.tag)) continue;
      if (a.selector && last()?.type === 'hover' && last().selector === a.selector) normalized.pop();
      if (['navigate', 'reload', 'goBack', 'end'].includes(a.type) && last()?.type === 'hover') normalized.pop();
      if (a.type === 'dblclick') {
        for (let n = 0; n < 2 && last()?.type === 'click' && last().selector === a.selector; n += 1) normalized.pop();
      }
      if (['fill', 'select'].includes(a.type) && last()?.type === 'click' && last().selector === a.selector) normalized.pop();
      const prev = last();
      if (['fill', 'select'].includes(a.type) && prev?.type === a.type && prev.selector === a.selector) {
        normalized[normalized.length - 1] = a;
      } else {
        normalized.push(a);
      }
    }
    if (last()?.type === 'hover') normalized.pop();
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
    const body = this.stepLines(this.normalizeActions(actions), language).map(line => `  ${line}`).join('\n');
    return `${header}\n${body}\n});`;
  },

  // The lines of the test, one step after the other, with what a tester adds around a step:
  // the answer to a dialog and the wait for a new tab before the step that brings them up,
  // and a check of the address after a step that leads to another page.
  stepLines(steps, language = 'typescript') {
    const lines = [];
    const pageOf = (a) => (a.page ? `page${a.page}` : 'page');
    // The part of an address that says which page it is: the path, and the route after a #.
    const place = (url) => {
      try {
        const { pathname, hash } = new URL(url);
        return pathname + (hash.startsWith('#/') ? hash.split('?')[0] : '');
      } catch { return ''; }
    };
    const urlCheck = (a, url) => {
      // A route after a # tells the page by itself; the path before it is the same on every route.
      const at = place(url).includes('#/') ? place(url).slice(place(url).indexOf('#/')) : place(url);
      // The first page of a site has no path to tell it by: its whole address is asked for.
      const wanted = at.length > 1 ? `/${at.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/` : `'${q(url)}'`;
      return `await expect(${pageOf(a)}).toHaveURL(${wanted});`;
    };
    const around = ['dialog', 'popup'];

    steps.forEach((a, i) => {
      // 'end' is where the tab was when the recording stopped: it is there for the check after the last step.
      if (around.includes(a.type) || a.type === 'end') return;
      const p = pageOf(a);
      // A page that changes its address without loading (a route of a single-page app) was
      // brought there by the step before: the address is checked, not gone to.
      if (a.type === 'navigate' && i > 0) { lines.push(urlCheck(a, a.url)); return; }

      const next = steps[i + 1];
      if (next?.type === 'dialog') {
        const answer = !next.accept ? 'dialog.dismiss()' : next.text ? `dialog.accept('${q(next.text)}')` : 'dialog.accept()';
        lines.push(`${p}.once('dialog', dialog => ${answer});`);
      }
      if (next?.type === 'popup') lines.push(`const page${next.opened}Promise = ${p}.waitForEvent('popup');`);
      lines.push(this.actionToCode(a, language, p));
      if (next?.type === 'popup') lines.push(`const page${next.opened} = await page${next.opened}Promise;`);

      // The next step on the same tab happened at another address: this step led there.
      const after = steps.slice(i + 1).find(s => !around.includes(s.type) && (s.page || 0) === (a.page || 0));
      if (after && after.type !== 'navigate' && a.url && after.url && place(a.url) !== place(after.url)
        && ['click', 'dblclick', 'press', 'select', 'check', 'uncheck'].includes(a.type)) {
        lines.push(urlCheck(a, after.url));
      }
    });
    return lines;
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
