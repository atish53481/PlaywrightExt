import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { safeEqual } from '../security/tokens';
import type { AuthService } from '../services/auth-service';
import type { Actor, AuthContext, Role } from '../types';

export const SESSION_COOKIE = 'pw_session';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    /** Set when the session lookup itself failed (for example the database is down). */
    authError: unknown;
  }
}

/** Resolves the caller once per request. Routes opt in to enforcement with the guards below. */
export function registerAuth(app: FastifyInstance, authService: AuthService): void {
  app.decorateRequest('auth', null);
  app.decorateRequest('authError', null);
  app.addHook('onRequest', async (req) => {
    try {
      const header = req.headers.authorization;
      if (header?.startsWith('Bearer ')) {
        const found = await authService.resolve(header.slice('Bearer '.length).trim(), 'EXTENSION');
        if (found) req.auth = { ...found, via: 'bearer' };
        return;
      }
      const cookieToken = req.cookies[SESSION_COOKIE];
      if (cookieToken) {
        const found = await authService.resolve(cookieToken, 'WEB');
        if (found) req.auth = { ...found, via: 'cookie' };
      }
    } catch (err) {
      // Routes that need no session (health, static files) must still answer.
      // Guarded routes rethrow this in requireAuth, so it is never mistaken for "not signed in".
      req.authError = err;
    }
  });
}

async function requireAuth(req: FastifyRequest): Promise<void> {
  if (req.authError) throw req.authError;
  if (!req.auth) throw new AppError(401, 'UNAUTHENTICATED', 'Sign in to continue.');
}

// Browsers attach cookies automatically, so cookie-authenticated writes must also
// prove they come from our own page. Bearer tokens are attached deliberately.
async function requireCsrf(req: FastifyRequest): Promise<void> {
  if (req.auth?.via !== 'cookie') return;
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return;
  const sent = req.headers['x-csrf-token'];
  if (typeof sent !== 'string' || !safeEqual(sent, req.auth.session.csrfSecret)) {
    throw new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token. Reload the page and try again.');
  }
}

function requireRole(...roles: Role[]) {
  return async (req: FastifyRequest): Promise<void> => {
    if (!req.auth || !roles.includes(req.auth.user.role)) {
      throw new AppError(403, 'FORBIDDEN', 'Your role does not allow this action.');
    }
  };
}

/** `preHandler` for any signed-in user. */
export const signedIn = [requireAuth, requireCsrf];
/** `preHandler` for ADMIN only. */
export const adminOnly = [requireAuth, requireCsrf, requireRole('ADMIN')];

/** Call only inside a route guarded by `signedIn` or `adminOnly`. */
export function actorOf(req: FastifyRequest): Actor {
  const auth = req.auth as AuthContext;
  return { userId: auth.user.id, email: auth.user.email, ip: req.ip };
}
