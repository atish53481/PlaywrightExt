import { v4 as uuidv4 } from 'uuid';
import * as fs from 'fs';
import * as path from 'path';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';
import { TestPlan, TestScenario, TestType } from '../models/TestPlan';
import { TestCase } from '../models/TestCase';

export class TestGeneratorAgent extends Agent {
  private readonly testsDir: string;

  constructor() {
    super('TestGeneratorAgent', '1.0.0', { canGenerate: true, supportedTaskTypes: [TaskType.GENERATE] });
    this.testsDir = path.join(process.cwd(), 'tests', 'generated');
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.testsDir, { recursive: true });
    this.status = AgentStatus.READY;
    this.log.info('Test Generator ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const plan = task.payload.plan as TestPlan;
      const url = task.payload.url as string ?? plan?.targetUrl ?? 'http://localhost:3000';

      this.log.info(`Generating tests from plan: ${plan?.name ?? 'ad-hoc'}`);
      const testCases: TestCase[] = [];

      if (plan) {
        for (const scenario of plan.scenarios) {
          const tc = this.generateFromScenario(scenario, url);
          this.writeTestFile(tc);
          testCases.push(tc);
        }
      } else {
        const tc = this.generateSmokeTest(url);
        this.writeTestFile(tc);
        testCases.push(tc);
      }

      this.log.info(`Generated ${testCases.length} test files in ${this.testsDir}`);
      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, {
        testCases: testCases.length,
        files: testCases.map(tc => tc.filePath),
      }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    }
  }

  private generateFromScenario(scenario: TestScenario, url: string): TestCase {
    const slug = scenario.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const filePath = path.join(this.testsDir, `${slug}.spec.ts`);
    const code = this.buildSpecCode(scenario, url);
    return { id: uuidv4(), name: scenario.title, filePath, describe: scenario.description,
      steps: [], tags: scenario.tags, timeout: 30000, code };
  }

  private buildSpecCode(scenario: TestScenario, url: string): string {
    const stepCode = scenario.steps.map((step, i) =>
      `  // Step ${i + 1}: ${step}\n  await page.waitForLoadState('networkidle');`
    ).join('\n');

    const apiBlock = scenario.type === TestType.API ? `
  test.use({ baseURL: '${url}' });
` : '';

    return `import { test, expect } from '@playwright/test';
${apiBlock}
test.describe('${scenario.description}', () => {
  test('${scenario.title}', async ({ page${scenario.type === TestType.API ? ', request' : ''} }) => {
    // Tags: ${scenario.tags.join(', ')}
    // Priority: ${scenario.priority}
    // Expected: ${scenario.expectedOutcome}

${scenario.type === TestType.API
  ? `    const response = await request.get('${url}/health');
    expect(response.ok()).toBeTruthy();
    expect(response.status()).toBe(200);`
  : `    await page.goto('${url}');
${stepCode}
    // Assert: ${scenario.expectedOutcome}
    await expect(page).toHaveURL(/.*/, { timeout: 10000 });`
}
  });
});
`;
  }

  private generateSmokeTest(url: string): TestCase {
    const code = `import { test, expect } from '@playwright/test';

test.describe('Smoke Tests', () => {
  test('page loads successfully', async ({ page }) => {
    await page.goto('${url}');
    await expect(page).toHaveTitle(/.+/);
    await page.waitForLoadState('networkidle');
  });

  test('no console errors on load', async ({ page }) => {
    const errors: string[] = [];
    page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
    await page.goto('${url}');
    await page.waitForLoadState('networkidle');
    expect(errors).toHaveLength(0);
  });
});
`;
    const filePath = path.join(this.testsDir, 'smoke.spec.ts');
    return { id: uuidv4(), name: 'Smoke Tests', filePath, describe: 'Basic smoke tests',
      steps: [], tags: ['smoke'], code };
  }

  private writeTestFile(tc: TestCase): void {
    if (tc.code) {
      fs.writeFileSync(tc.filePath, tc.code, 'utf8');
      this.log.debug(`Written: ${tc.filePath}`);
    }
  }
}
