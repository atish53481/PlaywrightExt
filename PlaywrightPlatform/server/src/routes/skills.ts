import type { FastifyInstance, FastifyRequest } from 'fastify';
import { parse, shape } from '../http';
import { actorOf, adminOnly, signedIn, writers } from '../plugins/auth';
import { idParams } from '../schemas/common';
import {
  createSkillBody,
  listSkillsQuery,
  projectSkillBody,
  projectSkillListResponse,
  projectSkillParams,
  projectSkillResponse,
  projectSkillsParams,
  scriptSkillListResponse,
  skillContextResponse,
  skillResponse,
  skillVersionListResponse,
  skillVersionParams,
  skillVersionResponse,
  toProjectSkillDto,
  toSkillDto,
  toSkillVersionDto,
  toSkillVersionItemDto,
  updateSkillBody,
} from '../schemas/skills';
import type { SkillService } from '../services/skill-service';

export interface SkillRouteDeps {
  skills: SkillService;
}

// Skill text can be 200,000 characters, which can exceed Fastify's 1 MiB default once encoded.
const SKILL_BODY_LIMIT = 1024 * 1024;

const isAdmin = (req: FastifyRequest) => req.auth?.user.role === 'ADMIN';

export async function skillRoutes(app: FastifyInstance, deps: SkillRouteDeps): Promise<void> {
  app.get('/projects/:projectId/skills', { preHandler: signedIn }, async (req) => {
    const { projectId } = parse(projectSkillsParams, req.params);
    const { search } = parse(listSkillsQuery, req.query);
    const items = await deps.skills.listForProject(projectId, search);
    return shape(projectSkillListResponse, { items: items.map(toProjectSkillDto) });
  });

  // What the agents read: the enabled skills of the project, in order.
  app.get('/projects/:projectId/skills/context', { preHandler: signedIn }, async (req) => {
    const { projectId } = parse(projectSkillsParams, req.params);
    return shape(skillContextResponse, await deps.skills.context(projectId));
  });

  app.post('/projects/:projectId/skills', { preHandler: writers, bodyLimit: SKILL_BODY_LIMIT }, async (req, reply) => {
    const { projectId } = parse(projectSkillsParams, req.params);
    const body = parse(createSkillBody, req.body);
    const skill = await deps.skills.create(actorOf(req), projectId, body);
    return reply.status(201).send(shape(skillResponse, { skill: toSkillDto(skill) }));
  });

  app.put('/projects/:projectId/skills/:skillId', { preHandler: writers }, async (req) => {
    const { projectId, skillId } = parse(projectSkillParams, req.params);
    const body = parse(projectSkillBody, req.body);
    const skill = await deps.skills.setForProject(actorOf(req), projectId, skillId, body);
    return shape(projectSkillResponse, { skill: toProjectSkillDto(skill) });
  });

  app.post('/skills', { preHandler: adminOnly, bodyLimit: SKILL_BODY_LIMIT }, async (req, reply) => {
    const body = parse(createSkillBody, req.body);
    const skill = await deps.skills.create(actorOf(req), null, body);
    return reply.status(201).send(shape(skillResponse, { skill: toSkillDto(skill) }));
  });

  app.get('/skills/:id', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    return shape(skillResponse, { skill: toSkillDto(await deps.skills.get(id)) });
  });

  app.put('/skills/:id', { preHandler: writers, bodyLimit: SKILL_BODY_LIMIT }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateSkillBody, req.body);
    const skill = await deps.skills.update(actorOf(req), isAdmin(req), id, body);
    return shape(skillResponse, { skill: toSkillDto(skill) });
  });

  app.delete('/skills/:id', { preHandler: writers }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deps.skills.archive(actorOf(req), isAdmin(req), id);
    return reply.status(204).send();
  });

  app.get('/skills/:id/versions', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    const items = await deps.skills.versions(id);
    return shape(skillVersionListResponse, { items: items.map(toSkillVersionItemDto) });
  });

  app.get('/skills/:id/versions/:version', { preHandler: signedIn }, async (req) => {
    const { id, version } = parse(skillVersionParams, req.params);
    return shape(skillVersionResponse, { version: toSkillVersionDto(await deps.skills.version(id, version)) });
  });

  app.post('/skills/:id/versions/:version/restore', { preHandler: writers }, async (req) => {
    const { id, version } = parse(skillVersionParams, req.params);
    const skill = await deps.skills.restore(actorOf(req), isAdmin(req), id, version);
    return shape(skillResponse, { skill: toSkillDto(skill) });
  });

  app.get('/scripts/:id/skills', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    return shape(scriptSkillListResponse, { items: await deps.skills.forScript(id) });
  });
}
