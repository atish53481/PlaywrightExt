import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import { JenkinsError, type BuildState } from '../jenkins/jenkins-client';
import { jenkinsReportUrl } from '../jenkins/urls';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ExecutionPatch, ExecutionRepository } from '../repositories/execution-repository';
import type { ScriptRepository } from '../repositories/script-repository';
import { hashToken, newToken, safeEqual } from '../security/tokens';
import type { Actor, Execution, ExecutionStatus } from '../types';
import type { AuditService } from './audit-service';
import { toAppError, type JenkinsLink, type JenkinsService } from './jenkins-service';

export interface ExecutionOptions {
  /** The address a Jenkins build uses to call this server, without a trailing slash. */
  publicUrl: string;
  /** Milliseconds since the epoch. Passed in so tests can move time. */
  now: () => number;
  /** The Playwright Docker image each build runs the tests in. */
  playwrightImage: string;
}

function projectNotActive(): AppError {
  return new AppError(409, 'PROJECT_NOT_ACTIVE', 'This project is archived. Restore it to run its scripts.');
}

function runInProgress(executionId: number): AppError {
  return new AppError(
    409,
    'RUN_IN_PROGRESS',
    'This script is already running. Wait for that run to finish, or stop it.',
    { executionId },
  );
}

function alreadyFinished(): AppError {
  return new AppError(409, 'EXECUTION_FINISHED', 'This run has already finished.');
}

// One answer for every reason, so a caller without the token learns nothing about the run.
function badRunToken(): AppError {
  return new AppError(401, 'UNAUTHENTICATED', 'The run token is not valid for this run.');
}

/** What a build reports when its tests have run. */
export interface RunReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errorMessage?: string;
}

const SYNC_INTERVAL_MS = 2_000;
const QUEUE_TIMEOUT_MS = 10 * 60_000;

const FINAL: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>(['PASSED', 'FAILED', 'ABORTED', 'ERROR']);

const BUILD_FAILED_EARLY = 'The build failed before the tests ran. Open the Jenkins build for the log.';
const BUILD_NOT_RUN = 'The build ended without running the tests. Open the Jenkins build for the log.';
const BUILD_LOST = 'Jenkins no longer has this run. Open the job in Jenkins to see what happened.';
const QUEUE_TIMED_OUT = 'Jenkins did not start the build. Check that an agent is online.';

interface Outcome {
  status: 'PASSED' | 'FAILED' | 'ABORTED' | 'ERROR';
  errorMessage?: string;
}

/** The final status for a build that ended. `total` is how many tests the build reported back. */
function outcomeOf(result: BuildState['result'], total: number): Outcome {
  switch (result) {
    case 'SUCCESS':
      return { status: 'PASSED' };
    case 'UNSTABLE':
      return { status: 'FAILED' };
    case 'FAILURE':
      // The pipeline marks failing tests UNSTABLE, so FAILURE means the build itself broke,
      // unless it got far enough to report tests.
      return total > 0 ? { status: 'FAILED' } : { status: 'ERROR', errorMessage: BUILD_FAILED_EARLY };
    case 'ABORTED':
      return { status: 'ABORTED' };
    default:
      return { status: 'ERROR', errorMessage: BUILD_NOT_RUN };
  }
}

export class ExecutionService {
  /** When each unfinished run was last checked against Jenkins (milliseconds). */
  private readonly lastSync = new Map<number, number>();

