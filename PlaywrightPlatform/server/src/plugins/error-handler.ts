import type { FastifyInstance } from 'fastify';
import { AppError } from '../errors';

function body(code: string, message: string, details: unknown = null) {
  return { error: { code, message, details } };
}

export function registerErrorHandling(app: FastifyInstance, options: { spaFallback: boolean }): void {
  app.setErrorHandler((err: unknown, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(err.code, err.message, err.details));
    }
    const status = (err as { statusCode?: unknown }).statusCode;
    if (status === 429) {
      return reply.status(429).send(body('RATE_LIMITED', 'Too many requests. Try again later.'));
    }
    if (status === 413) {
      return reply.status(413).send(body('PAYLOAD_TOO_LARGE', 'The request is too large.'));
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

  app.setNotFoundHandler((req, reply) => {
    // Client-side routes such as /projects/5 have no file on disk; the SPA handles them.
    if (options.spaFallback && req.method === 'GET' && !req.url.startsWith('/api')) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send(body('NOT_FOUND', 'Resource not found.'));
  });
}
