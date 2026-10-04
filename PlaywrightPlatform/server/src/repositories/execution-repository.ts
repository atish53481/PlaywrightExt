import type { Knex } from 'knex';
import type { Db } from '../db';
import type { Execution, ExecutionStage, ExecutionStatus } from '../types';

interface ExecutionRow {
  id: number;
  project_id: number;
  script_id: number;
  script_name: string;
  script_version: number;
  status: ExecutionStatus;
  stage: ExecutionStage;
  jenkins_queue_id: number | null;
  jenkins_build_number: number | null;
  job_name: string;
  jenkins_base_url: string;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  skipped_tests: number;
  error_message: string | null;
  triggered_by_name: string | null;
  callback_token_hash: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration: number | null;
}

const COLUMNS = [
  'e.id',
  'e.project_id',
  'e.script_id',
  'e.script_version',
  'e.status',
  'e.stage',
  'e.jenkins_queue_id',
  'e.jenkins_build_number',
  'e.total_tests',
  'e.passed_tests',
  'e.failed_tests',
  'e.skipped_tests',
  'e.error_message',
  'e.callback_token_hash',
  'e.created_at',
  'e.started_at',
  'e.completed_at',
  'e.duration',
  's.name as script_name',
  'j.job_name',
  'c.base_url as jenkins_base_url',
  'u.display_name as triggered_by_name',
];

function toExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptName: row.script_name,
    scriptVersion: row.script_version,
    status: row.status,
    stage: row.stage,
    queueId: row.jenkins_queue_id,
    buildNumber: row.jenkins_build_number,
    jobName: row.job_name,
    jenkinsBaseUrl: row.jenkins_base_url,
    total: row.total_tests,
    passed: row.passed_tests,
    failed: row.failed_tests,
    skipped: row.skipped_tests,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by_name,
    callbackTokenHash: row.callback_token_hash,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration,
  };
}

/** How one test of a run ended. */
export interface TestResult {
  name: string;
  status: 'PASSED' | 'FAILED' | 'SKIPPED';
  durationMs: number;
  errorMessage: string | null;
  /** Files the build archived for the test, as paths inside the build's artifacts. */
  screenshotPath: string | null;
  videoPath: string | null;
  tracePath: string | null;
}

export interface NewExecution {
  projectId: number;
  scriptId: number;
  scriptVersion: number;
  /** The project's row in `project_ci_jobs`. */
  jenkinsJobId: number;
  triggeredBy: number;
  callbackTokenHash: string;
  /** From the server clock, so the queue timeout never depends on the database clock. */
  createdAt: Date;
}

/** What can change on a run after it is created. Only the keys that are present are written. */
export interface ExecutionPatch {
  status?: ExecutionStatus;
  stage?: ExecutionStage;
  queueId?: number;
  buildNumber?: number;
  reportUrl?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  errorMessage?: string | null;
  callbackTokenHash?: null;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
}

const PATCH_COLUMNS: Record<keyof ExecutionPatch, string> = {
  status: 'status',
  stage: 'stage',
  queueId: 'jenkins_queue_id',
  buildNumber: 'jenkins_build_number',
  reportUrl: 'report_url',
  total: 'total_tests',
  passed: 'passed_tests',
  failed: 'failed_tests',
  skipped: 'skipped_tests',
  errorMessage: 'error_message',
  callbackTokenHash: 'callback_token_hash',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  durationMs: 'duration',
};

const UNFINISHED: ExecutionStatus[] = ['QUEUED', 'RUNNING'];

export class ExecutionRepository {
  constructor(private readonly db: Db) {}

  /**
   * Runs joined to their script, the Jenkins job they ran on, and the person who started
   * them. The script is joined whatever its status, so a run stays readable after its
   * script is deleted.
   */
  private executions(): Knex.QueryBuilder {
    return this.db('test_executions as e')
      .join('test_scripts as s', 's.id', 'e.script_id')
      .join('project_ci_jobs as j', 'j.id', 'e.jenkins_job_id')
      .join('jenkins_configurations as c', 'c.id', 'j.jenkins_configuration_id')
      .leftJoin('users as u', 'u.id', 'e.triggered_by');
  }

