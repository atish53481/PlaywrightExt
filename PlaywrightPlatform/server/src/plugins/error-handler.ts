import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';

function body(code: string, message: string, details: unknown = null) {
  return { error: { code, message, details } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (status === 429) {
      return reply.status(429).send(body('RATE_LIMITED', 'Too many requests. Try again later.'));
    }
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const message = err instanceof Error ? err.message : 'Bad request.';
      return reply.status(status).send(body('BAD_REQUEST', message));
    }
    req.log.error({ err }, 'Unhandled error');
    return reply
      .status(500)
      .send(
        body('INTERNAL_ERROR', 'Something went wrong. Quote the request ID when reporting this.', {
          requestId: req.id,
        }),
      );
  });

  app.setNotFoundHandler((_req, reply) => {
    return reply.status(404).send(body('NOT_FOUND', 'Resource not found.'));
  });
}
