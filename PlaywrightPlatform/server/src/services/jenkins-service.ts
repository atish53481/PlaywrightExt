import type { FastifyBaseLogger } from 'fastify';
import type { SecretBox } from '../crypto/secret-box';
import { AppError } from '../errors';
import { JenkinsClient, JenkinsError } from '../jenkins/jenkins-client';
import { jobConfigXml } from '../jenkins/pipeline';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { JenkinsRepository } from '../repositories/jenkins-repository';
import type { Actor } from '../types';
import type { AuditService } from './audit-service';

export const DEFAULT_JOB_NAME = 'playwright-platform-run';
// What the generated job needs: a pipeline job, a script definition, and declarative syntax.
// The "Pipeline" bundle (workflow-aggregator) installs all three but is itself optional.
const PIPELINE_PLUGINS = ['workflow-job', 'workflow-cps', 'pipeline-model-definition'];

export interface JenkinsSettingsInput {
  baseUrl: string;
  username: string;
  jobName: string;
  token?: string;
}

export interface JenkinsTestInput {
  baseUrl?: string;
  username?: string;
  token?: string;
}

export interface JenkinsSettingsView {
  configured: boolean;
  baseUrl: string;
  username: string;
  jobName: string;
  hasToken: boolean;
}

export interface JenkinsTestResult {
  ok: boolean;
  version: string | null;
  pipelinePlugin: boolean;
  message: string;
}

/** Everything needed to call Jenkins for a run. */
export interface JenkinsLink {
  client: JenkinsClient;
  configurationId: number;
  jobName: string;
  baseUrl: string;
}

function notConfigured(): AppError {
  return new AppError(
    409,
    'JENKINS_NOT_CONFIGURED',
    'Jenkins is not set up yet. An administrator must save it under Settings → Jenkins.',
  );
}

/** Turns a Jenkins failure into the API error a person can act on. Anything else is returned unchanged. */
export function toAppError(err: unknown): unknown {
  if (!(err instanceof JenkinsError)) return err;
  if (err.kind === 'REJECTED') {
    return new AppError(502, 'JENKINS_REJECTED', 'Jenkins refused the username or API token. Check Settings → Jenkins.');
  }
  if (err.kind === 'NOT_FOUND') {
    return new AppError(502, 'JENKINS_REJECTED', 'Jenkins does not have the job. Press Create Job under Settings → Jenkins.');
  }
  return new AppError(502, 'JENKINS_UNREACHABLE', `${err.message} Check that Jenkins is running and the URL under Settings → Jenkins.`);
}

export class JenkinsService {
  constructor(
    private readonly repo: JenkinsRepository,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly box: SecretBox,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** The address and username are shown to an ADMIN only. */
  async view(isAdmin: boolean): Promise<JenkinsSettingsView> {
    const saved = await this.repo.find();
    if (!saved) return { configured: false, baseUrl: '', username: '', jobName: DEFAULT_JOB_NAME, hasToken: false };
    return {
      configured: true,
      baseUrl: isAdmin ? saved.baseUrl : '',
      username: isAdmin ? saved.username : '',
      jobName: saved.jobName,
      hasToken: Boolean(saved.secretCiphertext),
    };
  }

  async save(actor: Actor, input: JenkinsSettingsInput): Promise<JenkinsSettingsView> {
    await this.transact(async (r) => {
      const saved = await r.jenkins.find();
      const secretCiphertext = input.token ? this.box.encrypt(input.token) : saved?.secretCiphertext;
      if (!secretCiphertext) throw new AppError(400, 'VALIDATION_ERROR', 'Enter the Jenkins API token.');
      await r.jenkins.save({ baseUrl: input.baseUrl, username: input.username, jobName: input.jobName, secretCiphertext });
      await this.record(
        actor,
        'jenkins.settings.update',
        { baseUrl: input.baseUrl, username: input.username, jobName: input.jobName, tokenChanged: Boolean(input.token) },
        r.audit,
      );
    });
    this.log.info('[JENKINS] Settings saved');
    return this.view(true);
  }

  /** Tries the given values, falling back to the saved ones. A failure is a normal result, not an error. */
  async test(input: JenkinsTestInput): Promise<JenkinsTestResult> {
    const saved = await this.repo.find();
    const baseUrl = input.baseUrl ?? saved?.baseUrl;
    const username = input.username ?? saved?.username;
    if (!baseUrl || !username) throw notConfigured();
    // The saved token belongs to the saved address and is never sent anywhere else.
    if (!input.token && saved && baseUrl !== saved.baseUrl) {
      return { ok: false, version: null, pipelinePlugin: false, message: 'Enter the Jenkins API token to test a different address.' };
    }
    const token = input.token ??(saved?.secretCiphertext ? this.box.decrypt(saved.secretCiphertext) : '');
    if (!token) return { ok: false, version: null, pipelinePlugin: false, message: 'Enter the Jenkins API token.' };

    const client = new JenkinsClient({ baseUrl, username, token });
    let version: string;
    try {
      version = await client.version();
    } catch (err) {
      if (err instanceof JenkinsError) return { ok: false, version: null, pipelinePlugin: false, message: err.message };
      throw err;
    }

    // Listing plugins needs more Jenkins permission than running builds does, so a refusal
    // here is not a failed connection: the plugin simply could not be checked.
    let missing: string[] | null;
    try {
      missing = await client.missingPlugins(PIPELINE_PLUGINS);
    } catch (err) {
      if (!(err instanceof JenkinsError)) throw err;
      missing = null;
    }
    let message = `Connected to Jenkins ${version}.`;
    if (missing === null) {
      message = `Connected to Jenkins ${version}. This Jenkins user may not list plugins, so check in Jenkins that "Pipeline" is installed.`;
    } else if (missing.length > 0) {
      message = `Connected to Jenkins ${version}, but the Pipeline plugin is not installed (missing: ${missing.join(', ')}). Install "Pipeline" in Jenkins before creating the job.`;
    }
    return { ok: true, version, pipelinePlugin: missing !== null && missing.length === 0, message };
  }

  async createJob(actor: Actor): Promise<{ created: boolean; jobUrl: string }> {
    const link = await this.link();
    let created: boolean;
    try {
      ({ created } = await link.client.createOrUpdateJob(link.jobName, jobConfigXml()));
    } catch (err) {
      throw toAppError(err);
    }
    await this.record(actor, 'jenkins.job.create', { jobName: link.jobName, created });
    this.log.info(`[JENKINS] ${created ? 'Created' : 'Updated'} job ${link.jobName}`);
    return { created, jobUrl: link.client.jobUrl(link.jobName) };
  }

  async link(): Promise<JenkinsLink> {
    const saved = await this.repo.find();
    if (!saved?.secretCiphertext) throw notConfigured();
    const client = new JenkinsClient({
      baseUrl: saved.baseUrl,
      username: saved.username,
      token: this.box.decrypt(saved.secretCiphertext),
    });
    return { client, configurationId: saved.id, jobName: saved.jobName, baseUrl: saved.baseUrl };
  }

  private record(actor: Actor, action: string, details: Record<string, unknown>, repo?: AuditRepository): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'jenkins',
        resourceId: null,
        result: 'SUCCESS',
        ip: actor.ip,
        details,
      },
      repo,
    );
  }
}
