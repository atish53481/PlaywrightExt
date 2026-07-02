import { BaseAgent } from './base-agent.js';

const LANG_TEMPLATES = {
  typescript: { ext: 'ts', import: `import { test, expect } from '@playwright/test';` },
  javascript: { ext: 'js', import: `const { test, expect } = require('@playwright/test');` },
  python:     { ext: 'py', import: `from playwright.sync_api import sync_playwright, expect` },
  java:       { ext: 'java', import: `import com.microsoft.playwright.*;` },
  csharp:     { ext: 'cs', import: `using Microsoft.Playwright;` },
};

// Maps to the official Playwright 🎭 generator agent (playwright.dev/docs/test-agents):
// transforms a Markdown plan (specs/*.md) into an executable test suite under tests/,
// one test per scenario, verified against the live page by the extension's Run on Page.
export class TestGeneratorAgent extends BaseAgent {
  constructor(provider) {
    super('Test Generator', provider);
  }

  buildSystemPrompt(language, framework) {
    return `You are the Playwright "generator" test agent (see playwright.dev/docs/test-agents).
Your job: transform a Markdown test plan (specs/*.md) into a runnable ${language} Playwright test suite.

Conventions (match official Playwright test-agents layout):
- Tests go in tests/<spec-name>.spec.${LANG_TEMPLATES[language]?.ext || 'ts'} — start each file with a comment: // File: tests/<name>.spec.${LANG_TEMPLATES[language]?.ext || 'ts'}
- Page objects (if requested) go in pages/<Name>Page.${LANG_TEMPLATES[language]?.ext || 'ts'} with the same // File: header
- Exactly ONE test() per plan scenario, same order and names as the plan (keep scenario numbers/tags in test titles)
- Put the plan's Seed setup into test.beforeEach or a seed fixture
- Framework pattern: ${framework === 'pom' ? 'Page Object Model' : framework}

Locator rules:
- Prefer getByRole with accessible name, then getByLabel, getByPlaceholder, getByTestId
- Never CSS classes or XPath unless nothing else exists
- Every scenario's Expected Results become expect() assertions — no assertion-free tests
- Use web-first assertions (toBeVisible, toHaveURL, toContainText); never waitForTimeout

Output complete, runnable code files. If a step cannot be automated, add a // TODO(healer): comment instead of inventing selectors.`;
  }

  async run({ testPlan, language = 'typescript', framework = 'pom', options = {} }) {
    const systemPrompt = this.buildSystemPrompt(language, framework);
    const prompt = `Transform this test plan (specs/*.md) into a complete Playwright ${language} test suite.

**Language:** ${language}
**Pattern:** ${framework}
**Generate:** ${options.generatePOM !== false ? 'Page Objects + ' : ''}Test Files${options.fixtures ? ' + Fixtures' : ''}${options.utilities ? ' + Utilities' : ''}

**Test Plan (specs/*.md):**
${testPlan}

Output the tests/ and pages/ files with // File: headers, one test per scenario, seed setup in beforeEach, web-first assertions.`;

    const result = await this.provider.complete({ system: systemPrompt, prompt, maxTokens: 8000 });
    this.record({ language, framework }, result);
    return result;
  }
}