  constructor(
    private readonly executions: ExecutionRepository,
    private readonly scripts: ScriptRepository,
    private readonly jenkins: JenkinsService,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly options: ExecutionOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Records the run, then asks Jenkins to start it. If Jenkins refuses, the run stays in
   * history as ERROR and the caller gets the reason.
   */
  async run(actor: Actor, scriptId: number): Promise<Execution> {
    const script = await this.scripts.findLive(scriptId);
    if (!script) throw notFound('Script');
    if (script.projectStatus !== 'ACTIVE') throw projectNotActive();
    const link = await this.jenkins.link();
    // A run nobody watched still reads as unfinished. Bring it up to date before refusing a new one.
    const stale = await this.executions.findActive(scriptId);
    if (stale) await this.sync(stale, link);

    // The build proves who it is with this token. Only its hash is stored.
    const token = newToken();
    const created = await this.transact(async (r) => {
      // The lock makes two people who press Run together take turns: the second sees the first one's run.
      if (!(await r.scripts.lock(scriptId))) throw notFound('Script');
      const current = await r.scripts.findLive(scriptId);
      if (!current) throw notFound('Script'); // its project is deleted
      if (current.projectStatus !== 'ACTIVE') throw projectNotActive();
      const unfinished = await r.executions.findActive(scriptId);
      if (unfinished) throw runInProgress(unfinished.id);

      const jobId = await r.jenkins.ensureProjectJob(current.projectId, link.configurationId, link.jobName);
      const id = await r.executions.insert({
        projectId: current.projectId,
        scriptId,
        scriptVersion: current.version,
        jenkinsJobId: jobId,
        triggeredBy: actor.userId,
        callbackTokenHash: hashToken(token),
        createdAt: this.nowDate(),
      });
      await this.record(
        actor,
        'execution.run',
        id,
        { projectId: current.projectId, scriptId, scriptVersion: current.version },
        r.audit,
      );
      return { id, version: current.version };
    });

    try {
      const queueId = await link.client.trigger(link.jobName, {
        EXECUTION_ID: String(created.id),
        PLATFORM_URL: this.options.publicUrl,
        RUN_TOKEN: token,
        PLAYWRIGHT_IMAGE: this.options.playwrightImage,
      });
      await this.executions.updateActive(created.id, { queueId });
    } catch (err) {
      if (!(err instanceof JenkinsError)) throw err;
      const failure = toAppError(err) as AppError;
      await this.executions.updateActive(created.id, {
        status: 'ERROR',
        stage: 'COMPLETED',
        errorMessage: failure.message,
        callbackTokenHash: null,
        completedAt: this.nowDate(),
      });
      this.log.warn(`[EXECUTION] Run ${created.id} could not start: ${err.message}`);
      throw failure;
    }
    this.log.info(`[EXECUTION] Started run ${created.id} of script ${scriptId} v${created.version}`);
    return this.find(created.id);
  }

  /** Reads a run. An unfinished one is first brought up to date with Jenkins, at most once every 2 seconds. */
  async get(id: number): Promise<Execution> {
    const execution = await this.find(id);
    if (FINAL.has(execution.status)) return execution;
    const now = this.options.now();
    const last = this.lastSync.get(id);
    if (last !== undefined && now - last < SYNC_INTERVAL_MS) return execution;
    this.lastSync.set(id, now);
    await this.sync(execution, await this.jenkins.link());
    return this.find(id);
  }

  /** A script's runs, newest first, as stored. Jenkins is not asked. */
  async list(scriptId: number, limit: number): Promise<Execution[]> {
    if (!(await this.scripts.findLive(scriptId))) throw notFound('Script');
    return this.executions.listForScript(scriptId, limit);
  }

  /**
   * Aborts an unfinished run. A run still waiting in the queue is ABORTED at once. For a
   * build, the answer carries what Jenkins says right after the stop request, which may
   * still be RUNNING.
   */
  async stop(actor: Actor, id: number): Promise<Execution> {
    const stored = await this.find(id);
    if (FINAL.has(stored.status)) throw alreadyFinished();
    const link = await this.jenkins.link();

    // The queued run may have become a build, or ended, since it was last read.
    await this.sync(stored, link);
    const execution = await this.find(id);
    if (FINAL.has(execution.status)) throw alreadyFinished();

    try {
      if (execution.buildNumber !== null) {
        await link.client.stopBuild(execution.jobName, execution.buildNumber);
      } else if (execution.queueId !== null) {
        await link.client.cancelQueue(execution.queueId);
      }
    } catch (err) {
      throw toAppError(err);
    }
    await this.record(actor, 'execution.stop', id, {
      scriptId: execution.scriptId,
      buildNumber: execution.buildNumber,
    });

    if (execution.buildNumber === null) {
      // Nothing is building, so there is nothing more to wait for.
      await this.finish(execution, () => ({ status: 'ABORTED' }), { completedAt: this.nowDate() });
    } else {
      await this.sync(execution, link);
    }
    this.log.info(`[EXECUTION] Stop requested for run ${id}`);
    return this.find(id);
  }

  /**
   * The script for a build: the version recorded when Run was pressed, whatever has happened
   * to the script since. The build also reports its number here, which is how a run is found
   * again after Jenkins has forgotten the queue item.
   */
  async scriptFor(id: number, token: string, buildNumber: number | null): Promise<string> {
    const execution = await this.authorize(id, token);
    if (buildNumber !== null && execution.buildNumber === null) {
      await this.executions.updateActive(id, {
        buildNumber,
        reportUrl: jenkinsReportUrl(execution.jenkinsBaseUrl, execution.jobName, buildNumber),
      });
    }
    const version = await this.scripts.findVersion(execution.scriptId, execution.scriptVersion);
    if (!version) throw notFound('Script version');
    return version.content;
  }

  /** Stores what the build reports. Status is never taken from here: it comes only from Jenkins. */
  async report(id: number, token: string, report: RunReport): Promise<void> {
    await this.authorize(id, token);
    const stored = await this.executions.updateActive(id, {
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      errorMessage: report.errorMessage ?? null,
    });
    // False when the run reached a final status between the check and the write.
    if (!stored) throw badRunToken();
  }

  /**
   * Brings one unfinished run up to date with Jenkins. Status comes only from Jenkins.
   * If Jenkins cannot be reached, or refuses, the run is left as it is: one bad poll must
   * not fail a run.
   */
  private async sync(execution: Execution, link: JenkinsLink): Promise<void> {
    try {
      let buildNumber = execution.buildNumber;
      if (buildNumber === null) {
        // Until the build has a number, only the queue item knows what became of the run.
        const item = execution.queueId === null ? null : await link.client.queueItem(execution.queueId);
        if (item?.cancelled) {
          await this.finish(execution, () => ({ status: 'ABORTED' }), { completedAt: this.nowDate() });
          return;
        }
        if (!item || item.buildNumber === null) {
          await this.expireIfStuck(execution, link);
          return;
        }
        buildNumber = item.buildNumber;
        await this.executions.updateActive(execution.id, {
          buildNumber,
          reportUrl: jenkinsReportUrl(link.baseUrl, execution.jobName, buildNumber),
        });
      }

      const build = await link.client.build(execution.jobName, buildNumber);
      const startedAt = new Date(build.timestamp);
      if (build.building) {
        if (execution.status !== 'RUNNING') {
          await this.executions.updateActive(execution.id, { status: 'RUNNING', stage: 'RUNNING', startedAt });
        }
        return;
      }
      await this.finish(execution, (total) => outcomeOf(build.result, total), {
        startedAt,
        completedAt: new Date(build.timestamp + build.duration),
        durationMs: build.duration,
      });
    } catch (err) {
      if (!(err instanceof JenkinsError)) throw err;
      // Unreachable or refused: nothing changes, and the caller answers with what is stored.
      if (err.kind !== 'NOT_FOUND') return;
      await this.finish(execution, () => ({ status: 'ERROR', errorMessage: BUILD_LOST }), {
        completedAt: this.nowDate(),
      });
    }
  }

  /** A run that has waited 10 minutes for a build is given up, and taken out of the Jenkins queue. */
  private async expireIfStuck(execution: Execution, link: JenkinsLink): Promise<void> {
    if (this.options.now() - execution.createdAt.getTime() <= QUEUE_TIMEOUT_MS) return;
    // Otherwise the build could start later, with a run token that no longer works.
    if (execution.queueId !== null) await link.client.cancelQueue(execution.queueId);
    await this.finish(execution, () => ({ status: 'ERROR', errorMessage: QUEUE_TIMED_OUT }), {
      completedAt: this.nowDate(),
    });
  }

  /**
   * Gives a run its final status. `decide` is told how many tests the build reported; the
   * count is read under a lock, so a report arriving at the same moment is either counted
   * or refused. Does nothing when the run is already final.
   */
  private async finish(
    execution: Execution,
    decide: (total: number) => Outcome,
    times: { startedAt?: Date; completedAt: Date; durationMs?: number },
  ): Promise<void> {
    const status = await this.transact(async (r) => {
      const reported = await r.executions.lockActive(execution.id);
      if (!reported) return null;
      const outcome = decide(reported.total);
      const patch: ExecutionPatch = { status: outcome.status, stage: 'COMPLETED', callbackTokenHash: null, ...times };
      if (outcome.errorMessage) patch.errorMessage = outcome.errorMessage;
      await r.executions.updateActive(execution.id, patch);
      if (outcome.status === 'PASSED' || outcome.status === 'FAILED') {
        await r.scripts.markRunResult(execution.scriptId, execution.scriptVersion, outcome.status);
      }
      return outcome.status;
    });
    if (!status) return;
    this.lastSync.delete(execution.id);
    this.log.info(`[EXECUTION] Run ${execution.id} finished: ${status}`);
  }

  /** The run a token belongs to. Refused unless the token is that run's own and the run is unfinished. */
  private async authorize(id: number, token: string): Promise<Execution> {
    const execution = await this.executions.find(id);
    const expected = execution?.callbackTokenHash;
    if (!execution || !expected || FINAL.has(execution.status) || !safeEqual(hashToken(token), expected)) {
      throw badRunToken();
    }
    return execution;
  }

  private async find(id: number): Promise<Execution> {
    const execution = await this.executions.find(id);
    if (!execution) throw notFound('Execution');
    return execution;
  }

  private nowDate(): Date {
    return new Date(this.options.now());
  }

  /** Writes the audit row. Never pass the run token in `details`. */
  private record(
    actor: Actor,
    action: string,
    id: number,
    details: Record<string, unknown>,
    repo?: AuditRepository,
  ): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'execution',
        resourceId: String(id),
        result: 'SUCCESS',
        ip: actor.ip,
        details,
      },
      repo,
    );
  }
}
