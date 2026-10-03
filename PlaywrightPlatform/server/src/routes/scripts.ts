import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';
import { parse, shape } from '../http';
import { actorOf, signedIn, writers } from '../plugins/auth';
import { idParams } from '../schemas/common';
import {
  createScriptBody,
  downloadQuery,
  duplicateScriptBody,
  listScriptsQuery,
  listTagsQuery,
  projectScriptsParams,
  scriptListResponse,
  scriptResponse,
  scriptVersionParams,
  tagListResponse,
  toScriptDto,
  toScriptListItemDto,
  toVersionDto,
  toVersionItemDto,
  updateScriptBody,
  versionListResponse,
  versionResponse,
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

  app.post('/scripts/:id/duplicate', { preHandler: writers }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    // The body is optional: a request without one asks for the default name.
    const { name } = parse(duplicateScriptBody, req.body ?? {});
    const script = await deps.scripts.duplicate(actorOf(req), id, name);
    return reply.status(201).send(shape(scriptResponse, { script: toScriptDto(script) }));
  });

  app.get('/scripts/:id/versions', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    const items = await deps.scripts.versions(id);
    return shape(versionListResponse, { items: items.map(toVersionItemDto) });
  });

  app.get('/scripts/:id/versions/:version', { preHandler: signedIn }, async (req) => {
    const { id, version } = parse(scriptVersionParams, req.params);
    return shape(versionResponse, { version: toVersionDto(await deps.scripts.version(id, version)) });
  });

  app.post('/scripts/:id/versions/:version/restore', { preHandler: writers }, async (req) => {
    const { id, version } = parse(scriptVersionParams, req.params);
    return shape(scriptResponse, { script: toScriptDto(await deps.scripts.restore(actorOf(req), id, version)) });
  });

  // The one response that is not JSON, so it is not passed through shape().
  app.get('/scripts/:id/download', { preHandler: signedIn }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { version } = parse(downloadQuery, req.query);
    const file = await deps.scripts.download(id, version);
    return reply
      .type('text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${file.fileName}"`)
      .send(file.content);
  });
}
