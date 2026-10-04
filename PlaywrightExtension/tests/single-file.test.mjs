import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toSingleFile } from '../utils/code-extract.js';

describe('toSingleFile', () => {
  it('drops the notice lines, the imports of inlined files, and merges package imports', () => {
    const generated = [
      '> ⚠️ **MOCK MODE — this is canned sample output.**',
      '> To generate real code, open Settings.',
      '',
      '// pages/LoginPage.ts',
      "import { Page, Locator } from '@playwright/test';",
      '',
      'export class LoginPage {',
      '  constructor(readonly page: Page) {}',
      '}',
      '',
      "import { test, expect, Page } from '@playwright/test';",
      "import { LoginPage } from '../pages/LoginPage';",
      "import { TestData } from './data/TestData';",
      '',
      "test('opens', async ({ page }) => {",
      '  await new LoginPage(page).page.goto(TestData.url);',
      '});',
    ].join('\n');

    assert.equal(
      toSingleFile(generated),
      [
        "import { Page, Locator, test, expect } from '@playwright/test';",
        '',
        '// pages/LoginPage.ts',
        '',
        'export class LoginPage {',
        '  constructor(readonly page: Page) {}',
        '}',
        '',
        "test('opens', async ({ page }) => {",
        '  await new LoginPage(page).page.goto(TestData.url);',
        '});',
      ].join('\n'),
    );
  });

  it('keeps imports it cannot merge, once each, and handles an import spread over lines', () => {
    const code = [
      "import fs from 'node:fs';",
      'import {',
      '  test,',
      '  expect,',
      "} from '@playwright/test';",
      "import fs from 'node:fs';",
      "import * as path from 'node:path';",
      "import { helper } from '../utils/helper';",
      "test('a', () => { expect(fs && path).toBeTruthy(); });",
    ].join('\n');
    assert.equal(
      toSingleFile(code),
      [
        "import fs from 'node:fs';",
        "import { test, expect } from '@playwright/test';",
        "import * as path from 'node:path';",
        '',
        "test('a', () => { expect(fs && path).toBeTruthy(); });",
      ].join('\n'),
    );
  });

  it('leaves a single-file script exactly as it is', () => {
    const recorded = "import { test, expect } from '@playwright/test';\n\ntest('a', async ({ page }) => {\n  await page.goto('https://example.com');\n});\n";
    assert.equal(toSingleFile(recorded), recorded);
    assert.equal(toSingleFile(''), '');
    assert.equal(toSingleFile(null), '');
  });

  it('removes only the notice at the top, not a quoted line further down', () => {
    const code = "import { test } from '@playwright/test';\nimport { a } from './a';\n\ntest('x', () => {\n  const s = `\n> quoted\n`;\n});";
    const out = toSingleFile(code);
    assert.ok(out.includes('> quoted'));
    assert.ok(!out.includes("from './a'"));
  });
});
