import { BrowserContext } from '@playwright/test';
import * as path from 'path';
import * as fs from 'fs';

export type TraceMode = 'on' | 'off' | 'on-first-retry' | 'retain-on-failure';

export class TraceManager {
  private readonly tracesDir: string;

  constructor() {
    this.tracesDir = path.join(process.cwd(), 'reports', 'traces');
    fs.mkdirSync(this.tracesDir, { recursive: true });
  }

  async start(context: BrowserContext, options?: { screenshots?: boolean; snapshots?: boolean }): Promise<void> {
    await context.tracing.start({
      screenshots: options?.screenshots ?? true,
      snapshots: options?.snapshots ?? true,
      sources: true,
    });
  }

  async stop(context: BrowserContext, testName: string): Promise<string> {
    const slug = testName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const tracePath = path.join(this.tracesDir, `${slug}-${Date.now()}.zip`);
    await context.tracing.stop({ path: tracePath });
    return tracePath;
  }

  async stopOnFailure(context: BrowserContext, testName: string, failed: boolean): Promise<string | undefined> {
    if (!failed) {
      await context.tracing.stop();
      return undefined;
    }
    return this.stop(context, testName);
  }

  viewCommand(tracePath: string): string {
    return `npx playwright show-trace "${tracePath}"`;
  }

  listTraces(): string[] {
    if (!fs.existsSync(this.tracesDir)) return [];
    return fs.readdirSync(this.tracesDir)
      .filter(f => f.endsWith('.zip'))
      .map(f => path.join(this.tracesDir, f));
  }
}

export const traceManager = new TraceManager();
