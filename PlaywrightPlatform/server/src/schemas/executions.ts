import { z } from 'zod';
import { jenkinsBuildUrl, jenkinsReportUrl } from '../jenkins/urls';
import type { TestResult } from '../repositories/execution-repository';
import type { Execution } from '../types';

export const listExecutionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

/** A run and the place of one test in its results (the first test is 0). */
export const resultParams = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  index: z.coerce.number().int().min(0).max(499),
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

// Trimmed rather than refused: a long failure message must not cost the run its counts.
// PostgreSQL text cannot hold a NUL character, so those are removed.
const trimmed = (max: number) => z.string().transform((text) => text.replace(/\u0000/g, '').slice(0, max));

// Where the build left a file for a test, relative to its workspace. It becomes part of a
// link, so anything but a plain relative path (a leading slash, "..", a drive, a query) is
// dropped. Dropped, not refused: a bad path must not cost the run its results.
const artifactPath = z
  .string()
  .max(500)
  .regex(/^(?![/\\])(?!.*\.\.)[^\\:?#\u0000]+$/)
  .optional()
  .catch(undefined);

const testResult = z.object({
  name: trimmed(500).pipe(z.string().min(1)),
  status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
  durationMs: z.number().int().min(0).max(86_400_000),
  errorMessage: trimmed(2000).optional(),
  screenshot: artifactPath,
  video: artifactPath,
  trace: artifactPath,
});

/** What the pipeline posts when the tests have run. Unknown keys, such as a status, are dropped. */
export const runReportBody = z.object({
  total: count,
  passed: count,
  failed: count,
  skipped: count,
  errorMessage: trimmed(2000).optional(),
  /** One entry per test. Absent from a pipeline older than this field. */
  tests: z.array(testResult).max(500).optional(),
});

export const executionResultsResponse = z.object({
  items: z.array(
    z.object({
      name: z.string(),
      status: z.enum(['PASSED', 'FAILED', 'SKIPPED']),
      durationMs: z.number(),
      errorMessage: z.string().nullable(),
      screenshotUrl: z.string().nullable(),
      videoUrl: z.string().nullable(),
      traceUrl: z.string().nullable(),
    }),
  ),
});

/** A test result with links to the files its build archived. No link until the build has a number. */
export function toResultDto(result: TestResult, execution: Execution) {
  const build = execution.buildNumber;
  const artifacts = build === null ? null : `${jenkinsBuildUrl(execution.jenkinsBaseUrl, execution.jobName, build)}artifact/`;
  const link = (path: string | null) =>
    artifacts && path ? artifacts + path.split('/').map(encodeURIComponent).join('/') : null;
  return {
    name: result.name,
    status: result.status,
    durationMs: result.durationMs,
    errorMessage: result.errorMessage,
    screenshotUrl: link(result.screenshotPath),
    videoUrl: link(result.videoPath),
    traceUrl: link(result.tracePath),
  };
}
