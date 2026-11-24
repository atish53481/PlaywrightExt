// Renders recorded actions as Playwright code (TypeScript / JavaScript / Python).
// Actions carry a structured locator chain (`loc`, built by content.js); older
// recordings only have the pre-rendered JS string (`locator`).

const jsStr = (s) => `'${String(s ?? '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
const pyStr = (s) => `"${String(s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, '\\n')}"`;

const PY_METHODS = {
  getByText: 'get_by_text', getByLabel: 'get_by_label', getByPlaceholder: 'get_by_placeholder',
  getByAltText: 'get_by_alt_text', getByTitle: 'get_by_title',
};

function segToJs(seg) {
  switch (seg.m) {
    case 'getByRole':
      return `getByRole(${jsStr(seg.role)}${seg.name ? `, { name: ${jsStr(seg.name.text)}${seg.name.exact ? ', exact: true' : ''} }` : ''})`;
    case 'getByTestId': return `getByTestId(${jsStr(seg.id)})`;
    case 'locator': return `locator(${jsStr(seg.selector)})`;
    case 'nth': return seg.index === 0 ? 'first()' : seg.index === -1 ? 'last()' : `nth(${seg.index})`;
    case 'filter': return `filter({ hasText: ${jsStr(seg.hasText.text)} })`;
    default: return `${seg.m}(${jsStr(seg.text.text)}${seg.text.exact ? ', { exact: true }' : ''})`;
  }
}

function segToPy(seg) {
  switch (seg.m) {
    case 'getByRole':
      return `get_by_role(${pyStr(seg.role)}${seg.name ? `, name=${pyStr(seg.name.text)}${seg.name.exact ? ', exact=True' : ''}` : ''})`;
    case 'getByTestId': return `get_by_test_id(${pyStr(seg.id)})`;
    case 'locator': return `locator(${pyStr(seg.selector)})`;
    case 'nth': return seg.index === 0 ? 'first' : seg.index === -1 ? 'last' : `nth(${seg.index})`;
    case 'filter': return `filter(has_text=${pyStr(seg.hasText.text)})`;
    default: return `${PY_METHODS[seg.m]}(${pyStr(seg.text.text)}${seg.text.exact ? ', exact=True' : ''})`;
  }
}

export const PlaywrightCodegen = {

  // "page.<locator>" for an action, in the target language
  locatorCode(a, language = 'typescript') {
    const py = language === 'python';
    if (Array.isArray(a.loc) && a.loc.length) return 'page.' + a.loc.map(py ? segToPy : segToJs).join('.');
    if (a.locator && !py) return `page.${a.locator}`;
    return py ? `page.locator(${pyStr(a.selector)})` : `page.locator(${jsStr(a.selector)})`;
  },

  actionToCode(action, language = 'typescript') {
    return language === 'python' ? this.actionToPython(action) : this.actionToJs(action);
  },

  actionToJs(a) {
    const L = () => this.locatorCode(a, 'typescript');
    const hasEl = !!(a.loc || a.locator || a.selector);
    switch (a.type) {
      case 'navigate':      return `await page.goto(${jsStr(a.url)});`;
      case 'click':         return `await ${L()}.click();`;
      case 'dblclick':      return `await ${L()}.dblclick();`;
      case 'fill':          return `await ${L()}.fill(${jsStr(a.value)});`;
      case 'clear':         return `await ${L()}.clear();`;
      case 'press':         return hasEl ? `await ${L()}.press(${jsStr(a.key)});` : `await page.keyboard.press(${jsStr(a.key)});`;
      case 'type':          return `await page.keyboard.type(${jsStr(a.text)});`;
      case 'select':        return `await ${L()}.selectOption(${jsStr(a.value)});`;
      case 'check':         return `await ${L()}.check();`;
      case 'uncheck':       return `await ${L()}.uncheck();`;
      case 'hover':         return `await ${L()}.hover();`;
      case 'focus':         return `await ${L()}.focus();`;
      case 'upload':        return `await ${L()}.setInputFiles(${jsStr(a.file)});`;
      case 'screenshot':    return `await page.screenshot({ path: 'screenshot.png'${a.fullPage ? ', fullPage: true' : ''} });`;
      case 'wait':          return hasEl ? `await ${L()}.waitFor();` : `await page.waitForLoadState('networkidle');`;
      case 'assertVisible': return `await expect(${L()}).toBeVisible();`;
      case 'assertText':    return `await expect(${L()}).toContainText(${jsStr(a.value)});`;
      case 'assertValue':   return `await expect(${L()}).toHaveValue(${jsStr(a.value)});`;
      case 'assertChecked': return `await expect(${L()})${a.checked === false ? '.not' : ''}.toBeChecked();`;
      case 'assertUrl':     return `await expect(page).toHaveURL(${jsStr(a.url)});`;
      case 'assertTitle':   return `await expect(page).toHaveTitle(${jsStr(a.title)});`;
      default:              return `// Unknown action: ${a.type}`;
    }
  },

  actionToPython(a) {
    const L = () => this.locatorCode(a, 'python');
    const hasEl = !!(a.loc || a.locator || a.selector);
    switch (a.type) {
      case 'navigate':      return `page.goto(${pyStr(a.url)})`;
      case 'click':         return `${L()}.click()`;
      case 'dblclick':      return `${L()}.dblclick()`;
      case 'fill':          return `${L()}.fill(${pyStr(a.value)})`;
      case 'clear':         return `${L()}.clear()`;
      case 'press':         return hasEl ? `${L()}.press(${pyStr(a.key)})` : `page.keyboard.press(${pyStr(a.key)})`;
      case 'type':          return `page.keyboard.type(${pyStr(a.text)})`;
      case 'select':        return `${L()}.select_option(${pyStr(a.value)})`;
      case 'check':         return `${L()}.check()`;
      case 'uncheck':       return `${L()}.uncheck()`;
      case 'hover':         return `${L()}.hover()`;
      case 'focus':         return `${L()}.focus()`;
      case 'upload':        return `${L()}.set_input_files(${pyStr(a.file)})`;
      case 'screenshot':    return `page.screenshot(path="screenshot.png"${a.fullPage ? ', full_page=True' : ''})`;
      case 'wait':          return hasEl ? `${L()}.wait_for()` : `page.wait_for_load_state("networkidle")`;
      case 'assertVisible': return `expect(${L()}).to_be_visible()`;
      case 'assertText':    return `expect(${L()}).to_contain_text(${pyStr(a.value)})`;
      case 'assertValue':   return `expect(${L()}).to_have_value(${pyStr(a.value)})`;
      case 'assertChecked': return `expect(${L()}).${a.checked === false ? 'not_to_be_checked' : 'to_be_checked'}()`;
      case 'assertUrl':     return `expect(page).to_have_url(${pyStr(a.url)})`;
      case 'assertTitle':   return `expect(page).to_have_title(${pyStr(a.title)})`;
      default:              return `# Unknown action: ${a.type}`;
    }
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

  // Flags clicks whose text implies a prior state-change (Remove/Delete/Cancel/...)
  // with no earlier action in the same recording suggesting that state was created
  // (Add/Create/Enable/...). Heuristic, not semantic — flags recordings that are
  // likely to fail on a fresh run because a setup step was never captured.
  detectRiskyActions(actions) {
    // Deliberately narrow to object create/destroy pairs — generic form/session
    // words (login, submit, confirm, save...) appear in nearly every recording
    // and would neuter detection if included (verified via self-test).
    const REMOVAL_WORDS = ['remove', 'delete', 'cancel', 'undo', 'disable', 'unsubscribe'];
    const CREATION_WORDS = ['add', 'create', 'enable', 'subscribe'];
    const textOf = (a) => {
      if (a.text) return a.text.toLowerCase();
      const m = /^text="(.*)"$/.exec(a.selector || ''); // recordings made before structured locators
      return (m ? m[1] : a.value || a.selector || '').toLowerCase();
    };

    const risky = [];
    actions.forEach((a, i) => {
      if (a.type !== 'click') return;
      const text = textOf(a);
      if (!text || text.length > 40) return;
      if (!REMOVAL_WORDS.some(w => text.includes(w))) return;
      const hasEarlierCreation = actions.slice(0, i).some(prior => CREATION_WORDS.some(w => textOf(prior).includes(w)));
      if (!hasEarlierCreation) {
        risky.push({ index: i, action: a, reason: `click "${text}" looks state-dependent but no earlier action in this recording suggests that state was created` });
      }
    });
    return risky;
  },

  actionsToTest(actions, testName = 'Recorded test', language = 'typescript') {
    const list = this.normalizeActions(actions);
    if (language === 'python') {
      const fn = 'test_' + (testName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'recorded');
      const body = list.map(a => `    ${this.actionToPython(a)}`).join('\n') || '    pass';
      return `from playwright.sync_api import Page, expect\n\n\ndef ${fn}(page: Page) -> None:\n${body}\n`;
    }
    const header = language === 'typescript'
      ? `import { test, expect } from '@playwright/test';`
      : `const { test, expect } = require('@playwright/test');`;
    const body = list.map(a => `  ${this.actionToJs(a)}`).join('\n');
    return `${header}\n\ntest(${jsStr(testName)}, async ({ page }) => {\n${body}\n});`;
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
