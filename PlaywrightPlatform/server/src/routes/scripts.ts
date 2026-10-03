import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';
import { parse, shape } from '../http';
import { actorOf, signedIn, writers } from '../plugins/auth';
import { idParams } from '../schemas/common';
import {
  createScriptBody,
  listScriptsQuery,
  listTagsQuery,
  projectScriptsParams,
  scriptListResponse,
  scriptResponse,
  tagListResponse,
  toScriptDto,
  toScriptListItemDto,
  updateScriptBody,
} from '../schemas/scripts';
import type { ScriptService } from '../services/script-service';

// A script holds up to 1,000,000 characters, which can exceed Fastify's 1 MiB default once encoded.
const SCRIPT_BODY_LIMIT = 2 * 1024 * 1024;

export interface ScriptRouteDeps {
  scripts: ScriptService;
}

export async function scriptRoutes(app: FastifyInstance, deps: ScriptRouteDeps): Promise<void> {
  app.get('/projects/:projectId/scripts', { preHandler: signedIn }, async (req) => {
    const { projectId } = parse(projectScriptsParams, req.params);
    const query = parse(listScriptsQuery, req.query);
    if (query.status === 'DELETED' && req.auth?.user.role !== 'ADMIN') {
      throw new AppError(403, 'FORBIDDEN', 'Only administrators can list deleted scripts.');
    }
    const { items, total } = await deps.scripts.list(projectId, query);
    return shape(scriptListResponse, {
      items: items.map(toScriptListItemDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.get('/tags', { preHandler: signedIn }, async (req) => {
    const { search } = parse(listTagsQuery, req.query);
    return shape(tagListResponse, { items: await deps.scripts.tags(search) });
  });

  app.post(
    '/projects/:projectId/scripts',
    { preHandler: writers, bodyLimit: SCRIPT_BODY_LIMIT },
    async (req, reply) => {
      const { projectId } = parse(projectScriptsParams, req.params);
      const body = parse(createScriptBody, req.body);
      const script = await deps.scripts.create(actorOf(req), projectId, body);
      return reply.status(201).send(shape(scriptResponse, { script: toScriptDto(script) }));
    },
  );

  app.get('/scripts/:id', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    return shape(scriptResponse, { script: toScriptDto(await deps.scripts.get(id)) });
  });

  app.put('/scripts/:id', { preHandler: writers, bodyLimit: SCRIPT_BODY_LIMIT }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateScriptBody, req.body);
    return shape(scriptResponse, { script: toScriptDto(await deps.scripts.update(actorOf(req), id, body)) });
  });

  app.delete('/scripts/:id', { preHandler: writers }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deps.scripts.remove(actorOf(req), id);
    return reply.status(204).send();
  });
}
