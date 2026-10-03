import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import { JenkinsError } from '../jenkins/jenkins-client';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ExecutionRepository } from '../repositories/execution-repository';
import type { ScriptRepository } from '../repositories/script-repository';
import { hashToken, newToken } from '../security/tokens';
import type { Actor, Execution } from '../types';
import type { AuditService } from './audit-service';
import { toAppError, type JenkinsService } from './jenkins-service';

export interface ExecutionOptions {
  /** The address a Jenkins build uses to call this server, without a trailing slash. */
  publicUrl: string;
  /** Milliseconds since the epoch. Passed in so tests can move time. */
  now: () => number;
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

export class ExecutionService {
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

  async get(id: number): Promise<Execution> {
    return this.find(id);
  }

  /** A script's runs, newest first, as stored. Jenkins is not asked. */
  async list(scriptId: number, limit: number): Promise<Execution[]> {
    if (!(await this.scripts.findLive(scriptId))) throw notFound('Script');
    return this.executions.listForScript(scriptId, limit);
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
