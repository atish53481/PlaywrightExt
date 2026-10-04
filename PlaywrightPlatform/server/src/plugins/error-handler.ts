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
      // Text within the character limit can still be too many bytes once encoded; say which limit was hit.
      const message = /\/scripts(\/|$|\?)/.test(req.url)
        ? 'The script is too large to save (2 MB at most once encoded).'
        : 'The request is too large.';
      return reply.status(413).send(body('PAYLOAD_TOO_LARGE', message));
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
    // Not the API (/apix is a page, /api and /api/... are not), and not a file: a missing
    // asset must be a 404, not the page with a 200.
    const path = req.url.split('?')[0];
    const isApi = path === '/api' || path.startsWith('/api/');
    const isFile = /\.[A-Za-z0-9]{1,8}$/.test(path);
    if (options.spaFallback && req.method === 'GET' && !isApi && !isFile) {
      return reply.type('text/html').sendFile('index.html');
    }
    return reply.status(404).send(body('NOT_FOUND', 'Resource not found.'));
  });
}
