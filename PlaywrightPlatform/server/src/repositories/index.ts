import type { Db } from '../db';
import { AuditRepository } from './audit-repository';
import { ExecutionRepository } from './execution-repository';
import { JenkinsRepository } from './jenkins-repository';
import { ProjectRepository } from './project-repository';
import { ScriptRepository } from './script-repository';
import { SessionRepository } from './session-repository';
import { SkillRepository } from './skill-repository';
import { TagRepository } from './tag-repository';
import { UserRepository } from './user-repository';

export interface Repos {
  users: UserRepository;
  sessions: SessionRepository;
  audit: AuditRepository;
  projects: ProjectRepository;
  scripts: ScriptRepository;
  tags: TagRepository;
  jenkins: JenkinsRepository;
  executions: ExecutionRepository;
  skills: SkillRepository;
}

export function createRepos(db: Db): Repos {
  return {
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    audit: new AuditRepository(db),
    projects: new ProjectRepository(db),
    scripts: new ScriptRepository(db),
    tags: new TagRepository(db),
    jenkins: new JenkinsRepository(db),
    executions: new ExecutionRepository(db),
    skills: new SkillRepository(db),
  };
}

/**
 * Runs `work` in one database transaction with repositories bound to it.
 * Everything commits together or not at all, so a mutation can never be
 * left without its audit row (or the reverse).
 */
export type Transact = <T>(work: (repos: Repos) => Promise<T>) => Promise<T>;

export function createTransact(db: Db): Transact {
  return (work) => db.transaction((trx) => work(createRepos(trx)));
}
