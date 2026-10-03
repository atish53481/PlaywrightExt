import type { FastifyBaseLogger } from 'fastify';
import { isUniqueViolation } from '../db';
import { AppError, notFound } from '../errors';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ProjectListQuery, ProjectPatch, ProjectRepository } from '../repositories/project-repository';
import type { Actor, Project, ProjectListItem, ProjectOverview } from '../types';
import type { AuditService } from './audit-service';

export class ProjectService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly log: FastifyBaseLogger,
  ) {}

  list(query: ProjectListQuery): Promise<{ items: ProjectListItem[]; total: number }> {
    return this.projects.list(query);
  }

  async get(id: number): Promise<{ project: Project; overview: ProjectOverview }> {
    const project = await this.projects.findLiveById(id);
    if (!project) throw notFound('Project');
    return { project, overview: await this.projects.overview(id) };
  }

  async create(actor: Actor, input: { name: string; description: string }): Promise<Project> {
    let project: Project;
    try {
      project = await this.transact(async (r) => {
        const created = await r.projects.create({ ...input, createdBy: actor.userId });
        await this.record(actor, 'project.create', created.id, 'SUCCESS', { name: created.name }, r.audit);
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        // The failed transaction is already rolled back, so this row is written on its own.
        await this.record(actor, 'project.create', null, 'FAILURE', { name: input.name, reason: 'name taken' });
        throw this.nameTaken(input.name);
      }
      throw err;
    }
    this.log.info(`[PROJECT] Created project ${project.id}`);
    return project;
  }

  async update(actor: Actor, id: number, patch: ProjectPatch): Promise<Project> {
    let archiving = false;
    let updated: Project;
    try {
      updated = await this.transact(async (r) => {
        const existing = await r.projects.findLiveById(id);
        if (!existing) throw notFound('Project');

        const changed = await r.projects.update(id, patch);
        if (!changed) throw notFound('Project');

        archiving = patch.status === 'ARCHIVED' && existing.status !== 'ARCHIVED';
        await this.record(
          actor,
          archiving ? 'project.archive' : 'project.update',
          id,
          'SUCCESS',
          { changed: Object.keys(patch) },
          r.audit,
        );
        return changed;
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw this.nameTaken(patch.name ?? '');
      throw err;
    }
    this.log.info(`[PROJECT] ${archiving ? 'Archived' : 'Updated'} project ${id}`);
    return updated;
  }

  async remove(actor: Actor, id: number): Promise<void> {
    await this.transact(async (r) => {
      const deleted = await r.projects.softDelete(id, actor.userId);
      if (!deleted) throw notFound('Project');
      await this.record(actor, 'project.delete', id, 'SUCCESS', undefined, r.audit);
    });
    this.log.info(`[PROJECT] Deleted project ${id}`);
  }

  private nameTaken(name: string): AppError {
    return new AppError(409, 'PROJECT_NAME_TAKEN', `A project named "${name}" already exists.`);
  }

  /** Pass `repo` to write the row inside the caller's transaction. */
  private record(
    actor: Actor,
    action: string,
    id: number | null,
    result: 'SUCCESS' | 'FAILURE',
    details?: Record<string, unknown>,
    repo?: AuditRepository,
  ): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'project',
        resourceId: id === null ? null : String(id),
        result,
        ip: actor.ip,
        details,
      },
      repo,
    );
  }
}
