import { v4 as uuidv4 } from 'uuid';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';
import { TestPlan, TestScenario, TestType } from '../models/TestPlan';

export class TestPlannerAgent extends Agent {
  constructor() {
    super('TestPlannerAgent', '1.0.0', { canGenerate: true, supportedTaskTypes: [TaskType.PLAN] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Test Planner ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const url = task.payload.url as string;
      const appName = task.payload.appName as string ?? 'Application';
      const requirements = task.payload.requirements as string[] ?? [];

      this.log.info(`Planning tests for: ${url}`);
      const plan = this.buildPlan(url, appName, requirements);
      this.log.info(`Plan created: ${plan.scenarios.length} scenarios, ~${plan.estimatedDuration} min`);

      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, { plan }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    }
  }

  private buildPlan(url: string, appName: string, requirements: string[]): TestPlan {
    const scenarios: TestScenario[] = [
      ...this.functionalScenarios(appName, requirements),
      ...this.navigationScenarios(url),
      ...this.formScenarios(),
      ...this.apiScenarios(url),
    ];

    return {
      id: uuidv4(),
      name: `${appName} Test Plan`,
      description: `Auto-generated test plan for ${url}`,
      targetUrl: url,
      createdAt: new Date(),
      scenarios,
      estimatedDuration: Math.ceil(scenarios.length * 2.5),
      coverage: {
        functional: true, api: true, performance: true, accessibility: true, security: true,
      },
    };
  }

  private functionalScenarios(appName: string, requirements: string[]): TestScenario[] {
    const base: TestScenario[] = [
      {
        id: uuidv4(), title: 'Page Load Verification', type: TestType.FUNCTIONAL,
        priority: 'HIGH', tags: ['smoke', 'load'],
        description: `Verify ${appName} loads correctly`,
        steps: ['Navigate to base URL', 'Assert page title visible', 'Assert no console errors'],
        expectedOutcome: 'Page loads with correct title and no errors',
      },
      {
        id: uuidv4(), title: 'Navigation Flow', type: TestType.FUNCTIONAL,
        priority: 'HIGH', tags: ['navigation', 'smoke'],
        description: 'Verify primary navigation works',
        steps: ['Click each nav link', 'Assert correct page loads', 'Assert URL changes'],
        expectedOutcome: 'All navigation links route correctly',
      },
    ];

    const reqScenarios: TestScenario[] = requirements.map(req => ({
      id: uuidv4(), title: req, type: TestType.FUNCTIONAL, priority: 'MEDIUM' as const,
      tags: ['requirement'], description: `Test: ${req}`,
      steps: [`Setup for: ${req}`, `Execute: ${req}`, `Assert outcome of: ${req}`],
      expectedOutcome: `${req} works as expected`,
    }));

    return [...base, ...reqScenarios];
  }

  private navigationScenarios(url: string): TestScenario[] {
    return [{
      id: uuidv4(), title: 'URL Routing', type: TestType.FUNCTIONAL,
      priority: 'MEDIUM', tags: ['routing'],
      description: `Validate URL routing for ${url}`,
      steps: ['Navigate to root', 'Assert redirect works', 'Check 404 handling'],
      expectedOutcome: 'Routing handles valid and invalid paths correctly',
    }];
  }

  private formScenarios(): TestScenario[] {
    return [
      {
        id: uuidv4(), title: 'Form Submission — Happy Path', type: TestType.FUNCTIONAL,
        priority: 'HIGH', tags: ['form', 'regression'],
        description: 'Valid form submission succeeds',
        steps: ['Fill required fields', 'Submit form', 'Assert success message'],
        expectedOutcome: 'Form submits and shows confirmation',
      },
      {
        id: uuidv4(), title: 'Form Validation — Required Fields', type: TestType.FUNCTIONAL,
        priority: 'MEDIUM', tags: ['form', 'validation'],
        description: 'Empty form shows validation errors',
        steps: ['Leave fields empty', 'Submit form', 'Assert validation messages visible'],
        expectedOutcome: 'Appropriate validation errors shown for empty required fields',
      },
    ];
  }

  private apiScenarios(url: string): TestScenario[] {
    return [{
      id: uuidv4(), title: 'API Health Check', type: TestType.API,
      priority: 'HIGH', tags: ['api', 'smoke'],
      description: `Verify API endpoints at ${url}`,
      steps: ['GET /health or /status', 'Assert 200 response', 'Assert response body schema'],
      expectedOutcome: 'API health endpoint returns 200 with valid body',
    }];
  }
}
