import type { FastifyInstance } from 'fastify';
import { parse, shape } from '../http';
import { actorOf, signedIn, writers } from '../plugins/auth';
import { idParams } from '../schemas/common';
import { createScriptBody, projectScriptsParams, scriptResponse, toScriptDto } from '../schemas/scripts';
import type { ScriptService } from '../services/script-service';

// A script holds up to 1,000,000 characters, which can exceed Fastify's 1 MiB default once encoded.
const SCRIPT_BODY_LIMIT = 2 * 1024 * 1024;

export interface ScriptRouteDeps {
  scripts: ScriptService;
}

export async function scriptRoutes(app: FastifyInstance, deps: ScriptRouteDeps): Promise<void> {
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
}
