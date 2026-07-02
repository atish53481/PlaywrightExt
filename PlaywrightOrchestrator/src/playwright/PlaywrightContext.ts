import { chromium, firefox, webkit, Browser, BrowserContext, Page, LaunchOptions } from '@playwright/test';
import * as dotenv from 'dotenv';

dotenv.config();

export type BrowserType = 'chromium' | 'firefox' | 'webkit';

export interface ContextConfig {
  browser?: BrowserType;
  headless?: boolean;
  slowMo?: number;
  viewport?: { width: number; height: number };
  baseURL?: string;
  locale?: string;
  timezone?: string;
  recordVideo?: boolean;
  storageStatePath?: string;
}

export class PlaywrightContext {
  private browser?: Browser;
  private context?: BrowserContext;

  async create(config: ContextConfig = {}): Promise<{ browser: Browser; context: BrowserContext; page: Page }> {
    const browserName = config.browser ?? (process.env.DEFAULT_BROWSER as BrowserType) ?? 'chromium';
    const headless = config.headless ?? process.env.HEADLESS !== 'false';
    const slowMo = config.slowMo ?? parseInt(process.env.SLOW_MO ?? '0');

    const launchOpts: LaunchOptions = { headless, slowMo };

    const launcher = browserName === 'firefox' ? firefox : browserName === 'webkit' ? webkit : chromium;
    this.browser = await launcher.launch(launchOpts);

    const contextOpts: Parameters<Browser['newContext']>[0] = {
      baseURL: config.baseURL ?? process.env.BASE_URL,
      viewport: config.viewport ?? { width: 1280, height: 720 },
      locale: config.locale ?? 'en-US',
      timezoneId: config.timezone ?? 'America/New_York',
    };

    if (config.storageStatePath) contextOpts.storageState = config.storageStatePath;
    if (config.recordVideo) {
      contextOpts.recordVideo = { dir: 'reports/videos', size: { width: 1280, height: 720 } };
    }

    this.context = await this.browser.newContext(contextOpts);
    const page = await this.context.newPage();

    return { browser: this.browser, context: this.context, page };
  }

  async close(): Promise<void> {
    await this.context?.close();
    await this.browser?.close();
    this.context = undefined;
    this.browser = undefined;
  }
}

export const playwrightContext = new PlaywrightContext();
