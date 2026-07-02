import { chromium, Browser, Page } from '@playwright/test';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export interface ElementInfo {
  tag: string;
  id?: string;
  classes: string[];
  attributes: Record<string, string>;
  innerText?: string;
  ariaLabel?: string;
  ariaRole?: string;
  isVisible: boolean;
  boundingBox?: { x: number; y: number; width: number; height: number } | null;
  testId?: string;
}

export class InspectorAgent extends Agent {
  private browser?: Browser;

  constructor() {
    super('InspectorAgent', '1.0.0', { supportedTaskTypes: [TaskType.INSPECT] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Inspector Agent ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const url = task.payload.url as string;
      const selector = task.payload.selector as string ?? 'body';
      const mode = task.payload.mode as string ?? 'element';

      this.browser = await chromium.launch({ headless: true });
      const page: Page = await this.browser.newPage();
      await page.goto(url, { waitUntil: 'networkidle' });

      let data: Record<string, unknown>;

      if (mode === 'page') {
        data = await this.inspectPage(page);
      } else if (mode === 'all-interactive') {
        data = await this.inspectInteractiveElements(page);
      } else {
        data = { element: await this.inspectElement(page, selector) };
      }

      await page.close();
      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, data, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    } finally {
      await this.closeBrowser();
    }
  }

  private async inspectElement(page: Page, selector: string): Promise<ElementInfo> {
    return page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) throw new Error(`Element not found: ${sel}`);
      const attrs: Record<string, string> = {};
      for (const a of Array.from(el.attributes)) attrs[a.name] = a.value;
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        classes: Array.from(el.classList),
        attributes: attrs,
        innerText: (el as HTMLElement).innerText?.slice(0, 200),
        ariaLabel: el.getAttribute('aria-label') ?? undefined,
        ariaRole: el.getAttribute('role') ?? undefined,
        isVisible: (el as HTMLElement).offsetParent !== null,
        testId: el.getAttribute('data-testid') ?? undefined,
      };
    }, selector);
  }

  private async inspectPage(page: Page): Promise<Record<string, unknown>> {
    return page.evaluate(() => ({
      title: document.title,
      url: window.location.href,
      headings: Array.from(document.querySelectorAll('h1,h2,h3')).map(h => ({
        level: h.tagName, text: (h as HTMLElement).innerText.slice(0, 100),
      })),
      links: document.querySelectorAll('a[href]').length,
      buttons: document.querySelectorAll('button,[role="button"]').length,
      inputs: document.querySelectorAll('input,textarea,select').length,
      images: document.querySelectorAll('img').length,
      forms: document.querySelectorAll('form').length,
    }));
  }

  private async inspectInteractiveElements(page: Page): Promise<Record<string, unknown>> {
    const elements = await page.evaluate(() => {
      const selectors = 'a, button, input, select, textarea, [role="button"], [tabindex]';
      return Array.from(document.querySelectorAll(selectors)).slice(0, 50).map(el => ({
        tag: el.tagName.toLowerCase(),
        text: (el as HTMLElement).innerText?.slice(0, 60),
        id: el.id || null,
        testId: el.getAttribute('data-testid') || null,
        type: el.getAttribute('type') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
      }));
    });
    return { interactiveElements: elements, count: elements.length };
  }

  private async closeBrowser(): Promise<void> {
    if (this.browser) { await this.browser.close(); this.browser = undefined; }
  }

  async destroy(): Promise<void> {
    await this.closeBrowser();
    await super.destroy();
  }
}
