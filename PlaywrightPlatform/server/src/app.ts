import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { Config } from './config';
import { createSecretBox } from './crypto/secret-box';
import type { Db } from './db';
import { registerAuth } from './plugins/auth';
import { registerErrorHandling } from './plugins/error-handler';
import { createRepos, createTransact } from './repositories';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { jenkinsRoutes } from './routes/jenkins';
import { projectRoutes } from './routes/projects';
import { scriptRoutes } from './routes/scripts';
import { userRoutes } from './routes/users';
import { AuditService } from './services/audit-service';
import { AuthService } from './services/auth-service';
import { JenkinsService } from './services/jenkins-service';
import { ProjectService } from './services/project-service';
import { ScriptService } from './services/script-service';
import { UserService } from './services/user-service';

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

export async function buildApp({ config, db, webRoot }: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.nodeEnv === 'test'
        ? false
        : { level: config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    genReqId: () => randomUUID(),
    // Off unless configured: trusting X-Forwarded-For without a proxy lets clients forge their address.
    trustProxy: config.trustProxy,
  });

  registerErrorHandling(app, { spaFallback: Boolean(webRoot) });

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
    max: config.rateLimitMax,
    timeWindow: '1 minute',
    // Keyed on the resolved caller, never on raw header or cookie text: otherwise a
    // client gets a fresh bucket per request just by sending a different junk value.
    keyGenerator: (req) => (req.auth ? `session:${req.auth.session.id}` : `ip:${req.ip}`),
  });

  // Composition root: the only place repositories and services are constructed.
  const repos = createRepos(db);
  const transact = createTransact(db);
  const audit = new AuditService(repos.audit, app.log);
  const auth = new AuthService(repos.users, repos.sessions, audit, transact);
  const userService = new UserService(repos.users, audit, transact, app.log);
  const projectService = new ProjectService(repos.projects, audit, transact, app.log);
  const scriptService = new ScriptService(repos.scripts, repos.projects, repos.tags, audit, transact, app.log);
  const jenkinsService = new JenkinsService(repos.jenkins, audit, transact, createSecretBox(config.secretsKey), app.log);

  registerAuth(app, auth);

  await app.register(
    async (api) => {
      await api.register(healthRoutes, {
        ping: async () => {
          await db.raw('select 1');
        },
      });
      await api.register(authRoutes, { auth, config });
      await api.register(userRoutes, { users: userService });
      await api.register(projectRoutes, { projects: projectService });
      await api.register(scriptRoutes, { scripts: scriptService });
      await api.register(jenkinsRoutes, { jenkins: jenkinsService });
    },
    { prefix: '/api' },
  );

  if (webRoot) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
  }

  return app;
}
