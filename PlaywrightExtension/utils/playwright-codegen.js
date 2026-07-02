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

  actionsToTest(actions, testName = 'Recorded test', language = 'typescript') {
    const header = language === 'typescript'
      ? `import { test, expect } from '@playwright/test';\n\ntest('${testName}', async ({ page }) => {`
      : `const { test, expect } = require('@playwright/test');\n\ntest('${testName}', async ({ page }) => {`;
    const body = actions.map(a => `  ${this.actionToCode(a, language)}`).join('\n');
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
