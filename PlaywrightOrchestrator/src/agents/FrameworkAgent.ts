import * as fs from 'fs';
import * as path from 'path';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export class FrameworkAgent extends Agent {
  constructor() {
    super('FrameworkAgent', '1.0.0', { canGenerate: true, supportedTaskTypes: [TaskType.SCAFFOLD] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Framework Agent ready — POM scaffolding');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;

    try {
      const targetDir = task.payload.targetDir as string ?? path.join(process.cwd(), 'framework');
      const appName   = task.payload.appName as string ?? 'MyApp';
      const pages     = task.payload.pages as string[] ?? ['Home', 'Login'];

      this.log.info(`Scaffolding POM framework at: ${targetDir}`);
      const created: string[] = [];

      const dirs = ['tests', 'pages', 'fixtures', 'utils', 'helpers', 'api',
                    'test-data', 'constants', 'config', 'reporters', '.auth'];
      for (const d of dirs) {
        const full = path.join(targetDir, d);
        fs.mkdirSync(full, { recursive: true });
      }

      created.push(...this.writeBasePage(targetDir));
      created.push(...this.writeFixtures(targetDir, pages));
      created.push(...this.writePageObjects(targetDir, pages));
      created.push(...this.writeConstants(targetDir, appName));
      created.push(...this.writeUtils(targetDir));
      created.push(...this.writeHelpers(targetDir));
      created.push(...this.writeSampleTest(targetDir, pages[0] ?? 'Home'));

      this.log.info(`Scaffold complete — ${created.length} files created`);
      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, { targetDir, files: created, count: created.length }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    }
  }

  private write(filePath: string, content: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  }

  private writeBasePage(dir: string): string[] {
    return [this.write(path.join(dir, 'pages', 'BasePage.ts'), `import { Page, Locator } from '@playwright/test';

export abstract class BasePage {
  constructor(protected readonly page: Page) {}

  async navigate(path = '/'): Promise<void> {
    await this.page.goto(path);
    await this.page.waitForLoadState('networkidle');
  }

  async getTitle(): Promise<string> { return this.page.title(); }

  async takeScreenshot(name: string): Promise<void> {
    await this.page.screenshot({ path: \`screenshots/\${name}-\${Date.now()}.png\`, fullPage: true });
  }

  async waitForElement(locator: Locator, timeout = 10_000): Promise<void> {
    await locator.waitFor({ state: 'visible', timeout });
  }
}
`)];
  }

  private writePageObjects(dir: string, pages: string[]): string[] {
    return pages.map(p => this.write(path.join(dir, 'pages', `${p}Page.ts`),
`import { Page, Locator } from '@playwright/test';
import { BasePage } from './BasePage';

export class ${p}Page extends BasePage {
  // Locators
  // readonly someElement: Locator = this.page.getByTestId('some-element');

  constructor(page: Page) { super(page); }

  async goto(): Promise<void> {
    await this.navigate('/');
  }

  // Add page-specific actions here
}
`));
  }

  private writeFixtures(dir: string, pages: string[]): string[] {
    const imports = pages.map(p => `import { ${p}Page } from '../pages/${p}Page';`).join('\n');
    const props = pages.map(p => `  ${p.toLowerCase()}Page: ${p}Page;`).join('\n');
    const fixtures = pages.map(p =>
      `  ${p.toLowerCase()}Page: async ({ page }, use) => { await use(new ${p}Page(page)); },`
    ).join('\n');

    return [this.write(path.join(dir, 'fixtures', 'index.ts'),
`import { test as base } from '@playwright/test';
${imports}

type Fixtures = {
${props}
};

export const test = base.extend<Fixtures>({
${fixtures}
});

export { expect } from '@playwright/test';
`)];
  }

  private writeConstants(dir: string, appName: string): string[] {
    return [this.write(path.join(dir, 'constants', 'app.ts'),
`export const APP_NAME = '${appName}';
export const BASE_URL = process.env.BASE_URL ?? 'http://localhost:3000';
export const TIMEOUT = { action: 10_000, navigation: 30_000, test: 60_000 };
export const RETRIES = process.env.CI ? 2 : 0;
`)];
  }

  private writeUtils(dir: string): string[] {
    return [this.write(path.join(dir, 'utils', 'random.ts'),
`export const random = {
  email: () => \`test+\${Date.now()}@example.com\`,
  name: () => \`User\${Math.floor(Math.random() * 9999)}\`,
  number: (min = 1, max = 1000) => Math.floor(Math.random() * (max - min + 1)) + min,
  uuid: () => crypto.randomUUID(),
};
`)];
  }

  private writeHelpers(dir: string): string[] {
    return [this.write(path.join(dir, 'helpers', 'ApiHelper.ts'),
`import { APIRequestContext } from '@playwright/test';

export class ApiHelper {
  constructor(private readonly request: APIRequestContext) {}

  async get(endpoint: string) {
    return this.request.get(endpoint);
  }

  async post(endpoint: string, data: object) {
    return this.request.post(endpoint, { data });
  }

  async delete(endpoint: string) {
    return this.request.delete(endpoint);
  }
}
`)];
  }

  private writeSampleTest(dir: string, page: string): string[] {
    return [this.write(path.join(dir, 'tests', 'sample.spec.ts'),
`import { test, expect } from '../fixtures';

test.describe('${page} Page', () => {
  test('loads correctly', async ({ ${page.toLowerCase()}Page }) => {
    await ${page.toLowerCase()}Page.goto();
    await expect(${page.toLowerCase()}Page['page']).toHaveURL(/.*/, { timeout: 10_000 });
  });
});
`)];
  }
}
