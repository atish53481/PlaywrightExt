import { AIProvider } from './base-provider.js';

const MOCK_RESPONSES = {
  planner: `# Test Strategy & Test Plan

## 1. Test Strategy
**Scope:** End-to-end functional, integration, and regression testing
**Approach:** Risk-based testing with automation-first mindset
**Tools:** Playwright, TypeScript, Page Object Model

## 2. Test Types

| Type | Priority | Coverage |
|------|----------|----------|
| Functional | High | Core user flows |
| Smoke | High | Happy path only |
| Regression | High | Full suite |
| Integration | Medium | API + UI |
| Negative | Medium | Error scenarios |
| Boundary | Low | Edge inputs |
| Exploratory | Low | Ad-hoc |

## 3. Functional Test Cases

### TC001 - Valid Login (Positive)
- **Precondition:** User account exists
- **Steps:** Navigate → Enter credentials → Click Login
- **Expected:** Redirect to dashboard, welcome message visible
- **Priority:** P1 | **Type:** Smoke, Regression

### TC002 - Invalid Password (Negative)
- **Steps:** Enter valid email + wrong password → Click Login
- **Expected:** Error message "Invalid credentials"
- **Priority:** P1 | **Type:** Regression

### TC003 - Empty Email Field (Boundary)
- **Steps:** Leave email blank → Click Login
- **Expected:** Validation message "Email is required"
- **Priority:** P2 | **Type:** Regression

### TC004 - SQL Injection in Email (Security)
- **Steps:** Enter ` + "'" + ` OR 1=1--` + "'" + ` in email → Submit
- **Expected:** Rejected with error, no DB exposure
- **Priority:** P1 | **Type:** Security

### TC005 - Forgot Password Flow
- **Steps:** Click "Forgot Password" → Enter email → Check inbox
- **Expected:** Reset email received within 2 minutes
- **Priority:** P2 | **Type:** Functional

### TC006 - Remember Me Persistence
- **Steps:** Login with "Remember Me" → Close browser → Reopen
- **Expected:** User remains logged in (session persists)
- **Priority:** P2 | **Type:** Functional

### TC007 - Concurrent Login Sessions
- **Steps:** Login from two browsers simultaneously
- **Expected:** Both sessions valid OR single-session policy enforced
- **Priority:** P2 | **Type:** Integration

## 4. Risk Areas
- Session token expiry handling
- Race conditions on rapid login clicks
- Password field masking bypass
- Account lockout after N failed attempts

## 5. Test Data Requirements
\`\`\`
Valid User:    user@example.com / Password123!
Invalid User:  noexist@example.com / wrongpass
Locked User:   locked@example.com / any
Admin User:    admin@example.com / Admin@2024
\`\`\`

## 6. Automation Candidates
- TC001, TC002, TC003 (all regression-ready)
- TC004 (security automation with OWASP ZAP)

## 7. Requirement Traceability Matrix

| Requirement | Test Cases | Status |
|-------------|-----------|--------|
| REQ-001: User can login | TC001 | Covered |
| REQ-002: Invalid login rejected | TC002, TC003 | Covered |
| REQ-003: Password security | TC004 | Covered |
| REQ-004: Remember Me | TC006 | Covered |`,

  generator_ts: `import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/LoginPage';
import { DashboardPage } from '../pages/DashboardPage';
import { TestData } from '../data/TestData';

test.describe('Login Tests', () => {
  let loginPage: LoginPage;
  let dashboardPage: DashboardPage;

  test.beforeEach(async ({ page }) => {
    loginPage = new LoginPage(page);
    dashboardPage = new DashboardPage(page);
    await loginPage.navigate();
  });

  test('TC001 - Valid login with correct credentials @smoke @regression', async ({ page }) => {
    await loginPage.login(TestData.validUser.email, TestData.validUser.password);
    await expect(page).toHaveURL('/dashboard');
    await expect(dashboardPage.welcomeMessage).toBeVisible();
    await expect(dashboardPage.welcomeMessage).toContainText(TestData.validUser.name);
  });

  test('TC002 - Invalid password shows error @regression', async () => {
    await loginPage.login(TestData.validUser.email, 'WrongPassword123');
    await expect(loginPage.errorMessage).toBeVisible();
    await expect(loginPage.errorMessage).toContainText('Invalid credentials');
  });

  test('TC003 - Empty email shows validation @regression', async () => {
    await loginPage.passwordInput.fill('Password123!');
    await loginPage.submitButton.click();
    await expect(loginPage.emailError).toBeVisible();
    await expect(loginPage.emailError).toContainText('Email is required');
  });

  test('TC004 - SQL injection rejected @security', async () => {
    await loginPage.login("' OR 1=1--", 'anything');
    await expect(loginPage.errorMessage).toBeVisible();
    await expect(page).not.toHaveURL('/dashboard');
  });
});`,

  generator_pom: `// pages/LoginPage.ts
import { Page, Locator } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;
  readonly errorMessage: Locator;
  readonly emailError: Locator;
  readonly forgotPasswordLink: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByRole('textbox', { name: 'Email' });
    this.passwordInput = page.getByRole('textbox', { name: 'Password' });
    this.submitButton = page.getByRole('button', { name: 'Login' });
    this.errorMessage = page.getByRole('alert');
    this.emailError = page.locator('[data-testid="email-error"]');
    this.forgotPasswordLink = page.getByRole('link', { name: 'Forgot Password' });
  }

  async navigate() {
    await this.page.goto('/login');
    await this.page.waitForLoadState('networkidle');
  }

  async login(email: string, password: string) {
    await this.emailInput.fill(email);
    await this.passwordInput.fill(password);
    await this.submitButton.click();
  }

  async forgotPassword(email: string) {
    await this.forgotPasswordLink.click();
    await this.page.getByRole('textbox', { name: 'Email' }).fill(email);
    await this.page.getByRole('button', { name: 'Send Reset Link' }).click();
  }
}`,

  healer: `## Test Healer Analysis Report

### Problem Identified
**Type:** Locator Failure — Element not found
**Confidence:** 94%

### Original Broken Locator
\`\`\`javascript
// ❌ Brittle CSS class locator — breaks on style changes
await page.locator('.btn-primary.submit-login').click();
\`\`\`

### Root Cause
The CSS class \`.btn-primary.submit-login\` was removed during a UI refactor. Classes are implementation details and should never be used as test locators.

### Suggested Fix
\`\`\`javascript
// ✅ Option 1 (Best): Role-based locator — semantic, resilient
await page.getByRole('button', { name: 'Login' }).click();

// ✅ Option 2: Test attribute — explicit test contract
await page.locator('[data-testid="login-submit"]').click();

// ✅ Option 3: ARIA label
await page.getByLabel('Submit login form').click();
\`\`\`

### Before vs After
| | Before | After |
|---|--------|-------|
| Locator | \`.btn-primary.submit-login\` | \`getByRole('button', { name: 'Login' })\` |
| Type | CSS class | Semantic role |
| Brittleness | High | Low |
| Confidence | N/A | 94% |

### Additional Suggestions
1. Add \`data-testid="login-submit"\` to the button element for explicit test contracts
2. Add \`await expect(submitButton).toBeEnabled()\` before clicking to catch loading states
3. Consider \`await page.waitForLoadState('networkidle')\` after login for stability

**Approve fix?** The healer will apply Option 1 unless you select a different option above.`,

  chat: `Great question! Here's how to test file upload in Playwright:

## Basic File Upload

\`\`\`typescript
test('file upload', async ({ page }) => {
  await page.goto('/upload');
  
  // Set input files directly (no dialog needed)
  await page.locator('input[type="file"]').setInputFiles('path/to/file.pdf');
  
  await page.getByRole('button', { name: 'Upload' }).click();
  await expect(page.getByText('Upload successful')).toBeVisible();
});
\`\`\`

## Multiple Files

\`\`\`typescript
await page.locator('input[type="file"]').setInputFiles([
  'tests/fixtures/file1.pdf',
  'tests/fixtures/file2.jpg'
]);
\`\`\`

## From Memory Buffer (no disk file needed)

\`\`\`typescript
await page.locator('input[type="file"]').setInputFiles({
  name: 'test.pdf',
  mimeType: 'application/pdf',
  buffer: Buffer.from('fake pdf content')
});
\`\`\`

## Drag-and-Drop Upload Zone

\`\`\`typescript
const dropZone = page.locator('.upload-dropzone');
const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
await dropZone.dispatchEvent('drop', { dataTransfer });
\`\`\`

## Wait for Upload Progress

\`\`\`typescript
await page.locator('input[type="file"]').setInputFiles('file.pdf');
await page.getByRole('button', { name: 'Upload' }).click();
await expect(page.locator('.progress-bar')).toHaveAttribute('aria-valuenow', '100', { timeout: 30000 });
await expect(page.getByText('Upload complete')).toBeVisible();
\`\`\`

Need help with a specific upload scenario? Paste your HTML and I'll generate the exact locator.`,

  inspector: `## Element Inspector Results

### Best Locator (Recommended)
\`\`\`javascript
page.getByRole('button', { name: 'Submit' })
\`\`\`
**Score: 95/100** — Semantic, accessible, resilient to DOM changes

### All Locator Options (Ranked)

| Rank | Strategy | Locator | Score |
|------|----------|---------|-------|
| 1 | Role | \`getByRole('button', { name: 'Submit' })\` | 95 |
| 2 | Test ID | \`locator('[data-testid="submit-btn"]')\` | 90 |
| 3 | Text | \`getByText('Submit')\` | 65 |
| 4 | CSS ID | \`locator('#submitButton')\` | 55 |
| 5 | CSS Class | \`locator('.btn-submit')\` | 20 |

### Element Details
- **Tag:** BUTTON
- **Type:** submit
- **Text:** Submit
- **ARIA role:** button
- **Visible:** true
- **Enabled:** true
- **In viewport:** true

### Accessibility
- Has ARIA role: ✅
- Has accessible name: ✅
- Keyboard focusable: ✅
- Color contrast: ✅ 4.8:1 (WCAG AA)`,

  framework: `## Framework Analysis Report

### Summary
**Quality Score: 72/100** — Good foundation, improvements recommended

### Detected Patterns
- ✅ Page Object Model (POM)
- ✅ TypeScript
- ✅ Fixtures
- ⚠️ Missing utility layer
- ❌ No API testing layer
- ❌ No visual testing

### Issues Found

| Severity | Issue | Count |
|----------|-------|-------|
| HIGH | Hardcoded test data in test files | 12 |
| HIGH | No centralized config (baseURL scattered) | 8 |
| MEDIUM | Magic timeouts (await page.waitForTimeout(3000)) | 5 |
| MEDIUM | Duplicate locators across page objects | 3 |
| LOW | Missing test tags (@smoke, @regression) | 23 |

### Recommendations

1. **Create TestData factory** — centralize all test data in \`data/\` directory
2. **Add API layer** — use \`page.request\` or separate APIContext for API tests
3. **Replace timeouts** — use \`waitForSelector\`, \`waitForResponse\`, or \`expect().toBeVisible()\`
4. **Add visual testing** — integrate \`@playwright/test\` visual snapshots
5. **Add reporting** — configure Allure or HTML reporter

### Generated Improvements
\`\`\`typescript
// playwright.config.ts — centralized config
export default defineConfig({
  baseURL: process.env.BASE_URL || 'http://localhost:3000',
  use: {
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    trace: 'on-first-retry',
  },
  reporter: [['html'], ['allure-playwright']],
});
\`\`\``,

  session: `## Browser Session Captured

**URL:** https://example.com
**Duration:** 00:01:34
**Actions captured:** 12
**API calls:** 8
**Screenshots:** 3

### Generated Playwright Test
\`\`\`typescript
import { test, expect } from '@playwright/test';

test('Recorded session - 2024-01-15', async ({ page }) => {
  // Navigate to application
  await page.goto('https://example.com');
  await expect(page).toHaveTitle('Example App');

  // Fill login form
  await page.getByRole('textbox', { name: 'Email' }).fill('user@example.com');
  await page.getByRole('textbox', { name: 'Password' }).fill('••••••••');
  await page.getByRole('button', { name: 'Login' }).click();

  // Verify dashboard loaded
  await expect(page).toHaveURL('/dashboard');
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();

  // Navigate to profile
  await page.getByRole('link', { name: 'Profile' }).click();
  await expect(page.getByRole('heading', { name: 'My Profile' })).toBeVisible();

  // Update display name
  await page.getByLabel('Display Name').clear();
  await page.getByLabel('Display Name').fill('John Doe');
  await page.getByRole('button', { name: 'Save Changes' }).click();
  await expect(page.getByText('Profile updated successfully')).toBeVisible();
});
\`\`\`

### Captured API Calls
| Method | URL | Status |
|--------|-----|--------|
| POST | /api/auth/login | 200 |
| GET | /api/user/profile | 200 |
| PUT | /api/user/profile | 200 |`
};

