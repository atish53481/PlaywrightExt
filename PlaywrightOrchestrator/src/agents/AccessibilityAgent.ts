import { chromium, Browser, Page } from '@playwright/test';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export interface A11yViolation {
  id: string;
  impact: 'minor' | 'moderate' | 'serious' | 'critical';
  description: string;
  help: string;
  helpUrl: string;
  nodes: Array<{ html: string; target: string[] }>;
}

export class AccessibilityAgent extends Agent {
  private browser?: Browser;

  constructor() {
    super('AccessibilityAgent', '1.0.0', { supportedTaskTypes: [TaskType.ACCESSIBILITY] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Accessibility Agent ready -- WCAG 2.1 AA via axe-core');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;
    try {
      const url = task.payload.url as string;
      const wcagLevel = task.payload.wcagLevel as string ?? 'wcag21aa';
      const failOn = task.payload.failOn as string[] ?? ['critical', 'serious'];

      this.log.info(`Accessibility audit: ${url} [${wcagLevel}]`);
      this.browser = await chromium.launch({ headless: true });
      const page = await this.browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });

      const violations = await this.runAxe(page, wcagLevel);
      const critical = violations.filter(v => failOn.includes(v.impact)).length;
      const passed = critical === 0;

      this.log.info(`Violations: ${violations.length} (${critical} blocking) | Passed: ${passed}`);
      await page.close();
      this.status = AgentStatus.READY;
      return this.createResult(task, passed ? TaskStatus.SUCCESS : TaskStatus.FAILURE, {
        url, wcagLevel, violationCount: violations.length, criticalCount: critical,
        violations, passed,
        summary: violations.length === 0
          ? 'No accessibility violations found.'
          : `${violations.length} violation(s) found (${critical} critical/serious).`,
      }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    } finally {
      if (this.browser) { await this.browser.close(); this.browser = undefined; }
    }
  }

  private async runAxe(page: Page, tags: string): Promise<A11yViolation[]> {
    await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.9.0/axe.min.js' });
    const raw = await page.evaluate((t) => {
      type AxeWindow = Window & { axe: { run: (opts: object) => Promise<unknown> } };
      return (window as unknown as AxeWindow).axe.run({ runOnly: { type: 'tag', values: [t] } });
    }, tags) as { violations: Array<{ id: string; impact: string; description: string; help: string; helpUrl: string; nodes: Array<{ html: string; target: string[] }> }> };
    return raw.violations.map(v => ({
      id: v.id,
      impact: v.impact as A11yViolation['impact'],
      description: v.description,
      help: v.help,
      helpUrl: v.helpUrl,
      nodes: v.nodes.slice(0, 3),
    }));
  }
}
