import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { Config } from './config';
import type { Db } from './db';
import { registerAuth, SESSION_COOKIE } from './plugins/auth';
import { registerErrorHandling } from './plugins/error-handler';
import { AuditRepository } from './repositories/audit-repository';
import { SessionRepository } from './repositories/session-repository';
import { UserRepository } from './repositories/user-repository';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { AuditService } from './services/audit-service';
import { AuthService } from './services/auth-service';

export interface AppDeps {
  config: Config;
  db: Db;
  /** Absolute path of the built web app. When set, it is served with SPA fallback. */
  webRoot?: string;
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.passwordHash',
  '*.token',
  '*.secret',
];

export async function buildApp({ config, db }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : { level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    genReqId: () => randomUUID(),
  });

  registerErrorHandling(app);

  await app.register(helmet);
  await app.register(cors, {
    origin: config.corsOrigins.length > 0 ? config.corsOrigins : false,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'],
  });
  await app.register(cookie);
  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.headers.authorization ?? req.cookies[SESSION_COOKIE] ?? req.ip,
  });

  // Composition root: the only place repositories and services are constructed.
  const users = new UserRepository(db);
  const sessions = new SessionRepository(db);
  const audit = new AuditService(new AuditRepository(db), app.log);
  const auth = new AuthService(users, sessions, audit);

  registerAuth(app, auth);

  await app.register(
    async (api) => {
      await api.register(healthRoutes, {
        ping: async () => {
          await db.raw('select 1');
        },
      });
      await api.register(authRoutes, { auth, config });
    },
    { prefix: '/api' },
  );

  return app;
}
