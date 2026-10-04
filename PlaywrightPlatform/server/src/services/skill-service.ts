import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import type { Repos, Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import type {
  ProjectSkill,
  Skill,
  SkillContextItem,
  SkillRepository,
  SkillVersion,
  SkillVersionSummary,
} from '../repositories/skill-repository';
import type { Actor } from '../types';
import type { AuditService } from './audit-service';

export interface CreateSkillInput {
  name: string;
  description: string;
  content: string;
  fileName?: string;
  tags?: string[];
}

export interface UpdateSkillInput {
  name?: string;
  description?: string;
  content?: string;
  changeSummary?: string;
  tags?: string[];
}

export interface ProjectSkillInput {
  attached?: boolean;
  enabled?: boolean;
  priority?: number;
}

/** What the agents are given for one project. */
export interface SkillContext {
  project: string;
  skills: SkillContextItem[];
}

function projectNotActive(): AppError {
  return new AppError(409, 'PROJECT_NOT_ACTIVE', 'This project is archived. Restore it to change its skills.');
}

function nameTaken(name: string): AppError {
  return new AppError(409, 'SKILL_NAME_TAKEN', `A skill named "${name}" already exists here.`);
}

function adminsOnly(): AppError {
  return new AppError(403, 'FORBIDDEN', 'Only administrators can change global skills.');
}

/**
 * Skills are text that project members write for the AI agents: standards, rules, examples.
 * They are stored and handed out as data. Nothing here reads a skill as an instruction.
 */
export class SkillService {
  constructor(
    private readonly skills: SkillRepository,
    private readonly projects: ProjectRepository,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly log: FastifyBaseLogger,
  ) {}

  async listForProject(projectId: number, search?: string): Promise<ProjectSkill[]> {
    if (!(await this.projects.findLiveById(projectId))) throw notFound('Project');
    return this.skills.listForProject(projectId, search);
  }

  /** An archived skill cannot be opened; it is kept only for the scripts and runs that name it. */
  async get(id: number): Promise<Skill> {
    const skill = await this.skills.find(id);
    if (!skill || skill.status !== 'ACTIVE') throw notFound('Skill');
    return skill;
  }

  /** `projectId` null makes a global skill; the route lets only an ADMIN do that. */
  async create(actor: Actor, projectId: number | null, input: CreateSkillInput): Promise<Skill> {
    const skill = await this.transact(async (r) => {
      if (projectId !== null) await this.activeProject(r, projectId);
      const scope = projectId === null ? 'GLOBAL' : 'PROJECT';
      if (await r.skills.nameTaken(scope, projectId, input.name)) throw nameTaken(input.name);
      const id = await r.skills.create({
        name: input.name,
        description: input.description,
        scope,
        projectId,
        fileName: input.fileName ?? null,
        content: input.content,
        createdBy: actor.userId,
      });
      await r.tags.setForSkill(id, input.tags ?? []);
      await this.record(actor, 'skill.create', id, { name: input.name, scope, projectId, version: 1 }, r.audit);
      return this.present(r, id);
    });
    this.log.info(`[SKILL] Created skill ${skill.id}`);
    return skill;
  }

  /** Text that differs from the current version becomes a new version; anything else changes in place. */
  async update(actor: Actor, isAdmin: boolean, id: number, input: UpdateSkillInput): Promise<Skill> {
    return this.transact(async (r) => {
      const skill = await this.writable(r, isAdmin, id);
      if (input.name !== undefined && (await r.skills.nameTaken(skill.scope, skill.projectId, input.name, id))) {
        throw nameTaken(input.name);
      }
      const content = input.content !== undefined && input.content !== skill.content ? input.content : undefined;
      const version = await r.skills.update(id, {
        name: input.name,
        description: input.description,
        content,
        changeSummary: input.changeSummary,
        updatedBy: actor.userId,
      });
      if (input.tags !== undefined) await r.tags.setForSkill(id, input.tags);
      await this.record(actor, 'skill.update', id, { name: input.name ?? skill.name, version, newVersion: content !== undefined }, r.audit);
      return this.present(r, id);
    });
  }

  /** History is never rewritten: restoring writes the old text as a new version. */
  async restore(actor: Actor, isAdmin: boolean, id: number, version: number): Promise<Skill> {
    return this.transact(async (r) => {
      const skill = await this.writable(r, isAdmin, id);
      const old = await r.skills.findVersion(id, version);
      if (!old) throw notFound('Version');
      const now = await r.skills.update(id, {
        content: old.content,
        changeSummary: `Restored version ${version}`,
        updatedBy: actor.userId,
      });
      await this.record(actor, 'skill.restore', id, { name: skill.name, restored: version, version: now }, r.audit);
      return this.present(r, id);
    });
  }

  async archive(actor: Actor, isAdmin: boolean, id: number): Promise<void> {
    await this.transact(async (r) => {
      const skill = await this.writable(r, isAdmin, id);
      await r.skills.setStatus(id, 'ARCHIVED', actor.userId);
      await this.record(actor, 'skill.archive', id, { name: skill.name }, r.audit);
    });
    this.log.info(`[SKILL] Archived skill ${id}`);
  }

  async versions(id: number): Promise<SkillVersionSummary[]> {
    await this.get(id);
    return this.skills.listVersions(id);
  }

  async version(id: number, version: number): Promise<SkillVersion> {
    await this.get(id);
    const row = await this.skills.findVersion(id, version);
    if (!row) throw notFound('Version');
    return row;
  }

  /** Attaches or detaches a global skill, and switches or orders any skill, for one project. */
  async setForProject(actor: Actor, projectId: number, skillId: number, input: ProjectSkillInput): Promise<ProjectSkill> {
    return this.transact(async (r) => {
      await this.activeProject(r, projectId);
      const skill = await r.skills.findForProject(projectId, skillId);
      if (!skill) throw notFound('Skill');
      if (input.attached === false) {
        if (skill.scope === 'PROJECT') {
          throw new AppError(400, 'BAD_REQUEST', "A project's own skill cannot be detached. Switch it off or archive it.");
        }
        await r.skills.unlink(projectId, skillId);
      } else {
        await r.skills.link(projectId, skillId, { enabled: input.enabled, priority: input.priority });
      }
      await this.record(actor, 'skill.project', skillId, { projectId, ...input }, r.audit);
      const after = await r.skills.findForProject(projectId, skillId);
      if (!after) throw new Error('Skill disappeared inside its own transaction.');
      return after;
    });
  }

  /** The enabled skills of a project, in the order the agents must read them. */
  async context(projectId: number): Promise<SkillContext> {
    const project = await this.projects.findLiveById(projectId);
    if (!project) throw notFound('Project');
    return { project: project.name, skills: await this.skills.context(projectId) };
  }

  /** The skills the script's current version was made with. */
  forScript(scriptId: number): Promise<Array<{ id: number; name: string; version: number }>> {
    return this.skills.listForScript(scriptId);
  }

  private async activeProject(r: Repos, projectId: number): Promise<void> {
    const project = await r.projects.findLiveById(projectId);
    if (!project) throw notFound('Project');
    if (project.status !== 'ACTIVE') throw projectNotActive();
  }

  /** The skill, if this caller may change it: a global one only as ADMIN, a project's one only while the project is active. */
  private async writable(r: Repos, isAdmin: boolean, id: number): Promise<Skill> {
    const skill = await r.skills.find(id);
    if (!skill || skill.status !== 'ACTIVE') throw notFound('Skill');
    if (skill.scope === 'GLOBAL' && !isAdmin) throw adminsOnly();
    if (skill.projectId !== null) await this.activeProject(r, skill.projectId);
    return skill;
  }

  private async present(r: Repos, id: number): Promise<Skill> {
    const skill = await r.skills.find(id);
    if (!skill) throw new Error('Skill disappeared inside its own transaction.');
    return skill;
  }

  /** Writes the audit row. Skill text is never put in `details`. */
  private record(
    actor: Actor,
    action: string,
    id: number,
    details: Record<string, unknown>,
    repo: AuditRepository,
  ): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'skill',
        resourceId: String(id),
        result: 'SUCCESS',
        ip: actor.ip,
        details,
      },
      repo,
    );
  }
}
