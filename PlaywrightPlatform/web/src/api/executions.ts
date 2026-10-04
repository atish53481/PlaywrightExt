import { api } from './client';

export type ExecutionStatus = 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ABORTED' | 'ERROR';

/** One run of a script on Jenkins. */
export interface Execution {
  id: number;
  scriptId: number;
  scriptVersion: number;
  status: ExecutionStatus;
  buildNumber: number | null;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errorMessage: string | null;
  triggeredBy: string | null;
  createdAt: string;
  durationMs: number | null;
}

/** Where each report of a run opens; null when the build archived no such report. */
export interface ReportLinks {
  playwright: string | null;
  allure: string | null;
}

export const executionsApi = {
  list: (scriptId: number, limit = 10) => api<{ items: Execution[] }>(`/scripts/${scriptId}/executions?limit=${limit}`),
  reports: (id: number) => api<{ reports: ReportLinks }>(`/executions/${id}/reports`),
};
