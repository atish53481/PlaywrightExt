import { chromium, Browser, Page } from '@playwright/test';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export interface LocatorSuggestion {
  strategy: string;
  selector: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  reason: string;
}

export class LocatorAgent extends Agent {
  private browser?: Browser;

  constructor() {
    super('LocatorAgent', '1.0.0', { supportedTaskTypes: [TaskType.LOCATE] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Locator Agent ready — smart selector strategies');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const url = task.payload.url as string;
      const elementHint = task.payload.elementHint as string ?? '';
      const strategy = task.payload.strategy as string ?? 'auto';

      if (strategy === 'analyze') {
        const suggestions = await this.analyzePageLocators(url, elementHint);
        this.status = AgentStatus.READY;
        return this.createResult(task, TaskStatus.SUCCESS, { suggestions }, t0);
      }

      const prioritized = this.buildLocatorPriority(elementHint);
      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, { locators: prioritized }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    } finally {
      await this.closeBrowser();
    }
  }

  private buildLocatorPriority(hint: string): LocatorSuggestion[] {
    return [
      { strategy: 'test-id',   selector: `[data-testid="${hint}"]`,        confidence: 'HIGH',   reason: 'Most stable — dedicated test attribute' },
      { strategy: 'role',      selector: `role=${hint}`,                   confidence: 'HIGH',   reason: 'ARIA role — semantic and resilient' },
      { strategy: 'label',     selector: `text="${hint}"`,                 confidence: 'HIGH',   reason: 'Visible label — user-facing text' },
      { strategy: 'placeholder', selector: `[placeholder="${hint}"]`,      confidence: 'MEDIUM', reason: 'Placeholder text — may change' },
      { strategy: 'css-id',    selector: `#${hint}`,                       confidence: 'MEDIUM', reason: 'ID selector — unique but may change' },
      { strategy: 'css-class', selector: `.${hint}`,                       confidence: 'LOW',    reason: 'Class selector — fragile, last resort' },
      { strategy: 'xpath',     selector: `//*[contains(text(),"${hint}")]`, confidence: 'LOW',   reason: 'XPath — avoid unless necessary' },
    ];
  }

  private async analyzePageLocators(url: string, hint: string): Promise<LocatorSuggestion[]> {
    this.browser = await chromium.launch({ headless: true });
    const page: Page = await this.browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });

    const suggestions: LocatorSuggestion[] = [];

    const testId = await page.locator(`[data-testid*="${hint}"]`).count();
    if (testId > 0) suggestions.push({ strategy: 'test-id', selector: `[data-testid*="${hint}"]`, confidence: 'HIGH', reason: 'Found on page' });

    const role = await page.getByRole('button', { name: hint }).count();
    if (role > 0) suggestions.push({ strategy: 'role', selector: `getByRole('button', { name: '${hint}' })`, confidence: 'HIGH', reason: 'ARIA role match' });

    const label = await page.getByLabel(hint).count();
    if (label > 0) suggestions.push({ strategy: 'label', selector: `getByLabel('${hint}')`, confidence: 'HIGH', reason: 'Label match found' });

    const text = await page.getByText(hint).count();
    if (text > 0) suggestions.push({ strategy: 'text', selector: `getByText('${hint}')`, confidence: 'MEDIUM', reason: 'Text content match' });

    if (suggestions.length === 0) suggestions.push(...this.buildLocatorPriority(hint));

    await page.close();
    return suggestions;
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = undefined;
    }
  }

  async destroy(): Promise<void> {
    await this.closeBrowser();
    await super.destroy();
  }
}