const MOCK_WARNING = `> ⚠️ **MOCK MODE — this is canned sample output. Your input was NOT used.**
> To generate real code from your requirements, open **Settings** → select **Claude / OpenAI / Gemini** → paste your API key → Save.

`;

export class MockProvider extends AIProvider {
  constructor() {
    super({ apiKey: 'mock', model: 'mock-gpt-playwright' });
    this.name = 'mock';
  }

  async complete({ system, prompt, maxTokens = 4000 }) {
    await new Promise(r => setTimeout(r, 800 + Math.random() * 700));

    const p = (prompt || '').toLowerCase();
    const s = (system || '').toLowerCase();
    return MOCK_WARNING + this._route(p, s);
  }

  _route(p, s) {
    // Route on the exact agent role declared in the SYSTEM prompt first — prompts
    // cross-reference other agents ("generator agent", "TODO(healer)") and the user
    // prompt contains phrases like "test plan", so loose keyword matching misroutes.
    const role = (s.match(/"(planner|generator|healer)" test agent/) || [])[1];
    if (role === 'generator') {
      const wantsPage = p.includes('page object') || p.includes('pom');
      return wantsPage ? `${MOCK_RESPONSES.generator_pom}\n\n${MOCK_RESPONSES.generator_ts}` : MOCK_RESPONSES.generator_ts;
    }
    if (role === 'planner') return MOCK_RESPONSES.planner;
    if (role === 'healer') return MOCK_RESPONSES.healer;
    if (s.includes('playwrightbot')) return MOCK_RESPONSES.chat; // chat agent — its prompt mentions "framework", would misroute below

    if (p.includes('test plan') || p.includes('test strategy') || p.includes('test cases')) {
      return MOCK_RESPONSES.planner;
    }
    if (p.includes('generate') || p.includes('playwright code') || p.includes('automation code')) {
      const wantsPage = p.includes('page object') || p.includes('pom');
      return wantsPage ? `${MOCK_RESPONSES.generator_pom}\n\n${MOCK_RESPONSES.generator_ts}` : MOCK_RESPONSES.generator_ts;
    }
    if (s.includes('healer') || p.includes('fix') || p.includes('broken') || p.includes('repair') || p.includes('failing test')) {
      return MOCK_RESPONSES.healer;
    }
    if (s.includes('inspector') || p.includes('locator') || p.includes('element') || p.includes('selector')) {
      return MOCK_RESPONSES.inspector;
    }
    if (s.includes('framework') || p.includes('framework') || p.includes('analyze') || p.includes('quality')) {
      return MOCK_RESPONSES.framework;
    }
    if (s.includes('session') || p.includes('session') || p.includes('recorded') || p.includes('capture')) {
      return MOCK_RESPONSES.session;
    }
    return MOCK_RESPONSES.chat;
  }

  isConfigured() { return true; }
}
