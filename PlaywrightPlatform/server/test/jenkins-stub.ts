import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface StubBuild {
  building: boolean;
  result: 'SUCCESS' | 'UNSTABLE' | 'FAILURE' | 'ABORTED' | 'NOT_BUILT' | null;
  timestamp: number;
  duration: number;
}

export interface StubRequest {
  method: string;
  path: string;
  authorization: string;
  body: string;
}

export interface JenkinsStub {
  url: string;
  username: string;
  token: string;
  /** Job names that exist. */
  jobs: Set<string>;
  /** Last config.xml sent for each job. */
  configs: Map<string, string>;
  /** Queue id → state. `buildNumber` null means still waiting. */
  queue: Map<number, { cancelled: boolean; buildNumber: number | null }>;
  /** `${job}/${number}` → build. */
  builds: Map<string, StubBuild>;
  /** `${job}/${number}/${path}` → an archived file of that build. */
  artifacts: Map<string, { contentType: string; body: Buffer }>;
  plugins: string[];
  /** When true the plugin list answers 403, as Jenkins does for a user who may not view plugins. */
  forbidPluginList: boolean;
  requests: StubRequest[];
  /** When set, every request is answered with this status. */
  failWith: number | null;
  /** Parameters of the last triggered build. */
  lastParams: Record<string, string>;
  /** Back to an empty Jenkins that answers normally. */
  reset(): void;
  /**
   * Holds back the answer to the next request until `release` is called. The answer is the
   * one Jenkins would have given when the request arrived; `arrived` resolves at that moment.
   */
  holdNext(): { arrived: Promise<void>; release: () => void };
  close(): Promise<void>;
}

/** What a Jenkins that can run the platform's job has installed. */
const PIPELINE_PLUGINS = ['workflow-job', 'workflow-cps', 'pipeline-model-definition'];

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => resolve(body));
  });
}

/** A local stand-in for the parts of the Jenkins REST API the client uses. */
export async function startJenkinsStub(): Promise<JenkinsStub> {
  let nextQueueId = 100;
  let hold: { arrived: () => void; released: Promise<void> } | null = null;
  const stub: JenkinsStub = {
    url: '',
    username: 'ci-user',
    token: 'ci-token',
    jobs: new Set(),
    configs: new Map(),
    queue: new Map(),
    builds: new Map(),
    artifacts: new Map(),
    plugins: [...PIPELINE_PLUGINS],
    forbidPluginList: false,
    requests: [],
    failWith: null,
    lastParams: {},
    reset() {
      stub.jobs.clear();
      stub.configs.clear();
      stub.queue.clear();
      stub.builds.clear();
      stub.artifacts.clear();
      stub.plugins = [...PIPELINE_PLUGINS];
      stub.forbidPluginList = false;
      stub.requests.length = 0;
      stub.failWith = null;
      stub.lastParams = {};
      hold = null;
    },
    holdNext() {
      let release = (): void => undefined;
      let arrived = (): void => undefined;
      // A promise's executor runs at once, so both functions are set before they are used.
      const released = new Promise<void>((resolve) => (release = resolve));
      const arrivedPromise = new Promise<void>((resolve) => (arrived = resolve));
      hold = { arrived, released };
      return { arrived: arrivedPromise, release };
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://stub');
    const path = url.pathname;
    const body = await readBody(req);
    const held = hold;
    hold = null;
    stub.requests.push({ method: req.method ?? 'GET', path: path + url.search, authorization: req.headers.authorization ?? '', body });
    const send = (status: number, payload?: unknown, headers: Record<string, string> = {}) => {
      // Serialised now, so a held answer still shows the state at the time of the request.
      const text = payload === undefined ? '' : JSON.stringify(payload);
      const write = () => {
        res.writeHead(status, { 'X-Jenkins': '2.555.2', 'Content-Type': 'application/json', ...headers });
        res.end(text);
      };
      if (!held) return write();
      held.arrived();
      void held.released.then(write);
    };

    if (stub.failWith !== null) return send(stub.failWith);
    const expected = `Basic ${Buffer.from(`${stub.username}:${stub.token}`).toString('base64')}`;
    if (req.headers.authorization !== expected) return send(401);

    if (req.method === 'GET' && path === '/api/json') return send(200, { mode: 'NORMAL' });
    if (req.method === 'GET' && path === '/pluginManager/api/json') {
      if (stub.forbidPluginList) return send(403);
      return send(200, { plugins: stub.plugins.map((shortName) => ({ shortName, active: true })) });
    }
    if (req.method === 'POST' && path === '/createItem') {
      const name = url.searchParams.get('name') ?? '';
      stub.jobs.add(name);
      stub.configs.set(name, body);
      return send(200);
    }
    if (req.method === 'POST' && path === '/queue/cancelItem') {
      const item = stub.queue.get(Number(url.searchParams.get('id')));
      if (!item) return send(404);
      item.cancelled = true;
      return send(204);
    }
    const queueMatch = /^\/queue\/item\/(\d+)\/api\/json$/.exec(path);
    if (req.method === 'GET' && queueMatch) {
      const item = stub.queue.get(Number(queueMatch[1]));
      if (!item) return send(404);
      return send(200, { cancelled: item.cancelled, executable: item.buildNumber === null ? null : { number: item.buildNumber } });
    }
    const jobMatch = /^\/job\/([^/]+)\/(.*)$/.exec(path);
    if (jobMatch) {
      const job = decodeURIComponent(jobMatch[1]);
      const rest = jobMatch[2];
      if (!stub.jobs.has(job)) return send(404);
      if (req.method === 'GET' && rest === 'api/json') return send(200, { name: job });
      if (req.method === 'POST' && rest === 'config.xml') {
        stub.configs.set(job, body);
        return send(200);
      }
      if (req.method === 'POST' && rest === 'buildWithParameters') {
        stub.lastParams = Object.fromEntries(new URLSearchParams(body));
        const id = nextQueueId++;
        stub.queue.set(id, { cancelled: false, buildNumber: null });
        return send(201, undefined, { Location: `${stub.url}/queue/item/${id}/` });
      }
      const artifactMatch = /^(\d+)\/artifact\/(.+)$/.exec(rest);
      if (req.method === 'GET' && artifactMatch) {
        const file = stub.artifacts.get(`${job}/${artifactMatch[1]}/${decodeURIComponent(artifactMatch[2])}`);
        if (!file) return send(404);
        res.writeHead(200, { 'Content-Type': file.contentType, 'Content-Length': String(file.body.length) });
        res.end(file.body);
        return;
      }
      const buildMatch = /^(\d+)\/(api\/json|stop|doDelete)$/.exec(rest);
      if (buildMatch) {
        const build = stub.builds.get(`${job}/${buildMatch[1]}`);
        if (!build) return send(404);
        if (req.method === 'POST' && buildMatch[2] === 'doDelete') {
          stub.builds.delete(`${job}/${buildMatch[1]}`);
          return send(302, undefined, { Location: `${stub.url}/job/${job}/` });
        }
        if (req.method === 'GET' && buildMatch[2] === 'api/json') return send(200, build);
        if (req.method === 'POST' && buildMatch[2] === 'stop') {
          build.building = false;
          build.result = 'ABORTED';
          return send(302, undefined, { Location: `${stub.url}/job/${job}/${buildMatch[1]}/` });
        }
      }
    }
    return send(404);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return stub;
}
