import { z } from 'zod';
import { jenkinsBuildUrl, jenkinsReportUrl } from '../jenkins/urls';
import type { Execution } from '../types';

export const listExecutionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const executionDto = z.object({
  id: z.number(),
  projectId: z.number(),
  scriptId: z.number(),
  scriptName: z.string(),
  scriptVersion: z.number(),
  status: z.enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ABORTED', 'ERROR']),
  stage: z.enum(['QUEUED', 'RUNNING', 'COMPLETED']),
  buildNumber: z.number().nullable(),
  buildUrl: z.string().nullable(),
  reportUrl: z.string().nullable(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  errorMessage: z.string().nullable(),
  triggeredBy: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});

export const executionResponse = z.object({ execution: executionDto });
export const executionListResponse = z.object({ items: z.array(executionDto) });

/** The run token's hash is deliberately not part of this shape. */
export function toExecutionDto(e: Execution): z.infer<typeof executionDto> {
  const build = e.buildNumber;
  return {
    id: e.id,
    projectId: e.projectId,
    scriptId: e.scriptId,
    scriptName: e.scriptName,
    scriptVersion: e.scriptVersion,
    status: e.status,
    stage: e.stage,
    buildNumber: build,
    // Built from the saved Jenkins address each time, so a link always points at the configured server.
    buildUrl: build === null ? null : jenkinsBuildUrl(e.jenkinsBaseUrl, e.jobName, build),
    reportUrl: build === null ? null : jenkinsReportUrl(e.jenkinsBaseUrl, e.jobName, build),
    total: e.total,
    passed: e.passed,
    failed: e.failed,
    skipped: e.skipped,
    errorMessage: e.errorMessage,
    triggeredBy: e.triggeredBy,
    createdAt: e.createdAt.toISOString(),
    startedAt: e.startedAt ? e.startedAt.toISOString() : null,
    completedAt: e.completedAt ? e.completedAt.toISOString() : null,
    durationMs: e.durationMs,
  };
}

const count = z.number().int().min(0).max(1_000_000);

/** What the pipeline posts when the tests have run. Unknown keys, such as a status, are dropped. */
export const runReportBody = z.object({
  total: count,
  passed: count,
  failed: count,
  skipped: count,
  // Trimmed rather than refused: a long failure message must not cost the run its counts.
  // PostgreSQL text cannot hold a NUL character, so those are removed.
  errorMessage: z
    .string()
    .transform((text) => text.replace(/\u0000/g, '').slice(0, 2000))
    .optional(),
});
