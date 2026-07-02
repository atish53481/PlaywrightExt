import { BaseAgent } from './base-agent.js';

// Maps to the official Playwright 🎭 healer agent (playwright.dev/docs/test-agents):
// takes a failing test, replays/diagnoses the failure, patches the test —
// or marks it test.skip() when the app functionality itself is broken.
export class TestHealerAgent extends BaseAgent {
  constructor(provider) {
    super('Test Healer', provider);
  }

  buildSystemPrompt() {
    return `You are the Playwright "healer" test agent (see playwright.dev/docs/test-agents).
Given a failing test, you replay the failure mentally, diagnose the root cause, and repair the test.

Healing protocol:
1. Root cause: locator failure, timing, DOM change, navigation change, data change, or genuine app bug
2. If the TEST is wrong → output the fully patched test file (complete, runnable)
3. If the APP functionality is actually broken → mark the test with test.skip() (or test.fixme()) and explain — never fake a pass
4. Confidence score (0-100%) for the diagnosis
5. Before/after diff of the changed lines
6. Prevention advice (better locator strategy, web-first assertions)

Locator repair preference: getByRole > getByLabel > getByPlaceholder > getByTestId > CSS. Replace waitForTimeout with web-first assertions.
Output structured markdown with code blocks. The patched file must carry a // File: tests/<name>.spec.ts header.`;
  }

  async run({ brokenCode, errorMessage = '', context = '', failedSteps = null }) {
    const failedStepsBlock = Array.isArray(failedSteps) && failedSteps.length
      ? `**Live Run Failures (from extension test runner):**\n${failedSteps.map(f => `- Step: ${f.label} → ${f.error}`).join('\n')}\n`
      : '';

    const prompt = `Heal this failing Playwright test.

**Error Message:**
${errorMessage || 'Test is failing / locator not found'}

${failedStepsBlock}**Context / DOM Change:**
${context || 'Unknown - analyze from code'}

**Failing Test Code:**
\`\`\`
${brokenCode}
\`\`\`

Follow the healing protocol: root cause, patched file (or test.skip if the app is broken), confidence, before/after, prevention.`;

    const result = await this.provider.complete({ system: this.buildSystemPrompt(), prompt, maxTokens: 4000 });
    this.record({ brokenCode, errorMessage }, result);
    return result;
  }
}
