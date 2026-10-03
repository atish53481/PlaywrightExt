import type { FastifyInstance } from 'fastify';
import type { Config } from '../config';
import { parse, shape } from '../http';
import { SESSION_COOKIE, signedIn } from '../plugins/auth';
import { extensionLoginResponse, loginBody, meResponse, webLoginResponse } from '../schemas/auth';
import { toUserDto } from '../schemas/common';
import type { AuthService } from '../services/auth-service';
import type { AuthContext } from '../types';

export interface AuthRouteDeps {
  auth: AuthService;
  config: Config;
}

export async function authRoutes(app: FastifyInstance, deps: AuthRouteDeps): Promise<void> {
  app.post(
    '/auth/login',
    {
      config: {
        rateLimit: {
          max: deps.config.loginRateLimitMax,
          timeWindow: '15 minutes',
          keyGenerator: (req) => req.ip,
        },
      },
    },
    async (req, reply) => {
      const body = parse(loginBody, req.body);
      const result = await deps.auth.login({ ...body, ip: req.ip });

      if (body.client === 'web') {
        reply.setCookie(SESSION_COOKIE, result.token, {
          httpOnly: true,
          sameSite: 'strict',
          secure: deps.config.nodeEnv === 'production',
          path: '/',
          expires: result.expiresAt,
        });
        return shape(webLoginResponse, { user: toUserDto(result.user), csrfToken: result.csrfToken });
      }
      return shape(extensionLoginResponse, {
        user: toUserDto(result.user),
        token: result.token,
        expiresAt: result.expiresAt.toISOString(),
      });
    },
  );

  app.post('/auth/logout', { preHandler: signedIn }, async (req, reply) => {
    await deps.auth.logout(req.auth as AuthContext, req.ip);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.status(204).send();
  });

  app.get('/auth/me', { preHandler: signedIn }, async (req) => {
    const auth = req.auth as AuthContext;
    return shape(meResponse, {
      user: toUserDto(auth.user),
      csrfToken: auth.via === 'cookie' ? auth.session.csrfSecret : null,
    });
  });
}
