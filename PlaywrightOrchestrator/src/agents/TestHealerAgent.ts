import * as fs from 'fs';
import * as path from 'path';
import { chromium, Browser, Page } from '@playwright/test';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

interface HealResult {
  file: string;
  brokenSelector: string;
  healedSelector: string;
  strategy: string;
  confidence: string;
}

export class TestHealerAgent extends Agent {
  private browser?: Browser;

  constructor() {
    super('TestHealerAgent', '1.0.0', { canHeal: true, supportedTaskTypes: [TaskType.HEAL] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Test Healer ready — auto-fixes broken selectors');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const testFiles = task.payload.testFiles as string[] ?? this.findTestFiles();
      const url = task.payload.url as string;
      const dryRun = task.payload.dryRun as boolean ?? true;

      this.log.info(`Healing ${testFiles.length} test files (dry-run: ${dryRun})`);

      const healed: HealResult[] = [];

      this.browser = await chromium.launch({ headless: true });
      const page = await this.browser.newPage();
      if (url) await page.goto(url, { waitUntil: 'networkidle' });

      for (const file of testFiles) {
        const results = await this.healFile(file, page, dryRun);
        healed.push(...results);
      }

      await page.close();
      this.log.info(`Healed ${healed.length} selectors across ${testFiles.length} files`);
      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, { healed, count: healed.length, dryRun }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    } finally {
      if (this.browser) { await this.browser.close(); this.browser = undefined; }
    }
  }

  private async healFile(filePath: string, page: Page, dryRun: boolean): Promise<HealResult[]> {
    if (!fs.existsSync(filePath)) return [];
    let content = fs.readFileSync(filePath, 'utf8');
    const results: HealResult[] = [];

    const patterns = [
      /page\.locator\(['"`](.+?)['"`]\)/g,
      /page\.\$\(['"`](.+?)['"`]\)/g,
    ];

    for (const pattern of patterns) {
      let match: RegExpExecArray | null;
      while ((match = pattern.exec(content)) !== null) {
        const selector = match[1];
        const count = await page.locator(selector).count().catch(() => 0);

        if (count === 0) {
          const healed = await this.findAlternative(page, selector);
          if (healed) {
            this.log.warn(`Broken: ${selector} → Healed: ${healed.selector}`);
            if (!dryRun) {
              content = content.replace(selector, healed.selector);
            }
            results.push({ file: filePath, brokenSelector: selector,
              healedSelector: healed.selector, strategy: healed.strategy, confidence: healed.confidence });
          }
        }
      }
    }

    if (!dryRun && results.length > 0) {
      fs.writeFileSync(filePath, content, 'utf8');
      this.log.info(`Updated: ${filePath}`);
    }

    return results;
  }

  private async findAlternative(page: Page, brokenSelector: string): Promise<{ selector: string; strategy: string; confidence: string } | null> {
    const hint = brokenSelector.replace(/[.#\[\]='"*>~+:]/g, ' ').trim().split(' ').filter(Boolean).pop() ?? '';

    const candidates = [
      { sel: `[data-testid*="${hint}"]`, strategy: 'test-id',    confidence: 'HIGH' },
      { sel: `[aria-label*="${hint}"]`,  strategy: 'aria-label', confidence: 'HIGH' },
      { sel: `text=${hint}`,             strategy: 'text',       confidence: 'MEDIUM' },
      { sel: `[name="${hint}"]`,         strategy: 'name-attr',  confidence: 'MEDIUM' },
    ];

    for (const c of candidates) {
      const count = await page.locator(c.sel).count().catch(() => 0);
      if (count === 1) return { selector: c.sel, strategy: c.strategy, confidence: c.confidence };
    }
    return null;
  }

  private findTestFiles(): string[] {
    const testsDir = path.join(process.cwd(), 'tests');
    if (!fs.existsSync(testsDir)) return [];
    return fs.readdirSync(testsDir)
      .filter(f => f.endsWith('.spec.ts') || f.endsWith('.spec.js'))
      .map(f => path.join(testsDir, f));
  }
}
