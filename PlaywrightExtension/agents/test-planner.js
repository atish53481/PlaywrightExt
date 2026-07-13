import { BaseAgent } from './base-agent.js';

// Maps to the official Playwright 🎭 planner agent (playwright.dev/docs/test-agents):
// explores the app context and produces a human-readable Markdown test plan (specs/*.md)
// that the generator agent transforms 1:1 into executable tests.
// Output structure is governed by templates/test_plan_template.md and
// templates/test_case_template.md — edit those files to change the plan format.

let templateCache = null;

async function loadTemplates() {
  if (templateCache) return templateCache;
  try {
    const [plan, cases] = await Promise.all([
      fetch('templates/test_plan_template.md').then(r => (r.ok ? r.text() : '')),
      fetch('templates/test_case_template.md').then(r => (r.ok ? r.text() : ''))
    ]);
    templateCache = { plan, cases };
  } catch {
    templateCache = { plan: '', cases: '' };
  }
  return templateCache;
}

export class TestPlannerAgent extends BaseAgent {
  constructor(provider) {
    super('Test Planner', provider);
  }

  buildSystemPrompt(templates = { plan: '', cases: '' }) {
    const templateBlock = templates.plan
      ? `Output MUST follow this test plan template. Replace every {{PLACEHOLDER}} with real content derived from the input (use today's date for {{DATE}}, "1.0" for {{VERSION}} unless the input says otherwise):

--- TEST PLAN TEMPLATE ---
${templates.plan}
--- END TEMPLATE ---

For the "Test Cases Summary" section ({{TEST_CASES_SUMMARY}}), write each test case using this format:

--- TEST CASE FORMAT ---
${templates.cases}
--- END FORMAT ---`
      : `Output EXACTLY this structure:
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
## Requirement Traceability`;

    return `You are the Playwright "planner" test agent (see playwright.dev/docs/test-agents).
Your job: analyze the request (and live page context if provided) and produce a human-readable Markdown test plan, saved as specs/<feature-name>.md.

${templateBlock}

Rules:
- Scenarios/test cases must be independently executable and verifiable
- Include positive, negative, and boundary scenarios
- Steps must be concrete enough for the generator agent to produce locators
- Prefer observable expected results (visible text, URL, element state)`;
  }

  async run({ text, inputType = 'feature', pageContext = null, options = {} }) {
    const templates = await loadTemplates();
    const prompt = `Produce a Playwright test plan for the following ${inputType}, following the template in the system prompt.

**Input Type:** ${inputType}
${pageContext ? `**Live Page Context (seed):** URL: ${pageContext.url} — Title: "${pageContext.title}"` : ''}
**Content:**
${text}

Remember: output a single Markdown document the generator agent can transform 1:1 into tests. Fill every template placeholder with concrete content.`;

    const result = await this.provider.complete({ system: this.buildSystemPrompt(templates), prompt, maxTokens: 6000 });
    this.record({ text, inputType }, result);
    return result;
  }
}
