import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
import { parse, shape } from '../http';
import { actorOf, signedIn, writers } from '../plugins/auth';
import { runReportPage } from '../reports/run-report-page';
import { idParams } from '../schemas/common';
import {
  executionListResponse,
  executionResponse,
  executionResultsResponse,
  listExecutionsQuery,
  reportFileParams,
  reportLinksResponse,
  reportOverviewParams,
  resultParams,
  runReportBody,
  toExecutionDto,
  toResultDto,
} from '../schemas/executions';
import type { ExecutionService } from '../services/execution-service';

export interface ExecutionRouteDeps {
  executions: ExecutionService;
}

/** On the two pipeline routes the bearer value is a run token, not a session token. */
function runToken(req: FastifyRequest): string {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) throw new AppError(401, 'UNAUTHENTICATED', 'A run token is required.');
  return header.slice('Bearer '.length).trim();
}

/** The build number the pipeline sends with its download; null when absent or not a usable number. */
function reportedBuildNumber(req: FastifyRequest): number | null {
  const header = req.headers['x-build-number'];
  if (typeof header !== 'string' || !/^[1-9]\d{0,9}$/.test(header)) return null;
  const value = Number(header);
  // The column is a 32-bit integer.
  return value <= 2_147_483_647 ? value : null;
}

export async function executionRoutes(app: FastifyInstance, deps: ExecutionRouteDeps): Promise<void> {
  app.post('/scripts/:id/run', { preHandler: writers }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const execution = await deps.executions.run(actorOf(req), id);
    return reply.status(201).send(shape(executionResponse, { execution: toExecutionDto(execution) }));
  });

  app.get('/executions/:id', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    return shape(executionResponse, { execution: toExecutionDto(await deps.executions.get(id)) });
  });

  app.get('/scripts/:id/executions', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { limit } = parse(listExecutionsQuery, req.query);
    const items = await deps.executions.list(id, limit);
    return shape(executionListResponse, { items: items.map(toExecutionDto) });
  });

  app.get('/executions/:id/results', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    const { execution, items } = await deps.executions.results(id);
    return shape(executionResultsResponse, { items: items.map((item) => toResultDto(item, execution)) });
  });

  // The image itself, so the panel can show it without the viewer being signed in to Jenkins.
  app.get('/executions/:id/results/:index/screenshot', { preHandler: signedIn }, async (req, reply) => {
    const { id, index } = parse(resultParams, req.params);
    const file = await deps.executions.screenshot(id, index);
    return reply
      .type(file.contentType)
      .header('Cache-Control', 'private, max-age=3600')
      .header('X-Content-Type-Options', 'nosniff')
      .send(file.body);
  });

  app.get('/executions/:id/reports', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    return shape(reportLinksResponse, { reports: await deps.executions.reportLinks(id) });
  });

  // The run's own report page: the run, its tests, and both reports as tabs. Opened through
  // the same signed link as the reports. The page holds no script and escapes every value,
  // so it may frame the two reports and nothing else may run on it.
  app.get('/reports/:token/', async (req, reply) => {
    const { token } = parse(reportOverviewParams, req.params);
    const view = await deps.executions.reportOverview(token);
    return reply
      .type('text/html; charset=utf-8')
      .header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; frame-src 'self'; base-uri 'none'; form-action 'none'")
      .header('Cache-Control', 'private, no-store')
      .send(runReportPage(view));
  });
  // Without the last slash the page's relative links to the reports would point elsewhere.
  app.get('/reports/:token', async (req, reply) => {
    const { token } = parse(reportOverviewParams, req.params);
    return reply.redirect(`${encodeURIComponent(token)}/`);
  });

  // A file of a report. No session guard: the link was signed for a signed-in person and
  // opens in a tab of its own. The report is produced by a test script, so it is served
  // sandboxed: its scripts run, but as a page of no origin, without this site's cookies or storage.
  app.get('/reports/:token/:kind/*', async (req, reply) => {
    const { token, kind, '*': path } = parse(reportFileParams, req.params);
    const file = await deps.executions.reportFile(token, kind, path);
    return reply
      .type(file.contentType)
      .header('Content-Security-Policy', 'sandbox allow-scripts allow-popups allow-downloads')
      // A sandboxed page counts as another origin, even for its own images and videos.
      .header('Cross-Origin-Resource-Policy', 'cross-origin')
      .header('Access-Control-Allow-Origin', '*')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cache-Control', 'private, max-age=300')
      .send(file.body);
  });

  app.post('/executions/:id/stop', { preHandler: writers }, async (req) => {
    const { id } = parse(idParams, req.params);
    return shape(executionResponse, { execution: toExecutionDto(await deps.executions.stop(actorOf(req), id)) });
  });

  // The two routes below are called by the Jenkins build, not by a signed-in person. They
  // have no session guard: the service checks the run token.
  app.get('/executions/:id/script', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const content = await deps.executions.scriptFor(id, runToken(req), reportedBuildNumber(req));
    // Not JSON, so it is not passed through shape().
    return reply.type('text/plain; charset=utf-8').send(content);
  });

  app.post('/executions/:id/result', async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const token = runToken(req);
    const report = parse(runReportBody, req.body);
    await deps.executions.report(id, token, report);
    return reply.status(204).send();
  });
}
