import type { FastifyInstance } from 'fastify';
import { parse, shape } from '../http';
import { actorOf, adminOnly, signedIn } from '../plugins/auth';
import {
  jenkinsJobResponse,
  jenkinsSettingsResponse,
  jenkinsTestResponse,
  saveJenkinsBody,
  testJenkinsBody,
} from '../schemas/jenkins';
import type { JenkinsService } from '../services/jenkins-service';

export interface JenkinsRouteDeps {
  jenkins: JenkinsService;
}

export async function jenkinsRoutes(app: FastifyInstance, deps: JenkinsRouteDeps): Promise<void> {
  app.get('/jenkins/settings', { preHandler: signedIn }, async (req) => {
    const isAdmin = req.auth?.user.role === 'ADMIN';
    return shape(jenkinsSettingsResponse, { settings: await deps.jenkins.view(isAdmin) });
  });

  app.put('/jenkins/settings', { preHandler: adminOnly }, async (req) => {
    const body = parse(saveJenkinsBody, req.body);
    return shape(jenkinsSettingsResponse, { settings: await deps.jenkins.save(actorOf(req), body) });
  });

  app.post('/jenkins/test', { preHandler: adminOnly }, async (req) => {
    const body = parse(testJenkinsBody, req.body ?? {});
    return shape(jenkinsTestResponse, await deps.jenkins.test(body));
  });

  app.post('/jenkins/job', { preHandler: adminOnly }, async (req) => {
    return shape(jenkinsJobResponse, await deps.jenkins.createJob(actorOf(req)));
  });
}
