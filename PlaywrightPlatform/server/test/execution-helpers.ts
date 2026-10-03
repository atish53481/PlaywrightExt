import { createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';
import type { JenkinsStub, StubBuild } from './jenkins-stub';
import { newProject, newScript } from './script-helpers';

type Headers = Record<string, string>;

/** The default job name. `startWorld` creates this job in the stub. */
export const JOB = 'playwright-platform-run';

export interface RunWorld {
  ctx: TestContext;
  /** The clock the app reads. Tests move `t` forward instead of waiting. */
  clock: { t: number };
  asAdmin: Headers;
  asUser: Headers;
  asViewer: Headers;
  projectId: number;
  scriptId: number;
}

/**
 * A fresh app, an empty database, three signed-in people, saved Jenkins settings that point
 * at the stub, the job, and one script ("Login Test", v1). The app is new for every test
 * because the service remembers in memory when it last asked Jenkins about a run.
 */
export async function startWorld(stub: JenkinsStub): Promise<RunWorld> {
  const clock = { t: Date.now() };
  const ctx = await makeApp({ RATE_LIMIT_MAX: '100000' }, { now: () => clock.t });
  await resetDb(ctx.db);
  stub.reset();
  stub.jobs.add(JOB);

  const admin = await createUser(ctx.db, { role: 'ADMIN', displayName: 'Ada Admin' });
  const user = await createUser(ctx.db, { role: 'USER', displayName: 'Uma User' });
  const viewer = await createUser(ctx.db, { role: 'VIEWER', displayName: 'Vic Viewer' });
  const asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
  const asUser = (await loginExt(ctx.app, user.email, user.password)).headers;
  const asViewer = (await loginExt(ctx.app, viewer.email, viewer.password)).headers;

  const saved = await ctx.app.inject({
    method: 'PUT',
    url: '/api/jenkins/settings',
    headers: asAdmin,
    payload: { baseUrl: stub.url, username: stub.username, token: stub.token },
  });
  if (saved.statusCode !== 200) throw new Error(`saving Jenkins settings failed: ${saved.statusCode} ${saved.body}`);

  const projectId = await newProject(ctx, asAdmin);
  const script = await newScript(ctx, asAdmin, projectId);
  return { ctx, clock, asAdmin, asUser, asViewer, projectId, scriptId: script.id };
}

/** POST /scripts/:id/run. Returns the raw response. */
export function run(world: RunWorld, headers: Headers = world.asUser, scriptId: number = world.scriptId) {
  return world.ctx.app.inject({ method: 'POST', url: `/api/scripts/${scriptId}/run`, headers });
}

export interface StartedRun {
  id: number;
  /** The Jenkins queue item the run waits in. */
  queueId: number;
  /** The run token Jenkins was given. */
  token: string;
}

/** Starts a run as the USER and throws unless it was accepted. */
export async function startRun(world: RunWorld, stub: JenkinsStub): Promise<StartedRun> {
  const res = await run(world);
  if (res.statusCode !== 201) throw new Error(`run failed: ${res.statusCode} ${res.body}`);
  const id: number = res.json().execution.id;
  const row = await world.ctx.db('test_executions').where({ id }).first('jenkins_queue_id');
  return { id, queueId: row.jenkins_queue_id, token: stub.lastParams.RUN_TOKEN };
}

/** When the stub's builds started (milliseconds since the epoch). */
export const STARTED = 1_790_000_000_000;

/** GET /executions/:id, after moving the clock past the 2-second sync limit. */
export async function poll(world: RunWorld, id: number, headers: Headers = world.asUser) {
  world.clock.t += 2_001;
  return world.ctx.app.inject({ method: 'GET', url: `/api/executions/${id}`, headers });
}

/** Tells the stub the queued run became build `number`. The build is still running unless `build` says otherwise. */
export function setBuild(stub: JenkinsStub, queueId: number, number: number, build: Partial<StubBuild> = {}): void {
  const item = stub.queue.get(queueId);
  if (!item) throw new Error(`the stub has no queue item ${queueId}`);
  item.buildNumber = number;
  stub.builds.set(`${JOB}/${number}`, { building: true, result: null, timestamp: STARTED, duration: 0, ...build });
}
