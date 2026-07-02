import { Page, Locator } from '@playwright/test';

export type LocatorPriority = 'testId' | 'role' | 'label' | 'placeholder' | 'text' | 'css' | 'xpath';

export interface LocatorOptions {
  fallback?: boolean;
  timeout?: number;
}

export class LocatorStrategy {
  constructor(private readonly page: Page) {}

  /** Priority chain: testId > role > label > placeholder > text > css > xpath */
  async find(hint: string, opts: LocatorOptions = {}): Promise<Locator | null> {
    const chain: Array<() => Locator> = [
      () => this.page.getByTestId(hint),
      () => this.page.getByRole('button', { name: hint }),
      () => this.page.getByLabel(hint),
      () => this.page.getByPlaceholder(hint),
      () => this.page.getByText(hint, { exact: true }),
      () => this.page.locator(`[aria-label="${hint}"]`),
      () => this.page.locator(`#${hint}`),
      () => this.page.locator(hint),
    ];

    if (!opts.fallback) return chain[0]();

    for (const builder of chain) {
      try {
        const loc = builder();
        const count = await loc.count();
        if (count > 0) return loc;
      } catch {
        // try next
      }
    }
    return null;
  }

  byTestId(id: string): Locator { return this.page.getByTestId(id); }
  byRole(role: Parameters<Page['getByRole']>[0], name?: string): Locator {
    return name ? this.page.getByRole(role, { name }) : this.page.getByRole(role);
  }
  byLabel(label: string): Locator { return this.page.getByLabel(label); }
  byText(text: string, exact = false): Locator { return this.page.getByText(text, { exact }); }
  byPlaceholder(ph: string): Locator { return this.page.getByPlaceholder(ph); }
  byCss(selector: string): Locator { return this.page.locator(selector); }
  byXPath(xpath: string): Locator { return this.page.locator(`xpath=${xpath}`); }

  async isVisible(locator: Locator, timeout = 5000): Promise<boolean> {
    try {
      await locator.waitFor({ state: 'visible', timeout });
      return true;
    } catch { return false; }
  }

  async safeClick(hint: string): Promise<boolean> {
    const loc = await this.find(hint, { fallback: true });
    if (!loc) return false;
    await loc.click();
    return true;
  }

  async safeFill(hint: string, value: string): Promise<boolean> {
    const loc = await this.find(hint, { fallback: true });
    if (!loc) return false;
    await loc.fill(value);
    return true;
  }
}
