import * as path from 'path';
import { SuiteResult } from '../models/TestResult';

export const ReportUtils = {
  summaryLine(suite: SuiteResult): string {
    const rate = suite.totalTests > 0
      ? ((suite.passed / suite.totalTests) * 100).toFixed(1)
      : '0';
    return `${suite.suiteName}: ${suite.passed}/${suite.totalTests} passed (${rate}%) | ${suite.failed} failed | ${suite.flaky} flaky`;
  },

  statusEmoji(passed: boolean): string {
    return passed ? 'PASS' : 'FAIL';
  },

  defaultReportPath(format: 'html' | 'json' = 'html'): string {
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    return path.join(process.cwd(), 'reports', `report-${ts}.${format}`);
  },

  formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`;
    return `${(ms / 60_000).toFixed(1)}min`;
  },
};
