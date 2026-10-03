import type { Db } from '../db';
import type { JenkinsSettings } from '../types';

// There is one Jenkins server per installation; its row has this name.
const SETTINGS_NAME = 'default';

export interface JenkinsSettingsValues {
  baseUrl: string;
  username: string;
  jobName: string;
  secretCiphertext: string;
}

export class JenkinsRepository {
  constructor(private readonly db: Db) {}

  async find(): Promise<JenkinsSettings | null> {
    const row = await this.db('jenkins_configurations').where({ name: SETTINGS_NAME }).first();
    if (!row) return null;
    return {
      id: row.id,
      baseUrl: row.base_url,
      username: row.username,
      jobName: row.job_name,
      secretCiphertext: row.secret_ciphertext,
    };
  }

  async save(values: JenkinsSettingsValues): Promise<void> {
    const columns = {
      base_url: values.baseUrl,
      username: values.username,
      job_name: values.jobName,
      secret_ciphertext: values.secretCiphertext,
    };
    await this.db('jenkins_configurations')
      .insert({ name: SETTINGS_NAME, ...columns })
      .onConflict('name')
      .merge({ ...columns, updated_at: this.db.fn.now() });
  }

  /** Returns the id of the project's link to the job, creating the link the first time. */
  async ensureProjectJob(projectId: number, configurationId: number, jobName: string): Promise<number> {
    const link = { project_id: projectId, jenkins_configuration_id: configurationId, job_name: jobName, folder: '' };
    await this.db('project_ci_jobs')
      .insert(link)
      .onConflict(['project_id', 'jenkins_configuration_id', 'job_name', 'folder'])
      .ignore();
    const row = await this.db('project_ci_jobs').where(link).first('id');
    return row.id;
  }
}
