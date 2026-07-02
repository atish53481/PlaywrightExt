import { chromium, Browser, Page } from '@playwright/test';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export interface PerfMetrics {
  url: string;
  fcp?: number;
  lcp?: number;
  domContentLoaded: number;
  loadComplete: number;
  firstByte: number;
  resourceCount: number;
  transferSizeKb: number;
  timestamp: Date;
}

export class PerformanceTestingAgent extends Agent {
  private browser?: Browser;

  constructor() {
    super('PerformanceTestingAgent', '1.0.0', { supportedTaskTypes: [TaskType.PERFORMANCE] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Performance Testing Agent ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;
    try {
      const url = task.payload.url as string;
      const runs = task.payload.runs as number ?? 3;
      const fcpThreshold = task.payload.fcpThreshold as number ?? parseInt(process.env.PERF_FCP_THRESHOLD ?? '1800');
      const loadThreshold = task.payload.loadThreshold as number ?? 5000;

      this.log.info(`Performance test: ${url} (${runs} runs)`);
      this.browser = await chromium.launch({ headless: true });
      const allMetrics: PerfMetrics[] = [];

      for (let i = 0; i < runs; i++) {
        const page = await this.browser.newPage();
        const m = await this.measure(page, url);
        allMetrics.push(m);
        await page.close();
        this.log.debug(`Run ${i + 1}: FCP=${m.fcp?.toFixed(0)}ms load=${m.loadComplete.toFixed(0)}ms`);
      }

      const avg = this.average(allMetrics);
      const violations: string[] = [];
      if (avg.fcp && avg.fcp > fcpThreshold) violations.push(`FCP ${avg.fcp.toFixed(0)}ms > ${fcpThreshold}ms`);
      if (avg.loadComplete > loadThreshold) violations.push(`Load ${avg.loadComplete.toFixed(0)}ms > ${loadThreshold}ms`);

      this.log.info(`Avg FCP: ${avg.fcp?.toFixed(0)}ms | Load: ${avg.loadComplete.toFixed(0)}ms | Violations: ${violations.length}`);
      this.status = AgentStatus.READY;
      return this.createResult(task, violations.length === 0 ? TaskStatus.SUCCESS : TaskStatus.FAILURE, {
        url, runs, avg, allMetrics, violations, passed: violations.length === 0,
        thresholds: { fcp: fcpThreshold, load: loadThreshold },
      }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    } finally {
      if (this.browser) { await this.browser.close(); this.browser = undefined; }
    }
  }

  private async measure(page: Page, url: string): Promise<PerfMetrics> {
    await page.goto(url, { waitUntil: 'networkidle' });
    return page.evaluate((pageUrl) => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
      const paint = performance.getEntriesByType('paint');
      const resources = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
      return {
        url: pageUrl,
        fcp: paint.find(p => p.name === 'first-contentful-paint')?.startTime,
        domContentLoaded: nav.domContentLoadedEventEnd - nav.startTime,
        loadComplete: nav.loadEventEnd - nav.startTime,
        firstByte: nav.responseStart - nav.startTime,
        resourceCount: resources.length,
        transferSizeKb: Math.round(resources.reduce((s, r) => s + (r.transferSize ?? 0), 0) / 1024),
        timestamp: new Date(),
      };
    }, url);
  }

  private average(runs: PerfMetrics[]): PerfMetrics {
    const avg = (vals: (number | undefined)[]): number | undefined => {
      const nums = vals.filter((v): v is number => v !== undefined);
      return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : undefined;
    };
    return {
      url: runs[0].url,
      fcp: avg(runs.map(r => r.fcp)),
      domContentLoaded: avg(runs.map(r => r.domContentLoaded)) ?? 0,
      loadComplete: avg(runs.map(r => r.loadComplete)) ?? 0,
      firstByte: avg(runs.map(r => r.firstByte)) ?? 0,
      resourceCount: Math.round(avg(runs.map(r => r.resourceCount)) ?? 0),
      transferSizeKb: Math.round(avg(runs.map(r => r.transferSizeKb)) ?? 0),
      timestamp: new Date(),
    };
  }
}
