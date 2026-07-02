import { chromium, Browser, Page } from '@playwright/test';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';

export interface SecurityFinding {
  category: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  title: string;
  description: string;
  recommendation: string;
  evidence?: string;
}

const SECURITY_HEADERS = [
  { header: 'content-security-policy',   severity: 'HIGH'   as const, rec: 'Add CSP header to prevent XSS attacks' },
  { header: 'strict-transport-security', severity: 'HIGH'   as const, rec: 'Enable HSTS to enforce HTTPS' },
  { header: 'x-frame-options',           severity: 'MEDIUM' as const, rec: 'Set X-Frame-Options to prevent clickjacking' },
  { header: 'x-content-type-options',    severity: 'MEDIUM' as const, rec: 'Set X-Content-Type-Options: nosniff' },
  { header: 'referrer-policy',           severity: 'LOW'    as const, rec: 'Set Referrer-Policy to control referrer info' },
  { header: 'permissions-policy',        severity: 'LOW'    as const, rec: 'Set Permissions-Policy to limit browser features' },
];

export class SecurityTestingAgent extends Agent {
  private browser?: Browser;

  constructor() {
    super('SecurityTestingAgent', '1.0.0', { supportedTaskTypes: [TaskType.SECURITY] });
  }

  async init(): Promise<void> {
    this.status = AgentStatus.READY;
    this.log.info('Security Testing Agent ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;
    try {
      const url = task.payload.url as string;
      const depth = task.payload.depth as string ?? 'basic';
      this.log.info(`Security scan: ${url} [${depth}]`);
      this.browser = await chromium.launch({ headless: true });
      const page = await this.browser.newPage();
      const findings: SecurityFinding[] = [];
      findings.push(...await this.checkHeaders(page, url));
      findings.push(...await this.checkCookies(page));
      findings.push(...await this.checkSourceExposure(page));
      if (depth === 'deep') findings.push(...await this.checkForms(page));
      await page.close();
      const high = findings.filter(f => ['HIGH', 'CRITICAL'].includes(f.severity)).length;
      this.log.info(`Findings: ${findings.length} total, ${high} high/critical`);
      this.status = AgentStatus.READY;
      return this.createResult(task, high === 0 ? TaskStatus.SUCCESS : TaskStatus.FAILURE, {
        url, depth, findings, total: findings.length,
        bySeverity: this.countBySeverity(findings), passed: high === 0,
      }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    } finally {
      if (this.browser) { await this.browser.close(); this.browser = undefined; }
    }
  }

  private async checkHeaders(page: Page, url: string): Promise<SecurityFinding[]> {
    const response = await page.goto(url, { waitUntil: 'networkidle' });
    const headers = response?.headers() ?? {};
    const findings: SecurityFinding[] = [];
    for (const h of SECURITY_HEADERS) {
      if (!headers[h.header]) {
        findings.push({
          category: 'Security Headers', severity: h.severity,
          title: `Missing ${h.header}`,
          description: `HTTP header ${h.header} is not present in the response.`,
          recommendation: h.rec, evidence: `Absent in response from ${url}`,
        });
      }
    }
    const csp = headers['content-security-policy'] ?? '';
    if (csp.includes('unsafe-inline')) {
      findings.push({
        category: 'CSP', severity: 'MEDIUM', title: 'CSP allows unsafe-inline',
        description: 'unsafe-inline weakens XSS protection.',
        recommendation: 'Use nonces or hashes instead of unsafe-inline.',
        evidence: csp.slice(0, 100),
      });
    }
    return findings;
  }

  private async checkCookies(page: Page): Promise<SecurityFinding[]> {
    const cookies = await page.context().cookies();
    const findings: SecurityFinding[] = [];
    for (const c of cookies) {
      if (!c.secure) findings.push({ category: 'Cookies', severity: 'MEDIUM',
        title: `Cookie "${c.name}" missing Secure flag`,
        description: 'Cookie transmitted over HTTP.',
        recommendation: 'Set Secure flag on all cookies.', evidence: `Cookie: ${c.name}` });
      if (!c.httpOnly) findings.push({ category: 'Cookies', severity: 'LOW',
        title: `Cookie "${c.name}" missing HttpOnly flag`,
        description: 'Cookie accessible via JavaScript (XSS risk).',
        recommendation: 'Set HttpOnly flag.', evidence: `Cookie: ${c.name}` });
    }
    return findings;
  }

  private async checkSourceExposure(page: Page): Promise<SecurityFinding[]> {
    const src = await page.content();
    const patterns = [
      { re: /password\s*=\s*["'][^"']{3,}/i, title: 'Password in HTML source' },
      { re: /api[_-]?key\s*[=:]\s*["'][a-zA-Z0-9]{10,}/i, title: 'API key in HTML source' },
    ];
    const findings: SecurityFinding[] = [];
    for (const p of patterns) {
      if (p.re.test(src)) findings.push({
        category: 'Sensitive Data Exposure', severity: 'CRITICAL', title: p.title,
        description: 'Sensitive data visible in page source.',
        recommendation: 'Never expose credentials in client-side HTML.',
      });
    }
    return findings;
  }

  private async checkForms(page: Page): Promise<SecurityFinding[]> {
    return page.evaluate(() => {
      const findings: Array<{ category: string; severity: string; title: string; description: string; recommendation: string }> = [];
      for (const form of Array.from(document.querySelectorAll('form'))) {
        const action = form.getAttribute('action') ?? '';
        if (action.startsWith('http:')) {
          findings.push({ category: 'Form Security', severity: 'HIGH',
            title: 'Form submits over HTTP', description: 'Form action is HTTP.',
            recommendation: 'Use HTTPS for all form submissions.' });
        }
      }
      return findings;
    }) as Promise<SecurityFinding[]>;
  }

  private countBySeverity(findings: SecurityFinding[]): Record<string, number> {
    return findings.reduce<Record<string, number>>((acc, f) => {
      acc[f.severity] = (acc[f.severity] ?? 0) + 1; return acc;
    }, {});
  }
}
