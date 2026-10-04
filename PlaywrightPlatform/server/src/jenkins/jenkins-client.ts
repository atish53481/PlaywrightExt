import { jenkinsJobUrl } from './urls';

export type JenkinsErrorKind = 'UNREACHABLE' | 'REJECTED' | 'NOT_FOUND';

export class JenkinsError extends Error {
  constructor(
    public readonly kind: JenkinsErrorKind,
    message: string,
  ) {
    super(message);
    this.name = 'JenkinsError';
  }
}

export interface JenkinsConnection {
  baseUrl: string;
  username: string;
  token: string;
}

export interface QueueState {
  cancelled: boolean;
  /** Null while the item is still waiting for an agent. */
  buildNumber: number | null;
}

export interface BuildState {
  building: boolean;
  result: 'SUCCESS' | 'UNSTABLE' | 'FAILURE' | 'ABORTED' | 'NOT_BUILT' | null;
  /** Start time, milliseconds since the epoch. */
  timestamp: number;
  /** Milliseconds; 0 while building. */
  duration: number;
}

export type FetchFn = typeof fetch;

const TIMEOUT_MS = 10_000;

/** The only code that talks to Jenkins. Authenticates with a username and API token, so no CSRF crumb is needed. */
export class JenkinsClient {
  constructor(
    private readonly conn: JenkinsConnection,
    private readonly fetchFn: FetchFn = fetch,
  ) {}

  private job(name: string): string {
    return `/job/${encodeURIComponent(name)}`;
  }

  jobUrl(name: string): string {
    return jenkinsJobUrl(this.conn.baseUrl, name);
  }

  private async call(path: string, init: { method?: string; body?: string; contentType?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.conn.username}:${this.conn.token}`).toString('base64')}`,
    };
    if (init.contentType) headers['Content-Type'] = init.contentType;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.conn.baseUrl}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: init.body,
        // Jenkins answers some POSTs with a redirect to a page; the redirect itself is the success.
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new JenkinsError('UNREACHABLE', `Jenkins did not answer at ${this.conn.baseUrl}.`);
    }
    if (res.status === 401 || res.status === 403) {
      throw new JenkinsError('REJECTED', 'Jenkins refused the username or API token.');
    }
    if (res.status === 404) throw new JenkinsError('NOT_FOUND', 'Jenkins does not have that item.');
    if (res.status >= 400) throw new JenkinsError('UNREACHABLE', `Jenkins answered with status ${res.status}.`);
    return res;
  }

  async version(): Promise<string> {
    const res = await this.call('/api/json');
    return res.headers.get('x-jenkins') ?? 'unknown';
  }

  /** The given plugins that Jenkins does not have installed and active. */
  async missingPlugins(shortNames: string[]): Promise<string[]> {
    const res = await this.call('/pluginManager/api/json?depth=1');
    const data = (await res.json()) as { plugins?: Array<{ shortName: string; active?: boolean }> };
    const active = new Set((data.plugins ?? []).filter((p) => p.active !== false).map((p) => p.shortName));
    return shortNames.filter((name) => !active.has(name));
  }

  async jobExists(name: string): Promise<boolean> {
    try {
      await this.call(`${this.job(name)}/api/json`);
      return true;
    } catch (err) {
      if (err instanceof JenkinsError && err.kind === 'NOT_FOUND') return false;
      throw err;
    }
  }

  async createOrUpdateJob(name: string, configXml: string): Promise<{ created: boolean }> {
    const body = { method: 'POST', body: configXml, contentType: 'application/xml' };
    if (await this.jobExists(name)) {
      await this.call(`${this.job(name)}/config.xml`, body);
      return { created: false };
    }
    await this.call(`/createItem?name=${encodeURIComponent(name)}`, body);
    return { created: true };
  }

  /** Starts a build and returns the id of its queue item. */
  async trigger(name: string, params: Record<string, string>): Promise<number> {
    const res = await this.call(`${this.job(name)}/buildWithParameters`, {
      method: 'POST',
      body: new URLSearchParams(params).toString(),
      contentType: 'application/x-www-form-urlencoded',
    });
    const match = /\/queue\/item\/(\d+)/.exec(res.headers.get('location') ?? '');
    if (!match) throw new JenkinsError('UNREACHABLE', 'Jenkins accepted the build but did not say where it is queued.');
    return Number(match[1]);
  }

  async queueItem(id: number): Promise<QueueState> {
    const res = await this.call(`/queue/item/${id}/api/json`);
    const data = (await res.json()) as { cancelled?: boolean; executable?: { number?: number } | null };
    return { cancelled: Boolean(data.cancelled), buildNumber: data.executable?.number ?? null };
  }

  async build(name: string, buildNumber: number): Promise<BuildState> {
    const res = await this.call(`${this.job(name)}/${buildNumber}/api/json`);
    const data = (await res.json()) as Partial<BuildState>;
    return {
      building: Boolean(data.building),
      result: data.result ?? null,
      timestamp: Number(data.timestamp ?? 0),
      duration: Number(data.duration ?? 0),
    };
  }

  async stopBuild(name: string, buildNumber: number): Promise<void> {
    await this.call(`${this.job(name)}/${buildNumber}/stop`, { method: 'POST' });
  }

  private artifactPath(name: string, buildNumber: number, path: string): string {
    return `${this.job(name)}/${buildNumber}/artifact/${path.split('/').map(encodeURIComponent).join('/')}`;
  }

  /** Whether a build archived a file at this path. */
  async artifactExists(name: string, buildNumber: number, path: string): Promise<boolean> {
    try {
      await this.call(this.artifactPath(name, buildNumber, path), { method: 'HEAD' });
      return true;
    } catch (err) {
      if (err instanceof JenkinsError && err.kind === 'NOT_FOUND') return false;
      throw err;
    }
  }

  /** One archived file of a build, read whole. Refused when it is larger than `maxBytes`. */
  async artifact(name: string, buildNumber: number, path: string, maxBytes: number): Promise<{ contentType: string; body: Buffer }> {
    const res = await this.call(this.artifactPath(name, buildNumber, path));
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > maxBytes) throw new JenkinsError('NOT_FOUND', 'That file is too large to show.');
    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > maxBytes) throw new JenkinsError('NOT_FOUND', 'That file is too large to show.');
    return { contentType: (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase(), body };
  }

  /** Removes a build with its log and archived report. A build Jenkins no longer has counts as removed. */
  async deleteBuild(name: string, buildNumber: number): Promise<void> {
    try {
      await this.call(`${this.job(name)}/${buildNumber}/doDelete`, { method: 'POST' });
    } catch (err) {
      if (err instanceof JenkinsError && err.kind === 'NOT_FOUND') return;
      throw err;
    }
  }

  /** Jenkins answers 404 once the item has left the queue; that is not a failure to cancel. */
  async cancelQueue(id: number): Promise<void> {
    try {
      await this.call(`/queue/cancelItem?id=${id}`, { method: 'POST' });
    } catch (err) {
      if (err instanceof JenkinsError && err.kind === 'NOT_FOUND') return;
      throw err;
    }
  }
}
