export enum ResultStatus {
  PASSED  = 'passed',
  FAILED  = 'failed',
  SKIPPED = 'skipped',
  FLAKY   = 'flaky',
}

export interface StepResult {
  name: string;
  status: ResultStatus;
  duration: number;
  error?: string;
  screenshot?: string;
}

export interface TestResult {
  id: string;
  testCaseId: string;
  testName: string;
  status: ResultStatus;
  duration: number;
  startTime: Date;
  endTime: Date;
  browser: string;
  steps: StepResult[];
  error?: string;
  screenshots: string[];
  videoPath?: string;
  tracePath?: string;
  retryCount: number;
}

export interface SuiteResult {
  id: string;
  suiteName: string;
  startTime: Date;
  endTime: Date;
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  flaky: number;
  results: TestResult[];
  environment: string;
  branch?: string;
}
