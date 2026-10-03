import type { FastifyInstance } from 'fastify';

export interface HealthDeps {
  ping: () => Promise<void>;
}

export async function healthRoutes(app: FastifyInstance, deps: HealthDeps): Promise<void> {
  app.get('/health', async (_req, reply) => {
    try {
      await deps.ping();
      return { status: 'ok', database: 'up' };
    } catch {
      return reply.status(503).send({ status: 'degraded', database: 'down' });
    }
  });
}