  /** Inserts a QUEUED run and returns its id. */
  async insert(input: NewExecution): Promise<number> {
    const [row] = await this.db('test_executions')
      .insert({
        project_id: input.projectId,
        script_id: input.scriptId,
        script_version: input.scriptVersion,
        jenkins_job_id: input.jenkinsJobId,
        trigger_type: 'MANUAL',
        triggered_by: input.triggeredBy,
        callback_token_hash: input.callbackTokenHash,
        created_at: input.createdAt,
      })
      .returning('id');
    return row.id;
  }

  async find(id: number): Promise<Execution | null> {
    const row: ExecutionRow | undefined = await this.executions().where('e.id', id).select(...COLUMNS).first();
    return row ? toExecution(row) : null;
  }

  /** The script's unfinished run, if it has one. */
  async findActive(scriptId: number): Promise<Execution | null> {
    const row: ExecutionRow | undefined = await this.executions()
      .where('e.script_id', scriptId)
      .whereIn('e.status', UNFINISHED)
      .select(...COLUMNS)
      .orderBy('e.id', 'desc')
      .first();
    return row ? toExecution(row) : null;
  }

  /** Newest first. */
  async listForScript(scriptId: number, limit: number): Promise<Execution[]> {
    const rows: ExecutionRow[] = await this.executions()
      .where('e.script_id', scriptId)
      .select(...COLUMNS)
      .orderBy('e.id', 'desc')
      .limit(limit);
    return rows.map(toExecution);
  }

  /**
   * Changes an unfinished run and reports whether it did. A run that already has a final
   * status is left alone, so late or repeated news can never reopen it.
   */
  async updateActive(id: number, patch: ExecutionPatch): Promise<boolean> {
    const columns: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof ExecutionPatch>) {
      if (patch[key] !== undefined) columns[PATCH_COLUMNS[key]] = patch[key];
    }
    if (Object.keys(columns).length === 0) return false;
    const count = await this.db('test_executions').where({ id }).whereIn('status', UNFINISHED).update(columns);
    return count > 0;
  }

  /**
   * Locks an unfinished run until the transaction ends and returns what its build has
   * reported: how many tests, and the error message. Null when the run already has a final status.
   */
  async lockActive(id: number): Promise<{ total: number; errorMessage: string | null } | null> {
    const row = await this.db('test_executions')
      .where({ id })
      .whereIn('status', UNFINISHED)
      .forUpdate()
      .first('total_tests', 'error_message');
    return row ? { total: row.total_tests, errorMessage: row.error_message } : null;
  }

  /** Stores the per-test results of a run in place of any it had. */
  async replaceResults(executionId: number, scriptId: number, results: TestResult[]): Promise<void> {
    await this.db('execution_results').where({ execution_id: executionId }).delete();
    if (results.length === 0) return;
    await this.db('execution_results').insert(
      results.map((result) => ({
        execution_id: executionId,
        script_id: scriptId,
        test_name: result.name,
        status: result.status,
        duration: result.durationMs,
        error_message: result.errorMessage,
        screenshot_path: result.screenshotPath,
        video_path: result.videoPath,
        trace_path: result.tracePath,
      })),
    );
  }

  /** In the order the build reported them. */
  async listResults(executionId: number): Promise<TestResult[]> {
    const rows = await this.db('execution_results')
      .where({ execution_id: executionId })
      .orderBy('id')
      .select('test_name', 'status', 'duration', 'error_message', 'screenshot_path', 'video_path', 'trace_path');
    return rows.map((row) => ({
      name: row.test_name,
      status: row.status,
      durationMs: Number(row.duration ?? 0),
      errorMessage: row.error_message,
      screenshotPath: row.screenshot_path,
      videoPath: row.video_path,
      tracePath: row.trace_path,
    }));
  }

  /** The Jenkins builds a script's runs produced. */
  async buildsForScript(scriptId: number): Promise<Array<{ jobName: string; buildNumber: number }>> {
    const rows: ExecutionRow[] = await this.executions()
      .where('e.script_id', scriptId)
      .whereNotNull('e.jenkins_build_number')
      .select(...COLUMNS)
      .orderBy('e.id');
    return rows.map(toExecution).map((e) => ({ jobName: e.jobName, buildNumber: e.buildNumber as number }));
  }
}
