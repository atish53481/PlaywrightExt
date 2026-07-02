import { BaseAgent } from './base-agent.js';

// Maps to the official Playwright 🎭 planner agent (playwright.dev/docs/test-agents):
// explores the app context and produces a human-readable Markdown test plan (specs/*.md)
// that the generator agent transforms 1:1 into executable tests.
export class TestPlannerAgent extends BaseAgent {
  constructor(provider) {
    super('Test Planner', provider);
  }

  buildSystemPrompt() {
    return `You are the Playwright "planner" test agent (see playwright.dev/docs/test-agents).
Your job: analyze the request (and live page context if provided) and produce a human-readable Markdown test plan, saved as specs/<feature-name>.md.

Output EXACTLY this structure:
# <Feature Name> Test Plan
> File: specs/<kebab-case-name>.md

## Seed
Describe the environment bootstrap the tests need (start URL, auth state, test data) — this maps to tests/seed.spec.ts.

## Scenarios
For each scenario:
### <N>. <Scenario name>
**Priority:** P1/P2/P3 | **Tags:** @smoke/@regression/@negative/@boundary/@security
**Steps:**
1. numbered user steps
**Expected Results:**
- observable outcomes with concrete UI text/URLs where possible

## Risk Areas
## Test Data
## Requirement Traceability

Rules:
- Scenarios must be independently executable and verifiable
- Include positive, negative, and boundary scenarios
- Steps must be concrete enough for the generator agent to produce locators
- Prefer observable expected results (visible text, URL, element state)`;
  }

  async run({ text, inputType = 'feature', pageContext = null, options = {} }) {
    const prompt = `Produce a Playwright test plan (specs/*.md format) for the following ${inputType}.

**Input Type:** ${inputType}
${pageContext ? `**Live Page Context (seed):** URL: ${pageContext.url} — Title: "${pageContext.title}"` : ''}
**Content:**
${text}

Remember: output a single Markdown spec file the generator agent can transform 1:1 into tests. Include Seed, Scenarios (with Steps + Expected Results), Risk Areas, Test Data, and Requirement Traceability.`;

    const result = await this.provider.complete({ system: this.buildSystemPrompt(), prompt, maxTokens: 6000 });
    this.record({ text, inputType }, result);
    return result;
  }
}
