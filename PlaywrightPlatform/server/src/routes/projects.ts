import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';
import { parse, shape } from '../http';
import { actorOf, adminOnly, signedIn } from '../plugins/auth';
import { idParams } from '../schemas/common';
import {
  createProjectBody,
  listProjectsQuery,
  projectDetailResponse,
  projectListResponse,
  projectResponse,
  toOverviewDto,
  toProjectDto,
  toProjectListItemDto,
  updateProjectBody,
} from '../schemas/projects';
import type { ProjectService } from '../services/project-service';

export interface ProjectRouteDeps {
  projects: ProjectService;
}

export async function projectRoutes(app: FastifyInstance, deps: ProjectRouteDeps): Promise<void> {
  app.get('/projects', { preHandler: signedIn }, async (req) => {
    const query = parse(listProjectsQuery, req.query);
    if (query.status === 'DELETED' && req.auth?.user.role !== 'ADMIN') {
      throw new AppError(403, 'FORBIDDEN', 'Only administrators can list deleted projects.');
    }
    const { items, total } = await deps.projects.list(query);
    return shape(projectListResponse, {
      items: items.map(toProjectListItemDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.post('/projects', { preHandler: adminOnly }, async (req, reply) => {
    const body = parse(createProjectBody, req.body);
    const project = await deps.projects.create(actorOf(req), body);
    return reply.status(201).send(shape(projectResponse, { project: toProjectDto(project) }));
  });

  app.get('/projects/:id', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { project, overview } = await deps.projects.get(id);
    return shape(projectDetailResponse, { project: toProjectDto(project), overview: toOverviewDto(overview) });
  });

  app.put('/projects/:id', { preHandler: adminOnly }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateProjectBody, req.body);
    const project = await deps.projects.update(actorOf(req), id, body);
    return shape(projectResponse, { project: toProjectDto(project) });
  });

  app.delete('/projects/:id', { preHandler: adminOnly }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deps.projects.remove(actorOf(req), id);
    return reply.status(204).send();
  });
}
