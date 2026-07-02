import * as fs from 'fs';
import * as path from 'path';
import { Agent, AgentStatus } from './base/Agent';
import { AgentTask, AgentResult, TaskType, TaskStatus } from '../models/AgentTask';
import { SuiteResult } from '../models/TestResult';

export class ReportAgent extends Agent {
  private readonly reportsDir: string;

  constructor() {
    super('ReportAgent', '1.0.0', { canReport: true, supportedTaskTypes: [TaskType.REPORT] });
    this.reportsDir = path.join(process.cwd(), 'reports');
  }

  async init(): Promise<void> {
    fs.mkdirSync(this.reportsDir, { recursive: true });
    this.status = AgentStatus.READY;
    this.log.info('Report Agent ready');
  }

  async execute(task: AgentTask): Promise<AgentResult> {
    const t0 = Date.now();
    this.status = AgentStatus.BUSY;
    try {
      const format = task.payload.format as string ?? 'html';
      const suite = task.payload.suiteResult as SuiteResult | undefined;
      const reportPath = format === 'json'
        ? await this.generateJson(suite)
        : await this.generateHtml(suite, task.payload);
      this.log.info(`Report generated: ${reportPath}`);
      this.status = AgentStatus.READY;
      return this.createResult(task, TaskStatus.SUCCESS, { reportPath, format }, t0);
    } catch (err) {
      this.status = AgentStatus.ERROR;
      return this.createResult(task, TaskStatus.FAILURE, {}, t0, [(err as Error).message]);
    }
  }

  private async generateJson(suite?: SuiteResult): Promise<string> {
    const outPath = path.join(this.reportsDir, `report-${Date.now()}.json`);
    fs.writeFileSync(outPath, JSON.stringify(suite ?? {}, null, 2), 'utf8');
    return outPath;
  }

  private async generateHtml(suite?: SuiteResult, extra?: Record<string, unknown>): Promise<string> {
    const title = extra?.title as string ?? 'Playwright Orchestrator Report';
    const outPath = path.join(this.reportsDir, `report-${Date.now()}.html`);
    const s = suite
      ? { total: suite.totalTests, passed: suite.passed, failed: suite.failed, skipped: suite.skipped, flaky: suite.flaky }
      : this.readStats();
    const rate = s.total > 0 ? ((s.passed / s.total) * 100).toFixed(1) : '0';
    const color = s.failed === 0 ? '#22c55e' : '#ef4444';

    const rows = (suite?.results ?? []).map(r =>
      `<tr><td>${r.testName}</td><td>${r.browser}</td>` +
      `<td><span class="badge ${r.status}">${r.status.toUpperCase()}</span></td>` +
      `<td>${(r.duration / 1000).toFixed(2)}s</td>` +
      `<td>${r.error ? r.error.slice(0, 80) : '--'}</td></tr>`
    ).join('');

    const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>${title}</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0}
.hdr{background:linear-gradient(135deg,#1e293b,#0f172a);padding:32px;border-bottom:1px solid #334155}
.hdr h1{font-size:28px;font-weight:700;color:#f1f5f9}.hdr p{color:#94a3b8;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;padding:24px 32px}
.card{background:#1e293b;border-radius:12px;padding:20px;border:1px solid #334155}
.card .v{font-size:32px;font-weight:700}.card .l{font-size:13px;color:#94a3b8;margin-top:4px}
.t .v{color:#60a5fa}.p .v{color:#22c55e}.f .v{color:#ef4444}.k .v{color:#f59e0b}.y .v{color:#a78bfa}
.pr{background:#1e293b;margin:0 32px;border-radius:12px;padding:20px;border:1px solid #334155}
.bar{background:#334155;border-radius:999px;height:12px;margin-top:8px;overflow:hidden}
.fill{height:100%;border-radius:999px;background:${color};width:${rate}%}
.tbl{padding:24px 32px}.tbl h2{font-size:18px;font-weight:600;margin-bottom:16px;color:#f1f5f9}
table{width:100%;border-collapse:collapse;background:#1e293b;border-radius:12px;overflow:hidden}
th{background:#0f172a;padding:12px 16px;text-align:left;font-size:13px;color:#94a3b8;text-transform:uppercase}
td{padding:12px 16px;border-top:1px solid #334155;font-size:14px}
.badge{padding:3px 10px;border-radius:999px;font-size:11px;font-weight:600}
.badge.passed{background:#166534;color:#86efac}.badge.failed{background:#7f1d1d;color:#fca5a5}
.foot{text-align:center;padding:24px;color:#475569;font-size:13px;border-top:1px solid #334155;margin-top:32px}
</style></head><body>
<div class="hdr"><h1>${title}</h1><p>Generated: ${new Date().toLocaleString()}</p></div>
<div class="stats">
<div class="card t"><div class="v">${s.total}</div><div class="l">Total</div></div>
<div class="card p"><div class="v">${s.passed}</div><div class="l">Passed</div></div>
<div class="card f"><div class="v">${s.failed}</div><div class="l">Failed</div></div>
<div class="card k"><div class="v">${s.skipped}</div><div class="l">Skipped</div></div>
<div class="card y"><div class="v">${s.flaky}</div><div class="l">Flaky</div></div>
</div>
<div class="pr"><div style="display:flex;justify-content:space-between;align-items:center">
<span style="font-weight:600">Pass Rate</span>
<span style="font-size:24px;font-weight:700;color:${color}">${rate}%</span></div>
<div class="bar"><div class="fill"></div></div></div>
${rows ? '<div class="tbl"><h2>Test Results</h2><table><thead><tr><th>Test</th><th>Browser</th><th>Status</th><th>Duration</th><th>Error</th></tr></thead><tbody>' + rows + '</tbody></table></div>' : ''}
<div class="foot">Playwright Orchestrator &mdash; Multi-Agent QA Framework</div>
</body></html>`;
    fs.writeFileSync(outPath, html, 'utf8');
    return outPath;
  }

  private readStats(): Record<string, number> {
    try {
      const p = path.join(this.reportsDir, 'results.json');
      if (!fs.existsSync(p)) return { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 };
      const d = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
      const st = d.stats as Record<string, number> ?? {};
      return { total: st.expected ?? 0, passed: st.expected ?? 0, failed: st.unexpected ?? 0, skipped: st.skipped ?? 0, flaky: st.flaky ?? 0 };
    } catch { return { total: 0, passed: 0, failed: 0, skipped: 0, flaky: 0 }; }
  }
}
