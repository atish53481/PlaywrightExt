# Platform Jenkins Execution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in person browse projects and stored scripts in the extension side panel and run a stored script on Jenkins from there, with live status, stop, and run history.

**Architecture:** The extension calls only the platform API. The server stores the Jenkins connection (token encrypted), triggers one parameterised Pipeline job, and reads status back from Jenkins each time the panel polls. The pipeline downloads the exact script version from the platform with a one-time run token and posts test counts back.

**Tech Stack:** Fastify 5, Knex, PostgreSQL, zod, Vitest (server); plain ES modules and `node --test` (extension); Jenkins Pipeline with Windows `bat` steps.

**Spec:** `docs/superpowers/specs/2026-10-03-platform-jenkins-design.md`

## Global Constraints

- Branch `feat/platform-jenkins`. Work from the repo root `PlaywrightExt/` unless a step says otherwise.
- Work in the existing checkout; do not create a new worktree or clone. This machine has `core.autocrlf=true` and the repo has no `.gitattributes`, so a fresh checkout would give the test fixtures CRLF line endings, and the server tests that compare script content would fail.
- No database migration. Every table and column used exists in `PlaywrightPlatform/server/src/migrations/005_ci_execution.ts`.
- The web app (`PlaywrightPlatform/web`) is not changed.
- Layering: `routes/` → `services/` → `repositories/`. Only repositories query the database. Only `src/jenkins/jenkins-client.ts` calls Jenkins.
- The Jenkins API token is never returned by an endpoint and never written to the audit log or the server log.
- Settings row: `jenkins_configurations.name = 'default'`. Default job name: `playwright-platform-run`.
- Field limits: URL `http`/`https`, at most 300 characters, trailing slash removed; username 1–100; token 1–200; job name 1–100 characters from `[A-Za-z0-9_.-]`.
- Error codes and statuses exactly as spec section 6.2: `JENKINS_NOT_CONFIGURED` 409, `PROJECT_NOT_ACTIVE` 409, `EXECUTION_FINISHED` 409, `RUN_IN_PROGRESS` 409, `JENKINS_UNREACHABLE` 502, `JENKINS_REJECTED` 502, `UNAUTHENTICATED` 401, `NOT_FOUND` 404.
- Run token: 32 random bytes, base64url; only its SHA-256 hex hash is stored; constant-time comparison; valid only while the execution is `QUEUED` or `RUNNING`.
- Sync is limited to once per 2 seconds per execution. A queued run older than 10 minutes becomes `ERROR`.
- Extension: text that came from the server is written with `textContent`, never `innerHTML`. New logic that needs no DOM lives in `utils/` and is tested with `node --test`.
- Server commands run in `PlaywrightPlatform/`: `npm test -w server -- <file>` for one file, `npm test` for all, `npm run typecheck`. PostgreSQL must be up (`npm run db:up`).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Decisions Made in This Plan

1. **Build number comes from the pipeline.** Jenkins forgets a queue item about five minutes after the build starts, so a panel that was closed could never learn the build number from the queue. The pipeline sends `X-Build-Number` when it downloads the script, and the server stores it. Sync uses the build when the number is known, the queue item otherwise.
2. **`UNSTABLE` is always `FAILED`.** The pipeline marks a build `UNSTABLE` only when `npx playwright test` exits non-zero, so the tests ran. `FAILURE` is `FAILED` when the callback reported at least one test, otherwise `ERROR`.
3. **The 2-second sync limit is kept in memory** (a `Map` in the execution service). The table has no column for it and a restart only costs one extra Jenkins call.
4. **Tests use a real local HTTP stub of Jenkins,** started per test file on a free port. Settings are saved with the stub's URL, so the real `JenkinsClient` and real `fetch` are exercised.
5. **Job parameters are declared in the job's `config.xml`,** not in a `parameters {}` block, so the first build already has them.
6. **Stop on a running build returns the state Jenkins reports right after the stop request,** which may still be `RUNNING`; the panel keeps polling until `ABORTED`. Stop on a queued run sets `ABORTED` at once.
7. **A first save of settings requires the token;** later saves may omit it.
8. **A finished run marks the script.** `PASSED` or `FAILED` is written to the script's `lifecycle_state`, but only while the script is still at the version that ran. The web app's project overview counts scripts by that state; without this it would show "Not Executed" beside a fresh "Last Execution" time. `ERROR` and `ABORTED` leave the state alone. The scripts spec left these states to "later sub-projects"; the Jenkins spec does not mention them.
9. **Run brings an unfinished run up to date before refusing.** A run's status changes only when someone reads it, so a run whose panel was closed still reads `RUNNING`. `POST /scripts/:id/run` asks Jenkins about that run first and answers `RUN_IN_PROGRESS` only if it is still unfinished. The error's `details` carry `executionId`.
10. **A run given up after 10 minutes in the queue is also cancelled in Jenkins,** so it cannot start later with a token that no longer works.
11. **Time is read through `AppDeps.now`** (default `Date.now`), and `created_at` is written from it. Tests move a clock instead of waiting, and the queue timeout does not depend on the database clock agreeing with the server clock. Each run test builds a fresh app, because the sync limit lives in memory.
12. **Links are built when a run is read,** from the saved Jenkins address, the job the run used, and the build number. `report_url` is also stored, as spec section 5 lists it.
13. **Link check for people who are not administrators.** Spec section 6 hides the Jenkins address from them, so their panel cannot compare a link against it as section 9 asks. Their panel offers `http` and `https` links only; an ADMIN's panel also requires the link to be under the saved Jenkins address.
14. **The script search parameter is `search`.** Spec section 9 calls it `q`; the existing endpoint takes `search`.
15. **The pipeline's download command starts with `@`,** so `cmd` does not echo the line. Without it the run token would be printed in the build log.

## Review Focus

1. **The side panel is closed while a run is in progress, and Run is pressed again later** — the old run must not block a new one forever. Pinned in Task 5 (`a run nobody watched is brought up to date before a new run is refused`) and in the Task 9 checklist (item 7).
2. **Two polls overlap and the slower one carries older news** — a finished run must not go back to `RUNNING`. Pinned in Task 5 (`a late answer from Jenkins cannot reopen a finished run`).
3. **Two people press Run on the same script at the same moment** — one run starts, the other is told a run is in progress. Pinned in Task 4 (`two simultaneous runs`).
4. **The script is edited or deleted, or its project archived, after Run is pressed** — the build still gets the version that was current at Run, and the run can still be read. Pinned in Task 6 (`serves the recorded version after the script is edited, deleted, and its project archived`).
5. **Server text with markup in a script name, error message, or Jenkins URL reaches the side panel** — shown as text; a link is offered only for an `http` or `https` address. Pinned in Task 7 (`safeJenkinsLink`, `statusView`) and checked by grep in Task 8.

## File Map

| File | Task | Responsibility |
|---|---|---|
| `PlaywrightPlatform/server/src/crypto/secret-box.ts` | 1 | AES-256-GCM encrypt and decrypt |
| `PlaywrightPlatform/server/src/config.ts` | 1 | Adds `PLATFORM_PUBLIC_URL` → `config.publicUrl` |
| `PlaywrightPlatform/server/src/jenkins/jenkins-client.ts` | 2 | The only code that calls Jenkins |
| `PlaywrightPlatform/server/src/jenkins/urls.ts` | 2 | Addresses of Jenkins pages (pure) |
| `PlaywrightPlatform/server/src/jenkins/pipeline.ts` | 2 | Pipeline text and job `config.xml` |
| `PlaywrightPlatform/server/test/jenkins-stub.ts` | 2 | Local HTTP stand-in for Jenkins |
| `PlaywrightPlatform/server/src/repositories/jenkins-repository.ts` | 3 | Settings row and `project_ci_jobs` |
| `PlaywrightPlatform/server/src/services/jenkins-service.ts` | 3 | Settings rules, test connection, create job |
| `PlaywrightPlatform/server/src/schemas/jenkins.ts`, `src/routes/jenkins.ts` | 3 | `/jenkins/*` |
| `PlaywrightPlatform/server/src/repositories/execution-repository.ts` | 4, 5 | `test_executions` queries |
| `PlaywrightPlatform/server/src/services/execution-service.ts` | 4, 5, 6 | Run, read, list (4); sync (5); stop and the pipeline endpoints (6) |
| `PlaywrightPlatform/server/src/schemas/executions.ts`, `src/routes/executions.ts` | 4, 6 | `/scripts/:id/run`, `/executions/*` |
| `PlaywrightPlatform/server/src/repositories/script-repository.ts` | 5 | Adds `markRunResult` |
| `PlaywrightPlatform/server/src/types.ts`, `src/repositories/index.ts`, `src/app.ts` | 3, 4 | Types and wiring |
| `PlaywrightPlatform/server/test/helpers.ts`, `test/execution-helpers.ts` | 4, 5 | Set-up shared by the run tests |
| `PlaywrightExtension/utils/platform-client.js` | 7 | New API methods |
| `PlaywrightExtension/utils/execution-view.js` | 7 | Status text, run controls, safe link check |
| `PlaywrightExtension/sidepanel.html`, `sidepanel.css`, `sidepanel.js` | 8 | Projects tab, Jenkins settings block |
| `PlaywrightPlatform/README.md`, `PlaywrightPlatform/.env.example`, `CLAUDE.md` | 9 | Documentation |

---

### Task 1: Secret box and public URL setting

**Files:**
- Create: `PlaywrightPlatform/server/src/crypto/secret-box.ts`
- Modify: `PlaywrightPlatform/server/src/config.ts`
- Modify: `PlaywrightPlatform/.env.example`
- Test: `PlaywrightPlatform/server/test/secret-box.test.ts`

**Interfaces:**
- Produces: `createSecretBox(key: Buffer): SecretBox` with `encrypt(text: string): string` and `decrypt(ciphertext: string): string`; `Config.publicUrl: string`.

- [ ] **Step 1: Write the failing test**

Create `PlaywrightPlatform/server/test/secret-box.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/crypto/secret-box';
import { testConfig } from './helpers';

describe('secret box', () => {
  const box = createSecretBox(Buffer.alloc(32, 7));

  it('round-trips text and never stores it readable', () => {
    const sealed = box.encrypt('jenkins-token-123');
    expect(sealed).not.toContain('jenkins-token-123');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(box.decrypt(sealed)).toBe('jenkins-token-123');
  });

  it('gives a different ciphertext each time', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects a changed ciphertext, a wrong key, and text that is not a ciphertext', () => {
    const sealed = box.encrypt('secret');
    const parts = sealed.split(':');
    const body = Buffer.from(parts[3], 'base64');
    body[0] ^= 1;
    const changed = [parts[0], parts[1], parts[2], body.toString('base64')].join(':');
    expect(() => box.decrypt(changed)).toThrow();
    expect(() => createSecretBox(Buffer.alloc(32, 8)).decrypt(sealed)).toThrow();
    expect(() => box.decrypt('plain text')).toThrow('Stored secret is not readable.');
  });
});

describe('config: public URL', () => {
  it('defaults to the loopback address and port', () => {
    expect(testConfig({ APP_PORT: '3456' }).publicUrl).toBe('http://127.0.0.1:3456');
  });

  it('uses PLATFORM_PUBLIC_URL without its trailing slash', () => {
    expect(testConfig({ PLATFORM_PUBLIC_URL: 'http://build-host:3000/' }).publicUrl).toBe('http://build-host:3000');
  });

  it('refuses a value that is not an http or https URL', () => {
    expect(() => testConfig({ PLATFORM_PUBLIC_URL: 'ftp://x' })).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run (in `PlaywrightPlatform/`): `npm test -w server -- test/secret-box.test.ts`
Expected: FAIL — cannot find module `../src/crypto/secret-box`.

- [ ] **Step 3: Write the secret box**

Create `PlaywrightPlatform/server/src/crypto/secret-box.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretBox {
  encrypt(text: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * AES-256-GCM. The stored form is `v1:<iv>:<tag>:<data>`, each part base64.
 * A changed ciphertext or a different key makes decrypt throw.
 */
export function createSecretBox(key: Buffer): SecretBox {
  return {
    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    },
    decrypt(ciphertext) {
      const [version, iv, tag, data] = ciphertext.split(':');
      if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Stored secret is not readable.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
```

- [ ] **Step 4: Add the setting**

In `PlaywrightPlatform/server/src/config.ts`, add to `envSchema` after `LOGIN_RATE_LIMIT_MAX`:

```ts
  // The address Jenkins uses to reach this server. Empty means loopback on APP_PORT.
  PLATFORM_PUBLIC_URL: z
    .string()
    .default('')
    .refine((v) => v === '' || /^https?:\/\/[^\s]+$/i.test(v), 'must be an http or https URL'),
```

Add to the `Config` interface:

```ts
  /** Base URL that Jenkins builds use to call back, without a trailing slash. */
  publicUrl: string;
```

Add to the object returned by `loadConfig`:

```ts
    publicUrl: e.PLATFORM_PUBLIC_URL.replace(/\/+$/, '') || `http://127.0.0.1:${e.APP_PORT}`,
```

Append to `PlaywrightPlatform/.env.example`:

```
# Address Jenkins builds use to reach this server. Leave empty when Jenkins runs on
# this machine (http://127.0.0.1:<APP_PORT> is used).
PLATFORM_PUBLIC_URL=
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test -w server -- test/secret-box.test.ts` then `npm run typecheck`
Expected: 6 passed; typecheck prints no errors.

- [ ] **Step 6: Commit**

```bash
git add PlaywrightPlatform/server/src/crypto/secret-box.ts PlaywrightPlatform/server/src/config.ts PlaywrightPlatform/server/test/secret-box.test.ts PlaywrightPlatform/.env.example
git commit -m "feat(platform): add secret encryption and the public URL setting"
```

---

### Task 2: Jenkins client, pipeline text, and the Jenkins stub

**Files:**
- Create: `PlaywrightPlatform/server/src/jenkins/urls.ts`
- Create: `PlaywrightPlatform/server/src/jenkins/jenkins-client.ts`
- Create: `PlaywrightPlatform/server/src/jenkins/pipeline.ts`
- Create: `PlaywrightPlatform/server/test/jenkins-stub.ts`
- Test: `PlaywrightPlatform/server/test/jenkins-client.test.ts`

**Interfaces:**
- Produces:
  - `class JenkinsError extends Error { kind: 'UNREACHABLE' | 'REJECTED' | 'NOT_FOUND' }`
  - `interface JenkinsConnection { baseUrl: string; username: string; token: string }`
  - `class JenkinsClient(conn, fetchFn = fetch)` with `version(): Promise<string>`, `hasPlugin(name): Promise<boolean>`, `jobExists(job): Promise<boolean>`, `createOrUpdateJob(job, configXml): Promise<{ created: boolean }>`, `trigger(job, params: Record<string, string>): Promise<number>` (queue id), `queueItem(id): Promise<QueueState>`, `build(job, n): Promise<BuildState>`, `stopBuild(job, n): Promise<void>`, `cancelQueue(id): Promise<void>`, `jobUrl(job): string`
  - `interface QueueState { cancelled: boolean; buildNumber: number | null }`
  - `interface BuildState { building: boolean; result: 'SUCCESS' | 'UNSTABLE' | 'FAILURE' | 'ABORTED' | 'NOT_BUILT' | null; timestamp: number; duration: number }`
  - From `urls.ts`: `jenkinsJobUrl(baseUrl, job): string`, `jenkinsBuildUrl(baseUrl, job, n): string`, `jenkinsReportUrl(baseUrl, job, n): string`
  - `pipelineScript(): string`, `jobConfigXml(): string`
  - Test helper `startJenkinsStub(): Promise<JenkinsStub>` (fields listed in Step 1), including `reset(): void` and `holdNext(): { arrived: Promise<void>; release: () => void }`

- [ ] **Step 1: Write the Jenkins stub**

Create `PlaywrightPlatform/server/test/jenkins-stub.ts`:

```ts
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
    plugins: ['workflow-aggregator'],
    forbidPluginList: false,
    requests: [],
    failWith: null,
    lastParams: {},
    reset() {
      stub.jobs.clear();
      stub.configs.clear();
      stub.queue.clear();
      stub.builds.clear();
      stub.plugins = ['workflow-aggregator'];
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
      const buildMatch = /^(\d+)\/(api\/json|stop)$/.exec(rest);
      if (buildMatch) {
        const build = stub.builds.get(`${job}/${buildMatch[1]}`);
        if (!build) return send(404);
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
```

- [ ] **Step 2: Write the failing test**

Create `PlaywrightPlatform/server/test/jenkins-client.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JenkinsClient, JenkinsError } from '../src/jenkins/jenkins-client';
import { jobConfigXml, pipelineScript } from '../src/jenkins/pipeline';
import { jenkinsBuildUrl, jenkinsJobUrl, jenkinsReportUrl } from '../src/jenkins/urls';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';

describe('jenkins client', () => {
  let stub: JenkinsStub;
  let client: JenkinsClient;

  beforeAll(async () => {
    stub = await startJenkinsStub();
  });
  afterAll(() => stub.close());
  beforeEach(() => {
    stub.reset();
    client = new JenkinsClient({ baseUrl: stub.url, username: stub.username, token: stub.token });
  });

  const kindOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (err) {
      return err instanceof JenkinsError ? err.kind : `not a JenkinsError: ${String(err)}`;
    }
    return 'no error';
  };

  it('reads the version and sends basic authentication', async () => {
    expect(await client.version()).toBe('2.555.2');
    expect(stub.requests[0].authorization).toBe(`Basic ${Buffer.from('ci-user:ci-token').toString('base64')}`);
  });

  it('reports whether a plugin is installed', async () => {
    expect(await client.hasPlugin('workflow-aggregator')).toBe(true);
    stub.plugins = [];
    expect(await client.hasPlugin('workflow-aggregator')).toBe(false);
  });

  it('creates a job that does not exist and updates one that does', async () => {
    expect(await client.jobExists('runner')).toBe(false);
    expect(await client.createOrUpdateJob('runner', '<a/>')).toEqual({ created: true });
    expect(await client.jobExists('runner')).toBe(true);
    expect(await client.createOrUpdateJob('runner', '<b/>')).toEqual({ created: false });
    expect(stub.configs.get('runner')).toBe('<b/>');
  });

  it('triggers a build with parameters and returns the queue id', async () => {
    stub.jobs.add('runner');
    const queueId = await client.trigger('runner', { EXECUTION_ID: '7', RUN_TOKEN: 'a b&c' });
    expect(stub.queue.has(queueId)).toBe(true);
    expect(stub.lastParams).toEqual({ EXECUTION_ID: '7', RUN_TOKEN: 'a b&c' });
  });

  it('reads a queue item before and after the build starts, and when cancelled', async () => {
    stub.jobs.add('runner');
    const id = await client.trigger('runner', {});
    expect(await client.queueItem(id)).toEqual({ cancelled: false, buildNumber: null });
    stub.queue.get(id)!.buildNumber = 41;
    expect(await client.queueItem(id)).toEqual({ cancelled: false, buildNumber: 41 });
    await client.cancelQueue(id);
    expect((await client.queueItem(id)).cancelled).toBe(true);
  });

  it('reads and stops a build', async () => {
    stub.jobs.add('runner');
    stub.builds.set('runner/41', { building: true, result: null, timestamp: 1_700_000_000_000, duration: 0 });
    expect(await client.build('runner', 41)).toEqual({ building: true, result: null, timestamp: 1_700_000_000_000, duration: 0 });
    await client.stopBuild('runner', 41);
    expect((await client.build('runner', 41)).result).toBe('ABORTED');
  });

  it('cancelling a queue item Jenkins no longer knows is not an error', async () => {
    await expect(client.cancelQueue(999)).resolves.toBeUndefined();
  });

  it('builds job, build, and report addresses', () => {
    expect(client.jobUrl('runner')).toBe(`${stub.url}/job/runner/`);
    expect(jenkinsJobUrl('http://ci', 'my job')).toBe('http://ci/job/my%20job/');
    expect(jenkinsBuildUrl('http://ci', 'runner', 41)).toBe('http://ci/job/runner/41/');
    expect(jenkinsReportUrl('http://ci', 'runner', 41)).toBe(
      'http://ci/job/runner/41/artifact/playwright-report/index.html',
    );
  });

  it('classifies failures', async () => {
    expect(await kindOf(client.build('missing', 1))).toBe('NOT_FOUND');
    stub.failWith = 403;
    expect(await kindOf(client.version())).toBe('REJECTED');
    stub.failWith = 503;
    expect(await kindOf(client.version())).toBe('UNREACHABLE');
    stub.failWith = null;
    const wrongToken = new JenkinsClient({ baseUrl: stub.url, username: 'ci-user', token: 'nope' });
    expect(await kindOf(wrongToken.version())).toBe('REJECTED');
    const nobodyHome = new JenkinsClient({ baseUrl: 'http://127.0.0.1:1', username: 'u', token: 't' });
    expect(await kindOf(nobodyHome.version())).toBe('UNREACHABLE');
  });
});

describe('pipeline text', () => {
  it('uses the three parameters and holds no secret', () => {
    const script = pipelineScript();
    expect(script).toContain('%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script');
    expect(script).toContain('Authorization: Bearer %RUN_TOKEN%');
    expect(script).toContain('X-Build-Number: %BUILD_NUMBER%');
    expect(script).toContain("archiveArtifacts artifacts: 'playwright-report/**'");
    // The @ keeps cmd from echoing the line, which would print the run token in the build log.
    expect(script).toContain("bat '@curl ");
  });

  it('wraps the pipeline in a job definition with the parameters declared and markup escaped', () => {
    const xml = jobConfigXml();
    expect(xml).toContain('<name>EXECUTION_ID</name>');
    expect(xml).toContain('<name>PLATFORM_URL</name>');
    expect(xml).toContain('<hudson.model.PasswordParameterDefinition>');
    expect(xml).toContain('<name>RUN_TOKEN</name>');
    expect(xml).toContain('<sandbox>true</sandbox>');
    const scriptPart = xml.slice(xml.indexOf('<script>') + 8, xml.indexOf('</script>'));
    expect(scriptPart).not.toMatch(/<|>/);
    expect(scriptPart).toContain('=&gt;');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/jenkins-client.test.ts`
Expected: FAIL — cannot find module `../src/jenkins/jenkins-client`.

- [ ] **Step 4: Write the address helpers and the client**

Create `PlaywrightPlatform/server/src/jenkins/urls.ts`:

```ts
// Addresses of Jenkins pages. Pure functions, so a link can be built without calling Jenkins.

export function jenkinsJobUrl(baseUrl: string, job: string): string {
  return `${baseUrl}/job/${encodeURIComponent(job)}/`;
}

export function jenkinsBuildUrl(baseUrl: string, job: string, buildNumber: number): string {
  return `${jenkinsJobUrl(baseUrl, job)}${buildNumber}/`;
}

/** Where the Playwright report archived by the pipeline opens. */
export function jenkinsReportUrl(baseUrl: string, job: string, buildNumber: number): string {
  return `${jenkinsBuildUrl(baseUrl, job, buildNumber)}artifact/playwright-report/index.html`;
}
```

Create `PlaywrightPlatform/server/src/jenkins/jenkins-client.ts`:

```ts
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

  async hasPlugin(shortName: string): Promise<boolean> {
    const res = await this.call('/pluginManager/api/json?depth=1');
    const data = (await res.json()) as { plugins?: Array<{ shortName: string; active?: boolean }> };
    return (data.plugins ?? []).some((p) => p.shortName === shortName && p.active !== false);
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
```

- [ ] **Step 5: Write the pipeline text**

Create `PlaywrightPlatform/server/src/jenkins/pipeline.ts`:

```ts
// The Jenkins job the platform creates. Windows agents only: every command is a `bat` step.
// The build receives EXECUTION_ID, PLATFORM_URL, and RUN_TOKEN (a password parameter, so
// Jenkins masks it) and holds no secret in its definition.

const PACKAGE_JSON = `{
  "name": "playwright-platform-run",
  "private": true,
  "devDependencies": { "@playwright/test": "^1.49.0" }
}
`;

const PLAYWRIGHT_CONFIG = `import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  reporter: [['html', { open: 'never' }], ['json', { outputFile: 'results.json' }]],
  use: { headless: true },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
`;

// Reads Playwright's JSON report and posts the counts to the platform. Exits quietly when
// there is no report (the build failed before the tests ran); the platform then reports that.
const REPORT_SCRIPT = `const fs = require('node:fs');

function firstError(suites) {
  for (const suite of suites || []) {
    for (const spec of suite.specs || []) {
      for (const test of spec.tests || []) {
        for (const result of test.results || []) {
          if (result.error && result.error.message) return spec.title + ': ' + result.error.message;
        }
      }
    }
    const nested = firstError(suite.suites);
    if (nested) return nested;
  }
  return null;
}

async function main() {
  if (!fs.existsSync('results.json')) return;
  const report = JSON.parse(fs.readFileSync('results.json', 'utf8'));
  const stats = report.stats || {};
  const passed = (stats.expected || 0) + (stats.flaky || 0);
  const failed = stats.unexpected || 0;
  const skipped = stats.skipped || 0;
  const body = { total: passed + failed + skipped, passed, failed, skipped };
  const message = firstError(report.suites);
  if (message) body.errorMessage = message.replace(/\\u001b\\[[0-9;]*m/g, '').slice(0, 2000);
  const url = process.env.PLATFORM_URL + '/api/executions/' + process.env.EXECUTION_ID + '/result';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.RUN_TOKEN },
    body: JSON.stringify(body),
  });
  console.log('Reported result to the platform: HTTP ' + res.status);
}

main().catch((err) => console.log('Could not report the result: ' + err.message));
`;

/** Groovy string literal with single quotes; backslashes and quotes are escaped. */
function groovy(text: string): string {
  return `'''${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'''`;
}

export function pipelineScript(): string {
  return `pipeline {
  agent any
  options { timeout(time: 30, unit: 'MINUTES') }
  stages {
    stage('Prepare') {
      steps {
        deleteDir()
        writeFile file: 'package.json', text: ${groovy(PACKAGE_JSON)}
        writeFile file: 'playwright.config.ts', text: ${groovy(PLAYWRIGHT_CONFIG)}
        writeFile file: 'report-result.cjs', text: ${groovy(REPORT_SCRIPT)}
        bat 'if not exist tests mkdir tests'
        bat '@curl -sS -f -H "Authorization: Bearer %RUN_TOKEN%" -H "X-Build-Number: %BUILD_NUMBER%" -o tests\\\\script.spec.ts "%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script"'
      }
    }
    stage('Install') {
      steps {
        bat 'npm install --no-audit --no-fund'
        bat 'npx playwright install chromium'
      }
    }
    stage('Test') {
      steps {
        script {
          def code = bat(returnStatus: true, script: 'npx playwright test')
          if (code != 0) { currentBuild.result = 'UNSTABLE' }
        }
      }
    }
  }
  post {
    always {
      script { bat(returnStatus: true, script: 'node report-result.cjs') }
      archiveArtifacts artifacts: 'playwright-report/**', allowEmptyArchive: true
    }
  }
}
`;
}

function xml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function jobConfigXml(): string {
  return `<?xml version='1.1' encoding='UTF-8'?>
<flow-definition plugin="workflow-job">
  <description>Runs one Playwright script stored in the Playwright Platform. Managed by the platform: changes made here are overwritten.</description>
  <keepDependencies>false</keepDependencies>
  <properties>
    <hudson.model.ParametersDefinitionProperty>
      <parameterDefinitions>
        <hudson.model.StringParameterDefinition>
          <name>EXECUTION_ID</name>
          <defaultValue></defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.StringParameterDefinition>
          <name>PLATFORM_URL</name>
          <defaultValue></defaultValue>
          <trim>true</trim>
        </hudson.model.StringParameterDefinition>
        <hudson.model.PasswordParameterDefinition>
          <name>RUN_TOKEN</name>
        </hudson.model.PasswordParameterDefinition>
      </parameterDefinitions>
    </hudson.model.ParametersDefinitionProperty>
  </properties>
  <definition class="org.jenkinsci.plugins.workflow.cps.CpsFlowDefinition" plugin="workflow-cps">
    <script>${xml(pipelineScript())}</script>
    <sandbox>true</sandbox>
  </definition>
  <triggers/>
  <disabled>false</disabled>
</flow-definition>
`;
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npm test -w server -- test/jenkins-client.test.ts` then `npm run typecheck`
Expected: 11 passed; typecheck prints no errors.

- [ ] **Step 7: Commit**

```bash
git add PlaywrightPlatform/server/src/jenkins PlaywrightPlatform/server/test/jenkins-stub.ts PlaywrightPlatform/server/test/jenkins-client.test.ts
git commit -m "feat(platform): add the Jenkins client and the pipeline job definition"
```

---

### Task 3: Jenkins settings, test connection, and create job

**Files:**
- Create: `PlaywrightPlatform/server/src/repositories/jenkins-repository.ts`
- Create: `PlaywrightPlatform/server/src/services/jenkins-service.ts`
- Create: `PlaywrightPlatform/server/src/schemas/jenkins.ts`
- Create: `PlaywrightPlatform/server/src/routes/jenkins.ts`
- Modify: `PlaywrightPlatform/server/src/types.ts`, `src/repositories/index.ts`, `src/app.ts`
- Test: `PlaywrightPlatform/server/test/jenkins-settings.test.ts`

**Interfaces:**
- Consumes: `createSecretBox` (Task 1); `JenkinsClient`, `JenkinsError`, `jobConfigXml` (Task 2).
- Produces:
  - `interface JenkinsSettings { id: number; baseUrl: string; username: string; jobName: string; secretCiphertext: string | null }` in `types.ts`
  - `JenkinsRepository` with `find(): Promise<JenkinsSettings | null>`, `save(values): Promise<void>`, `ensureProjectJob(projectId: number, configurationId: number, jobName: string): Promise<number>`; available as `repos.jenkins`
  - `JenkinsService` with `view(isAdmin)`, `save(actor, input)`, `test(input)`, `createJob(actor)`, and `link(): Promise<JenkinsLink>` where `JenkinsLink = { client: JenkinsClient; configurationId: number; jobName: string; baseUrl: string }`
  - `toAppError(err: unknown): unknown` — turns a `JenkinsError` into the 502 `AppError`, returns anything else unchanged
  - Routes `GET/PUT /api/jenkins/settings`, `POST /api/jenkins/test`, `POST /api/jenkins/job`

- [ ] **Step 1: Write the failing test**

Create `PlaywrightPlatform/server/test/jenkins-settings.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { closeApp, createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';

describe('jenkins settings', () => {
  let ctx: TestContext;
  let stub: JenkinsStub;
  let asAdmin: Record<string, string>;
  let asUser: Record<string, string>;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
    stub = await startJenkinsStub();
  });
  afterAll(async () => {
    await stub.close();
    await closeApp(ctx);
  });
  beforeEach(async () => {
    await resetDb(ctx.db);
    stub.reset();
    const admin = await createUser(ctx.db, { role: 'ADMIN' });
    const user = await createUser(ctx.db, { role: 'USER' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    asUser = (await loginExt(ctx.app, user.email, user.password)).headers;
  });

  const call = (method: 'GET' | 'PUT' | 'POST', url: string, headers: Record<string, string>, payload?: object) =>
    ctx.app.inject({ method, url: `/api/jenkins/${url}`, headers, payload });
  const save = (payload: object, headers = asAdmin) => call('PUT', 'settings', headers, payload);
  const good = () => ({ baseUrl: `${stub.url}/`, username: stub.username, token: stub.token });

  it('reports not configured before anything is saved', async () => {
    const res = await call('GET', 'settings', asAdmin);
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      configured: false,
      baseUrl: '',
      username: '',
      jobName: 'playwright-platform-run',
      hasToken: false,
    });
  });

  it('saves settings, encrypts the token, and never returns it', async () => {
    const res = await save(good());
    expect(res.statusCode).toBe(200);
    expect(res.json().settings).toEqual({
      configured: true,
      baseUrl: stub.url,
      username: 'ci-user',
      jobName: 'playwright-platform-run',
      hasToken: true,
    });
    expect(res.body).not.toContain('ci-token');

    const row = await ctx.db('jenkins_configurations').first();
    expect(row.name).toBe('default');
    expect(row.secret_ciphertext).toMatch(/^v1:/);
    expect(row.secret_ciphertext).not.toContain('ci-token');

    const audit = await ctx.db('audit_logs').where({ action: 'jenkins.settings.update' }).first();
    expect(audit).toBeTruthy();
    expect(JSON.stringify(audit)).not.toContain('ci-token');
  });

  it('keeps the stored token when a later save omits it, and requires it on the first save', async () => {
    const first = await save({ baseUrl: stub.url, username: 'ci-user' });
    expect(first.statusCode).toBe(400);
    expect(first.json().error.message).toBe('Enter the Jenkins API token.');

    await save(good());
    const before = (await ctx.db('jenkins_configurations').first()).secret_ciphertext;
    const second = await save({ baseUrl: stub.url, username: 'ci-user', jobName: 'other-job' });
    expect(second.statusCode).toBe(200);
    expect(second.json().settings.jobName).toBe('other-job');
    expect((await ctx.db('jenkins_configurations').first()).secret_ciphertext).toBe(before);
    expect(await ctx.db('jenkins_configurations').count('* as n').first()).toEqual({ n: 1 });
  });

  it('validates each field', async () => {
    const longUrl = 'http://x/' + 'a'.repeat(300);
    const bad = [
      { ...good(), baseUrl: 'localhost:7070' },
      { ...good(), baseUrl: longUrl },
      { ...good(), username: '' },
      { ...good(), username: 'u'.repeat(101) },
      { ...good(), token: 't'.repeat(201) },
      { ...good(), jobName: 'has space' },
      { ...good(), jobName: 'a/b' },
    ];
    for (const payload of bad) expect((await save(payload)).statusCode).toBe(400);
  });

  it('lets only an ADMIN change settings, and hides the address from other roles', async () => {
    expect((await save(good(), asUser)).statusCode).toBe(403);
    expect((await call('POST', 'test', asUser, {})).statusCode).toBe(403);
    expect((await call('POST', 'job', asUser)).statusCode).toBe(403);
    expect((await call('GET', 'settings', {})).statusCode).toBe(401);

    await save(good());
    const seen = (await call('GET', 'settings', asUser)).json().settings;
    expect(seen).toEqual({ configured: true, baseUrl: '', username: '', jobName: 'playwright-platform-run', hasToken: true });
  });

  it('tests a connection with values that are not saved yet', async () => {
    const res = await call('POST', 'test', asAdmin, good());
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      ok: true,
      version: '2.555.2',
      pipelinePlugin: true,
      message: 'Connected to Jenkins 2.555.2.',
    });
    expect(await ctx.db('jenkins_configurations').first()).toBeUndefined();
  });

  it('tests the saved connection when the body is empty, and needs one to be saved', async () => {
    const none = await call('POST', 'test', asAdmin, {});
    expect(none.statusCode).toBe(409);
    expect(none.json().error.code).toBe('JENKINS_NOT_CONFIGURED');
    await save(good());
    expect((await call('POST', 'test', asAdmin, {})).json().ok).toBe(true);
  });

  it('explains a failed connection test without failing the request', async () => {
    const wrong = await call('POST', 'test', asAdmin, { ...good(), token: 'nope' });
    expect(wrong.statusCode).toBe(200);
    expect(wrong.json()).toMatchObject({ ok: false, version: null, message: 'Jenkins refused the username or API token.' });

    stub.failWith = 503;
    expect((await call('POST', 'test', asAdmin, good())).json()).toMatchObject({ ok: false, message: 'Jenkins answered with status 503.' });
    stub.failWith = null;

    stub.plugins = [];
    const noPlugin = (await call('POST', 'test', asAdmin, good())).json();
    expect(noPlugin).toMatchObject({ ok: true, pipelinePlugin: false });
    expect(noPlugin.message).toContain('Pipeline plugin is not installed');

    // A Jenkins user who may run builds but not view plugins is still connected.
    stub.plugins = ['workflow-aggregator'];
    stub.forbidPluginList = true;
    const hidden = (await call('POST', 'test', asAdmin, good())).json();
    expect(hidden).toMatchObject({ ok: true, version: '2.555.2', pipelinePlugin: false });
    expect(hidden.message).toContain('may not list plugins');
  });

  it('creates the job, then updates it, and records both', async () => {
    const none = await call('POST', 'job', asAdmin);
    expect(none.statusCode).toBe(409);

    await save(good());
    const created = await call('POST', 'job', asAdmin);
    expect(created.statusCode).toBe(200);
    expect(created.json()).toEqual({ created: true, jobUrl: `${stub.url}/job/playwright-platform-run/` });
    expect(stub.configs.get('playwright-platform-run')).toContain('<flow-definition');

    expect((await call('POST', 'job', asAdmin)).json().created).toBe(false);
    expect(await ctx.db('audit_logs').where({ action: 'jenkins.job.create' }).count('* as n').first()).toEqual({ n: 2 });
  });

  it('answers 502 when Jenkins fails during job creation', async () => {
    await save(good());
    stub.failWith = 503;
    const down = await call('POST', 'job', asAdmin);
    expect(down.statusCode).toBe(502);
    expect(down.json().error.code).toBe('JENKINS_UNREACHABLE');
    stub.failWith = 403;
    const refused = await call('POST', 'job', asAdmin);
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error.code).toBe('JENKINS_REJECTED');
    expect(refused.json().error.message).toBe('Jenkins refused the username or API token. Check Settings → Jenkins.');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/jenkins-settings.test.ts`
Expected: FAIL — all 10 tests, with 404 where 200 is expected (the routes do not exist).

- [ ] **Step 3: Add the type and the repository**

Append to `PlaywrightPlatform/server/src/types.ts`:

```ts
/** The one Jenkins connection of the installation. The token is held only as ciphertext. */
export interface JenkinsSettings {
  id: number;
  baseUrl: string;
  username: string;
  jobName: string;
  secretCiphertext: string | null;
}
```

Create `PlaywrightPlatform/server/src/repositories/jenkins-repository.ts`:

```ts
import type { Db } from '../db';
import type { JenkinsSettings } from '../types';

// There is one Jenkins server per installation; its row has this name.
const SETTINGS_NAME = 'default';

export interface JenkinsSettingsValues {
  baseUrl: string;
  username: string;
  jobName: string;
  secretCiphertext: string;
}

export class JenkinsRepository {
  constructor(private readonly db: Db) {}

  async find(): Promise<JenkinsSettings | null> {
    const row = await this.db('jenkins_configurations').where({ name: SETTINGS_NAME }).first();
    if (!row) return null;
    return {
      id: row.id,
      baseUrl: row.base_url,
      username: row.username,
      jobName: row.job_name,
      secretCiphertext: row.secret_ciphertext,
    };
  }

  async save(values: JenkinsSettingsValues): Promise<void> {
    const columns = {
      base_url: values.baseUrl,
      username: values.username,
      job_name: values.jobName,
      secret_ciphertext: values.secretCiphertext,
    };
    await this.db('jenkins_configurations')
      .insert({ name: SETTINGS_NAME, ...columns })
      .onConflict('name')
      .merge({ ...columns, updated_at: this.db.fn.now() });
  }

  /** Returns the id of the project's link to the job, creating the link the first time. */
  async ensureProjectJob(projectId: number, configurationId: number, jobName: string): Promise<number> {
    const link = { project_id: projectId, jenkins_configuration_id: configurationId, job_name: jobName, folder: '' };
    await this.db('project_ci_jobs')
      .insert(link)
      .onConflict(['project_id', 'jenkins_configuration_id', 'job_name', 'folder'])
      .ignore();
    const row = await this.db('project_ci_jobs').where(link).first('id');
    return row.id;
  }
}
```

In `PlaywrightPlatform/server/src/repositories/index.ts` add the import, the `Repos` field, and the constructor line:

```ts
import { JenkinsRepository } from './jenkins-repository';
```
```ts
  jenkins: JenkinsRepository;
```
```ts
    jenkins: new JenkinsRepository(db),
```

- [ ] **Step 4: Write the service**

Create `PlaywrightPlatform/server/src/services/jenkins-service.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import type { SecretBox } from '../crypto/secret-box';
import { AppError } from '../errors';
import { JenkinsClient, JenkinsError } from '../jenkins/jenkins-client';
import { jobConfigXml } from '../jenkins/pipeline';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { JenkinsRepository } from '../repositories/jenkins-repository';
import type { Actor } from '../types';
import type { AuditService } from './audit-service';

export const DEFAULT_JOB_NAME = 'playwright-platform-run';
const PIPELINE_PLUGIN = 'workflow-aggregator';

export interface JenkinsSettingsInput {
  baseUrl: string;
  username: string;
  jobName: string;
  token?: string;
}

export interface JenkinsTestInput {
  baseUrl?: string;
  username?: string;
  token?: string;
}

export interface JenkinsSettingsView {
  configured: boolean;
  baseUrl: string;
  username: string;
  jobName: string;
  hasToken: boolean;
}

export interface JenkinsTestResult {
  ok: boolean;
  version: string | null;
  pipelinePlugin: boolean;
  message: string;
}

/** Everything needed to call Jenkins for a run. */
export interface JenkinsLink {
  client: JenkinsClient;
  configurationId: number;
  jobName: string;
  baseUrl: string;
}

function notConfigured(): AppError {
  return new AppError(
    409,
    'JENKINS_NOT_CONFIGURED',
    'Jenkins is not set up yet. An administrator must save it under Settings → Jenkins.',
  );
}

/** Turns a Jenkins failure into the API error a person can act on. Anything else is returned unchanged. */
export function toAppError(err: unknown): unknown {
  if (!(err instanceof JenkinsError)) return err;
  if (err.kind === 'REJECTED') {
    return new AppError(502, 'JENKINS_REJECTED', 'Jenkins refused the username or API token. Check Settings → Jenkins.');
  }
  if (err.kind === 'NOT_FOUND') {
    return new AppError(502, 'JENKINS_REJECTED', 'Jenkins does not have the job. Press Create Job under Settings → Jenkins.');
  }
  return new AppError(502, 'JENKINS_UNREACHABLE', `${err.message} Check that Jenkins is running and the URL under Settings → Jenkins.`);
}

export class JenkinsService {
  constructor(
    private readonly repo: JenkinsRepository,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly box: SecretBox,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** The address and username are shown to an ADMIN only. */
  async view(isAdmin: boolean): Promise<JenkinsSettingsView> {
    const saved = await this.repo.find();
    if (!saved) return { configured: false, baseUrl: '', username: '', jobName: DEFAULT_JOB_NAME, hasToken: false };
    return {
      configured: true,
      baseUrl: isAdmin ? saved.baseUrl : '',
      username: isAdmin ? saved.username : '',
      jobName: saved.jobName,
      hasToken: Boolean(saved.secretCiphertext),
    };
  }

  async save(actor: Actor, input: JenkinsSettingsInput): Promise<JenkinsSettingsView> {
    await this.transact(async (r) => {
      const saved = await r.jenkins.find();
      const secretCiphertext = input.token ? this.box.encrypt(input.token) : saved?.secretCiphertext;
      if (!secretCiphertext) throw new AppError(400, 'VALIDATION_ERROR', 'Enter the Jenkins API token.');
      await r.jenkins.save({ baseUrl: input.baseUrl, username: input.username, jobName: input.jobName, secretCiphertext });
      await this.record(
        actor,
        'jenkins.settings.update',
        { baseUrl: input.baseUrl, username: input.username, jobName: input.jobName, tokenChanged: Boolean(input.token) },
        r.audit,
      );
    });
    this.log.info('[JENKINS] Settings saved');
    return this.view(true);
  }

  /** Tries the given values, falling back to the saved ones. A failure is a normal result, not an error. */
  async test(input: JenkinsTestInput): Promise<JenkinsTestResult> {
    const saved = await this.repo.find();
    const baseUrl = input.baseUrl ?? saved?.baseUrl;
    const username = input.username ?? saved?.username;
    if (!baseUrl || !username) throw notConfigured();
    const token = input.token ?? (saved?.secretCiphertext ? this.box.decrypt(saved.secretCiphertext) : '');
    if (!token) return { ok: false, version: null, pipelinePlugin: false, message: 'Enter the Jenkins API token.' };

    const client = new JenkinsClient({ baseUrl, username, token });
    let version: string;
    try {
      version = await client.version();
    } catch (err) {
      if (err instanceof JenkinsError) return { ok: false, version: null, pipelinePlugin: false, message: err.message };
      throw err;
    }

    // Listing plugins needs more Jenkins permission than running builds does, so a refusal
    // here is not a failed connection: the plugin simply could not be checked.
    let pipelinePlugin: boolean | null;
    try {
      pipelinePlugin = await client.hasPlugin(PIPELINE_PLUGIN);
    } catch (err) {
      if (!(err instanceof JenkinsError)) throw err;
      pipelinePlugin = null;
    }
    let message = `Connected to Jenkins ${version}.`;
    if (pipelinePlugin === false) {
      message = `Connected to Jenkins ${version}, but the Pipeline plugin is not installed. Install "Pipeline" in Jenkins before creating the job.`;
    } else if (pipelinePlugin === null) {
      message = `Connected to Jenkins ${version}. This Jenkins user may not list plugins, so check in Jenkins that "Pipeline" is installed.`;
    }
    return { ok: true, version, pipelinePlugin: pipelinePlugin === true, message };
  }

  async createJob(actor: Actor): Promise<{ created: boolean; jobUrl: string }> {
    const link = await this.link();
    let created: boolean;
    try {
      ({ created } = await link.client.createOrUpdateJob(link.jobName, jobConfigXml()));
    } catch (err) {
      throw toAppError(err);
    }
    await this.record(actor, 'jenkins.job.create', { jobName: link.jobName, created });
    this.log.info(`[JENKINS] ${created ? 'Created' : 'Updated'} job ${link.jobName}`);
    return { created, jobUrl: link.client.jobUrl(link.jobName) };
  }

  async link(): Promise<JenkinsLink> {
    const saved = await this.repo.find();
    if (!saved?.secretCiphertext) throw notConfigured();
    const client = new JenkinsClient({
      baseUrl: saved.baseUrl,
      username: saved.username,
      token: this.box.decrypt(saved.secretCiphertext),
    });
    return { client, configurationId: saved.id, jobName: saved.jobName, baseUrl: saved.baseUrl };
  }

  private record(actor: Actor, action: string, details: Record<string, unknown>, repo?: AuditRepository): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'jenkins',
        resourceId: null,
        result: 'SUCCESS',
        ip: actor.ip,
        details,
      },
      repo,
    );
  }
}
```

- [ ] **Step 5: Write the schemas and routes**

Create `PlaywrightPlatform/server/src/schemas/jenkins.ts`:

```ts
import { z } from 'zod';
import { DEFAULT_JOB_NAME } from '../services/jenkins-service';

const baseUrl = z
  .string()
  .trim()
  .max(300, 'The URL is too long (300 characters at most).')
  .regex(/^https?:\/\/[^\s]+$/i, 'Enter a URL that starts with http:// or https://')
  .transform((v) => v.replace(/\/+$/, ''));
const username = z.string().trim().min(1, 'Enter the Jenkins username.').max(100);
const token = z.string().min(1).max(200, 'The API token is too long (200 characters at most).');
const jobName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9_.-]+$/, 'Use letters, digits, dot, dash, and underscore only.');

export const saveJenkinsBody = z.object({
  baseUrl,
  username,
  jobName: jobName.default(DEFAULT_JOB_NAME),
  token: token.optional(),
});

export const testJenkinsBody = z.object({
  baseUrl: baseUrl.optional(),
  username: username.optional(),
  token: token.optional(),
});

export const jenkinsSettingsResponse = z.object({
  settings: z.object({
    configured: z.boolean(),
    baseUrl: z.string(),
    username: z.string(),
    jobName: z.string(),
    hasToken: z.boolean(),
  }),
});

export const jenkinsTestResponse = z.object({
  ok: z.boolean(),
  version: z.string().nullable(),
  pipelinePlugin: z.boolean(),
  message: z.string(),
});

export const jenkinsJobResponse = z.object({ created: z.boolean(), jobUrl: z.string() });
```

Create `PlaywrightPlatform/server/src/routes/jenkins.ts`:

```ts
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
```

- [ ] **Step 6: Wire it into the app**

In `PlaywrightPlatform/server/src/app.ts` add imports:

```ts
import { createSecretBox } from './crypto/secret-box';
import { jenkinsRoutes } from './routes/jenkins';
import { JenkinsService } from './services/jenkins-service';
```

After the `scriptService` line:

```ts
  const jenkinsService = new JenkinsService(repos.jenkins, audit, transact, createSecretBox(config.secretsKey), app.log);
```

After the `scriptRoutes` registration:

```ts
      await api.register(jenkinsRoutes, { jenkins: jenkinsService });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm test -w server -- test/jenkins-settings.test.ts`, then `npm run typecheck`, then `npm test`
Expected: 10 passed; typecheck clean; whole suite green.

- [ ] **Step 8: Check the layering and commit**

Run: `grep -rn "fetch(" PlaywrightPlatform/server/src --include=*.ts | grep -v -e jenkins-client.ts -e jenkins/pipeline.ts`
Expected: no output. (`pipeline.ts` is left out because the `fetch` in it is text: the report script that the Jenkins build runs.)

```bash
git add PlaywrightPlatform/server/src PlaywrightPlatform/server/test/jenkins-settings.test.ts
git commit -m "feat(platform): store Jenkins settings, test the connection, and create the job"
```

---

### Task 4: Start a run, read it, and list a script's runs

**Files:**
- Create: `PlaywrightPlatform/server/src/repositories/execution-repository.ts`
- Create: `PlaywrightPlatform/server/src/services/execution-service.ts`
- Create: `PlaywrightPlatform/server/src/schemas/executions.ts`
- Create: `PlaywrightPlatform/server/src/routes/executions.ts`
- Modify: `PlaywrightPlatform/server/src/types.ts`, `src/repositories/index.ts`, `src/app.ts`
- Modify: `PlaywrightPlatform/server/test/helpers.ts`
- Create: `PlaywrightPlatform/server/test/execution-helpers.ts`
- Test: `PlaywrightPlatform/server/test/execution-run.test.ts`

**Interfaces:**
- Consumes: `JenkinsService.link(): Promise<JenkinsLink>` and `toAppError` (Task 3); `JenkinsRepository.ensureProjectJob` (Task 3); `JenkinsError`, `JenkinsClient.trigger`, `jenkinsBuildUrl`, `jenkinsReportUrl`, `JenkinsStub.reset` (Task 2); `Config.publicUrl` (Task 1); the existing `ScriptRepository.findLive` and `.lock`, and `newToken` and `hashToken` in `src/security/tokens.ts`.
- Produces:
  - `type ExecutionStatus`, `type ExecutionStage`, `interface Execution` in `types.ts`
  - `ExecutionRepository` with `insert(input: NewExecution): Promise<number>`, `find(id): Promise<Execution | null>`, `findActive(scriptId): Promise<Execution | null>`, `listForScript(scriptId, limit): Promise<Execution[]>`, `updateActive(id, patch: ExecutionPatch): Promise<boolean>`; available as `repos.executions`
  - `ExecutionService` with `run(actor, scriptId): Promise<Execution>`, `get(id): Promise<Execution>`, `list(scriptId, limit): Promise<Execution[]>`, and private `find(id)`, `nowDate()`, `record(...)`. Constructor: `(executions, scripts, jenkins, audit, transact, options: ExecutionOptions, log)` with `ExecutionOptions = { publicUrl: string; now: () => number }`
  - `AppDeps.now?: () => number`
  - `toExecutionDto(e: Execution)`, `executionResponse`, `executionListResponse`, `listExecutionsQuery`
  - Routes `POST /api/scripts/:id/run`, `GET /api/executions/:id`, `GET /api/scripts/:id/executions`
  - Test helpers in `execution-helpers.ts`: `JOB`, `interface RunWorld`, `startWorld(stub): Promise<RunWorld>`, `run(world, headers?, scriptId?)`, `startRun(world, stub): Promise<{ id: number; queueId: number; token: string }>`; `makeApp(overrides, extra)` accepts extra `AppDeps`

- [ ] **Step 1: Let tests pass extra dependencies to the app, and add the shared set-up**

In `PlaywrightPlatform/server/test/helpers.ts` change the import of `buildApp` and replace `makeApp`:

```ts
import { buildApp, type AppDeps } from '../src/app';
```

```ts
export async function makeApp(
  overrides: Record<string, string> = {},
  extra: Partial<Omit<AppDeps, 'config' | 'db'>> = {},
): Promise<TestContext> {
  const config = testConfig(overrides);
  const db = createDb(config.databaseUrl);
  const app = await buildApp({ config, db, ...extra });
  return { app, db, config };
}
```

Create `PlaywrightPlatform/server/test/execution-helpers.ts`:

```ts
import { createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';
import type { JenkinsStub } from './jenkins-stub';
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
```

- [ ] **Step 2: Write the failing test**

Create `PlaywrightPlatform/server/test/execution-run.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hashToken } from '../src/security/tokens';
import { JOB, run, startRun, startWorld, type RunWorld } from './execution-helpers';
import { closeApp } from './helpers';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';
import { newScript, SAMPLE } from './script-helpers';

describe('executions: start and read a run', () => {
  let stub: JenkinsStub;
  let world: RunWorld;

  beforeAll(async () => {
    stub = await startJenkinsStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    world = await startWorld(stub);
  });
  afterEach(() => closeApp(world.ctx));

  const rows = () => world.ctx.db('test_executions').orderBy('id');

  it('starts a run: records it, triggers Jenkins with the three parameters, and answers QUEUED', async () => {
    const res = await run(world);
    expect(res.statusCode).toBe(201);
    expect(res.json().execution).toMatchObject({
      id: 1,
      projectId: world.projectId,
      scriptId: world.scriptId,
      scriptName: 'Login Test',
      scriptVersion: 1,
      status: 'QUEUED',
      stage: 'QUEUED',
      buildNumber: null,
      buildUrl: null,
      reportUrl: null,
      total: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      errorMessage: null,
      triggeredBy: 'Uma User',
      startedAt: null,
      completedAt: null,
      durationMs: null,
    });

    const token = stub.lastParams.RUN_TOKEN;
    expect(stub.lastParams.EXECUTION_ID).toBe('1');
    expect(stub.lastParams.PLATFORM_URL).toBe(world.ctx.config.publicUrl);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const [row] = await rows();
    expect(row.trigger_type).toBe('MANUAL');
    expect(row.callback_token_hash).toBe(hashToken(token));
    expect(stub.queue.has(row.jenkins_queue_id)).toBe(true);
    const job = await world.ctx.db('project_ci_jobs').first();
    expect(job).toMatchObject({ id: row.jenkins_job_id, project_id: world.projectId, job_name: JOB });

    // The token goes to the build and nowhere else.
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain(row.callback_token_hash);
    const audit = await world.ctx.db('audit_logs').where({ action: 'execution.run' }).first();
    expect(audit.resource_id).toBe('1');
    expect(JSON.stringify(audit)).not.toContain(token);
  });

  it('records the version that was current when Run was pressed', async () => {
    const saved = await world.ctx.app.inject({
      method: 'PUT',
      url: `/api/scripts/${world.scriptId}`,
      headers: world.asUser,
      payload: { content: `${SAMPLE}\n// second version\n`, baseVersion: 1 },
    });
    expect(saved.statusCode).toBe(200);
    expect((await run(world)).json().execution.scriptVersion).toBe(2);
  });

  it('refuses a VIEWER, a missing session, and an unknown script', async () => {
    expect((await run(world, world.asViewer)).statusCode).toBe(403);
    expect((await run(world, {})).statusCode).toBe(401);
    expect((await run(world, world.asUser, 999)).statusCode).toBe(404);
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a run in an archived project', async () => {
    const archived = await world.ctx.app.inject({
      method: 'PUT',
      url: `/api/projects/${world.projectId}`,
      headers: world.asAdmin,
      payload: { status: 'ARCHIVED' },
    });
    expect(archived.statusCode).toBe(200);
    const res = await run(world);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROJECT_NOT_ACTIVE');
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a run before Jenkins is set up', async () => {
    await world.ctx.db('jenkins_configurations').del();
    const res = await run(world);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('JENKINS_NOT_CONFIGURED');
    expect(await rows()).toHaveLength(0);
  });

  it('refuses a second run of a script while one is unfinished', async () => {
    const first = await startRun(world, stub);
    const second = await run(world, world.asAdmin);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toMatchObject({ code: 'RUN_IN_PROGRESS', details: { executionId: first.id } });

    // Another script in the same project is free to run, and reuses the project's link to the job.
    const other = await newScript(world.ctx, world.asAdmin, world.projectId, { name: 'Other Test' });
    expect((await run(world, world.asUser, other.id)).statusCode).toBe(201);
    expect(await world.ctx.db('project_ci_jobs').count('* as n').first()).toEqual({ n: 1 });
  });

  it('two simultaneous runs: one starts, the other is told a run is in progress', async () => {
    const results = await Promise.all([run(world, world.asUser), run(world, world.asAdmin)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect(await rows()).toHaveLength(1);
    expect(stub.requests.filter((req) => req.path.endsWith('/buildWithParameters'))).toHaveLength(1);
  });

  it('Jenkins down: the run is kept as ERROR and the answer is 502', async () => {
    stub.failWith = 503;
    const res = await run(world);
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe('JENKINS_UNREACHABLE');

    const [row] = await rows();
    expect(row).toMatchObject({ status: 'ERROR', stage: 'COMPLETED', callback_token_hash: null });
    expect(row.error_message).toContain('Jenkins answered with status 503.');
    expect(row.completed_at).toBeInstanceOf(Date);

    // A start that failed does not block the next try.
    stub.failWith = null;
    expect((await run(world)).statusCode).toBe(201);
  });

  it('Jenkins without the job, or refusing the token: ERROR run and 502 with what to do', async () => {
    stub.jobs.clear();
    const missing = await run(world);
    expect(missing.statusCode).toBe(502);
    expect(missing.json().error).toMatchObject({
      code: 'JENKINS_REJECTED',
      message: 'Jenkins does not have the job. Press Create Job under Settings → Jenkins.',
    });

    stub.jobs.add(JOB);
    stub.failWith = 403;
    const refused = await run(world);
    expect(refused.statusCode).toBe(502);
    expect(refused.json().error).toMatchObject({
      code: 'JENKINS_REJECTED',
      message: 'Jenkins refused the username or API token. Check Settings → Jenkins.',
    });
    expect((await rows()).map((row: { status: string }) => row.status)).toEqual(['ERROR', 'ERROR']);
  });

  it('reads a run: any signed-in role, 404 for an unknown id, 401 without a session', async () => {
    const { id } = await startRun(world, stub);
    const get = (headers: Record<string, string>, target = id) =>
      world.ctx.app.inject({ method: 'GET', url: `/api/executions/${target}`, headers });

    const seen = await get(world.asViewer);
    expect(seen.statusCode).toBe(200);
    expect(seen.json().execution).toMatchObject({ id, status: 'QUEUED', triggeredBy: 'Uma User' });
    expect((await get(world.asUser, 999)).statusCode).toBe(404);
    expect((await get({})).statusCode).toBe(401);
  });

  it("lists a script's runs newest first, limited, without asking Jenkins", async () => {
    const finishAll = () => world.ctx.db('test_executions').update({ status: 'PASSED', stage: 'COMPLETED' });
    await startRun(world, stub);
    await finishAll();
    await startRun(world, stub);
    await finishAll();
    await startRun(world, stub);
    const asked = stub.requests.length;

    const list = (query = '', headers: Record<string, string> = world.asViewer, scriptId = world.scriptId) =>
      world.ctx.app.inject({ method: 'GET', url: `/api/scripts/${scriptId}/executions${query}`, headers });

    const all = await list();
    expect(all.statusCode).toBe(200);
    expect(all.json().items.map((item: { id: number }) => item.id)).toEqual([3, 2, 1]);
    expect(all.json().items[0]).toMatchObject({ status: 'QUEUED', scriptName: 'Login Test' });
    expect((await list('?limit=2')).json().items).toHaveLength(2);
    expect((await list('?limit=0')).statusCode).toBe(400);
    expect((await list('?limit=51')).statusCode).toBe(400);
    expect((await list('', world.asViewer, 999)).statusCode).toBe(404);
    expect((await list('', {})).statusCode).toBe(401);
    expect(stub.requests.length).toBe(asked);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/execution-run.test.ts`
Expected: FAIL — all 11 tests, with 404 where another status is expected (the routes do not exist).

- [ ] **Step 4: Add the types and the repository**

Append to `PlaywrightPlatform/server/src/types.ts`:

```ts
export type ExecutionStatus = 'QUEUED' | 'RUNNING' | 'PASSED' | 'FAILED' | 'ABORTED' | 'ERROR';
/** The table allows more stages; this release writes these three. */
export type ExecutionStage = 'QUEUED' | 'RUNNING' | 'COMPLETED';

/** One run of one script version on Jenkins. */
export interface Execution {
  id: number;
  projectId: number;
  scriptId: number;
  scriptName: string;
  scriptVersion: number;
  status: ExecutionStatus;
  stage: ExecutionStage;
  /** The Jenkins queue item; null until Jenkins accepted the run. */
  queueId: number | null;
  /** Null until Jenkins gave the build a number. */
  buildNumber: number | null;
  /** The Jenkins job the run was started on. */
  jobName: string;
  /** The saved address of the Jenkins server, for building links. */
  jenkinsBaseUrl: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errorMessage: string | null;
  /** Display name of the person who started the run. */
  triggeredBy: string | null;
  /** SHA-256 of the run token; null once the run is final. Never sent to a client. */
  callbackTokenHash: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  durationMs: number | null;
}
```

Create `PlaywrightPlatform/server/src/repositories/execution-repository.ts`:

```ts
import type { Knex } from 'knex';
import type { Db } from '../db';
import type { Execution, ExecutionStage, ExecutionStatus } from '../types';

interface ExecutionRow {
  id: number;
  project_id: number;
  script_id: number;
  script_name: string;
  script_version: number;
  status: ExecutionStatus;
  stage: ExecutionStage;
  jenkins_queue_id: number | null;
  jenkins_build_number: number | null;
  job_name: string;
  jenkins_base_url: string;
  total_tests: number;
  passed_tests: number;
  failed_tests: number;
  skipped_tests: number;
  error_message: string | null;
  triggered_by_name: string | null;
  callback_token_hash: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  duration: number | null;
}

const COLUMNS = [
  'e.id',
  'e.project_id',
  'e.script_id',
  'e.script_version',
  'e.status',
  'e.stage',
  'e.jenkins_queue_id',
  'e.jenkins_build_number',
  'e.total_tests',
  'e.passed_tests',
  'e.failed_tests',
  'e.skipped_tests',
  'e.error_message',
  'e.callback_token_hash',
  'e.created_at',
  'e.started_at',
  'e.completed_at',
  'e.duration',
  's.name as script_name',
  'j.job_name',
  'c.base_url as jenkins_base_url',
  'u.display_name as triggered_by_name',
];

function toExecution(row: ExecutionRow): Execution {
  return {
    id: row.id,
    projectId: row.project_id,
    scriptId: row.script_id,
    scriptName: row.script_name,
    scriptVersion: row.script_version,
    status: row.status,
    stage: row.stage,
    queueId: row.jenkins_queue_id,
    buildNumber: row.jenkins_build_number,
    jobName: row.job_name,
    jenkinsBaseUrl: row.jenkins_base_url,
    total: row.total_tests,
    passed: row.passed_tests,
    failed: row.failed_tests,
    skipped: row.skipped_tests,
    errorMessage: row.error_message,
    triggeredBy: row.triggered_by_name,
    callbackTokenHash: row.callback_token_hash,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    durationMs: row.duration,
  };
}

export interface NewExecution {
  projectId: number;
  scriptId: number;
  scriptVersion: number;
  /** The project's row in `project_ci_jobs`. */
  jenkinsJobId: number;
  triggeredBy: number;
  callbackTokenHash: string;
  /** From the server clock, so the queue timeout never depends on the database clock. */
  createdAt: Date;
}

/** What can change on a run after it is created. Only the keys that are present are written. */
export interface ExecutionPatch {
  status?: ExecutionStatus;
  stage?: ExecutionStage;
  queueId?: number;
  buildNumber?: number;
  reportUrl?: string;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  errorMessage?: string | null;
  callbackTokenHash?: null;
  startedAt?: Date;
  completedAt?: Date;
  durationMs?: number;
}

const PATCH_COLUMNS: Record<keyof ExecutionPatch, string> = {
  status: 'status',
  stage: 'stage',
  queueId: 'jenkins_queue_id',
  buildNumber: 'jenkins_build_number',
  reportUrl: 'report_url',
  total: 'total_tests',
  passed: 'passed_tests',
  failed: 'failed_tests',
  skipped: 'skipped_tests',
  errorMessage: 'error_message',
  callbackTokenHash: 'callback_token_hash',
  startedAt: 'started_at',
  completedAt: 'completed_at',
  durationMs: 'duration',
};

const UNFINISHED: ExecutionStatus[] = ['QUEUED', 'RUNNING'];

export class ExecutionRepository {
  constructor(private readonly db: Db) {}

  /**
   * Runs joined to their script, the Jenkins job they ran on, and the person who started
   * them. The script is joined whatever its status, so a run stays readable after its
   * script is deleted.
   */
  private executions(): Knex.QueryBuilder {
    return this.db('test_executions as e')
      .join('test_scripts as s', 's.id', 'e.script_id')
      .join('project_ci_jobs as j', 'j.id', 'e.jenkins_job_id')
      .join('jenkins_configurations as c', 'c.id', 'j.jenkins_configuration_id')
      .leftJoin('users as u', 'u.id', 'e.triggered_by');
  }

  /** Inserts a QUEUED run and returns its id. */
  async insert(input: NewExecution): Promise<number> {
    const [row] = await this.db('test_executions')
      .insert({
        project_id: input.projectId,
        script_id: input.scriptId,
        script_version: input.scriptVersion,
        jenkins_job_id: input.jenkinsJobId,
        trigger_type: 'MANUAL',
        triggered_by: input.triggeredBy,
        callback_token_hash: input.callbackTokenHash,
        created_at: input.createdAt,
      })
      .returning('id');
    return row.id;
  }

  async find(id: number): Promise<Execution | null> {
    const row: ExecutionRow | undefined = await this.executions().where('e.id', id).select(...COLUMNS).first();
    return row ? toExecution(row) : null;
  }

  /** The script's unfinished run, if it has one. */
  async findActive(scriptId: number): Promise<Execution | null> {
    const row: ExecutionRow | undefined = await this.executions()
      .where('e.script_id', scriptId)
      .whereIn('e.status', UNFINISHED)
      .select(...COLUMNS)
      .orderBy('e.id', 'desc')
      .first();
    return row ? toExecution(row) : null;
  }

  /** Newest first. */
  async listForScript(scriptId: number, limit: number): Promise<Execution[]> {
    const rows: ExecutionRow[] = await this.executions()
      .where('e.script_id', scriptId)
      .select(...COLUMNS)
      .orderBy('e.id', 'desc')
      .limit(limit);
    return rows.map(toExecution);
  }

  /**
   * Changes an unfinished run and reports whether it did. A run that already has a final
   * status is left alone, so late or repeated news can never reopen it.
   */
  async updateActive(id: number, patch: ExecutionPatch): Promise<boolean> {
    const columns: Record<string, unknown> = {};
    for (const key of Object.keys(patch) as Array<keyof ExecutionPatch>) {
      if (patch[key] !== undefined) columns[PATCH_COLUMNS[key]] = patch[key];
    }
    if (Object.keys(columns).length === 0) return false;
    const count = await this.db('test_executions').where({ id }).whereIn('status', UNFINISHED).update(columns);
    return count > 0;
  }
}
```

In `PlaywrightPlatform/server/src/repositories/index.ts` add the import, the `Repos` field, and the constructor line:

```ts
import { ExecutionRepository } from './execution-repository';
```
```ts
  executions: ExecutionRepository;
```
```ts
    executions: new ExecutionRepository(db),
```

- [ ] **Step 5: Write the service**

Create `PlaywrightPlatform/server/src/services/execution-service.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import { JenkinsError } from '../jenkins/jenkins-client';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ExecutionRepository } from '../repositories/execution-repository';
import type { ScriptRepository } from '../repositories/script-repository';
import { hashToken, newToken } from '../security/tokens';
import type { Actor, Execution } from '../types';
import type { AuditService } from './audit-service';
import { toAppError, type JenkinsService } from './jenkins-service';

export interface ExecutionOptions {
  /** The address a Jenkins build uses to call this server, without a trailing slash. */
  publicUrl: string;
  /** Milliseconds since the epoch. Passed in so tests can move time. */
  now: () => number;
}

function projectNotActive(): AppError {
  return new AppError(409, 'PROJECT_NOT_ACTIVE', 'This project is archived. Restore it to run its scripts.');
}

function runInProgress(executionId: number): AppError {
  return new AppError(
    409,
    'RUN_IN_PROGRESS',
    'This script is already running. Wait for that run to finish, or stop it.',
    { executionId },
  );
}

export class ExecutionService {
  constructor(
    private readonly executions: ExecutionRepository,
    private readonly scripts: ScriptRepository,
    private readonly jenkins: JenkinsService,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly options: ExecutionOptions,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * Records the run, then asks Jenkins to start it. If Jenkins refuses, the run stays in
   * history as ERROR and the caller gets the reason.
   */
  async run(actor: Actor, scriptId: number): Promise<Execution> {
    const script = await this.scripts.findLive(scriptId);
    if (!script) throw notFound('Script');
    if (script.projectStatus !== 'ACTIVE') throw projectNotActive();
    const link = await this.jenkins.link();

    // The build proves who it is with this token. Only its hash is stored.
    const token = newToken();
    const created = await this.transact(async (r) => {
      // The lock makes two people who press Run together take turns: the second sees the first one's run.
      if (!(await r.scripts.lock(scriptId))) throw notFound('Script');
      const current = await r.scripts.findLive(scriptId);
      if (!current) throw notFound('Script'); // its project is deleted
      if (current.projectStatus !== 'ACTIVE') throw projectNotActive();
      const unfinished = await r.executions.findActive(scriptId);
      if (unfinished) throw runInProgress(unfinished.id);

      const jobId = await r.jenkins.ensureProjectJob(current.projectId, link.configurationId, link.jobName);
      const id = await r.executions.insert({
        projectId: current.projectId,
        scriptId,
        scriptVersion: current.version,
        jenkinsJobId: jobId,
        triggeredBy: actor.userId,
        callbackTokenHash: hashToken(token),
        createdAt: this.nowDate(),
      });
      await this.record(
        actor,
        'execution.run',
        id,
        { projectId: current.projectId, scriptId, scriptVersion: current.version },
        r.audit,
      );
      return { id, version: current.version };
    });

    try {
      const queueId = await link.client.trigger(link.jobName, {
        EXECUTION_ID: String(created.id),
        PLATFORM_URL: this.options.publicUrl,
        RUN_TOKEN: token,
      });
      await this.executions.updateActive(created.id, { queueId });
    } catch (err) {
      if (!(err instanceof JenkinsError)) throw err;
      const failure = toAppError(err) as AppError;
      await this.executions.updateActive(created.id, {
        status: 'ERROR',
        stage: 'COMPLETED',
        errorMessage: failure.message,
        callbackTokenHash: null,
        completedAt: this.nowDate(),
      });
      this.log.warn(`[EXECUTION] Run ${created.id} could not start: ${err.message}`);
      throw failure;
    }
    this.log.info(`[EXECUTION] Started run ${created.id} of script ${scriptId} v${created.version}`);
    return this.find(created.id);
  }

  async get(id: number): Promise<Execution> {
    return this.find(id);
  }

  /** A script's runs, newest first, as stored. Jenkins is not asked. */
  async list(scriptId: number, limit: number): Promise<Execution[]> {
    if (!(await this.scripts.findLive(scriptId))) throw notFound('Script');
    return this.executions.listForScript(scriptId, limit);
  }

  private async find(id: number): Promise<Execution> {
    const execution = await this.executions.find(id);
    if (!execution) throw notFound('Execution');
    return execution;
  }

  private nowDate(): Date {
    return new Date(this.options.now());
  }

  /** Writes the audit row. Never pass the run token in `details`. */
  private record(
    actor: Actor,
    action: string,
    id: number,
    details: Record<string, unknown>,
    repo?: AuditRepository,
  ): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'execution',
        resourceId: String(id),
        result: 'SUCCESS',
        ip: actor.ip,
        details,
      },
      repo,
    );
  }
}
```

- [ ] **Step 6: Write the schemas and routes**

Create `PlaywrightPlatform/server/src/schemas/executions.ts`:

```ts
import { z } from 'zod';
import { jenkinsBuildUrl, jenkinsReportUrl } from '../jenkins/urls';
import type { Execution } from '../types';

export const listExecutionsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const executionDto = z.object({
  id: z.number(),
  projectId: z.number(),
  scriptId: z.number(),
  scriptName: z.string(),
  scriptVersion: z.number(),
  status: z.enum(['QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ABORTED', 'ERROR']),
  stage: z.enum(['QUEUED', 'RUNNING', 'COMPLETED']),
  buildNumber: z.number().nullable(),
  buildUrl: z.string().nullable(),
  reportUrl: z.string().nullable(),
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  skipped: z.number(),
  errorMessage: z.string().nullable(),
  triggeredBy: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
});

export const executionResponse = z.object({ execution: executionDto });
export const executionListResponse = z.object({ items: z.array(executionDto) });

/** The run token's hash is deliberately not part of this shape. */
export function toExecutionDto(e: Execution): z.infer<typeof executionDto> {
  const build = e.buildNumber;
  return {
    id: e.id,
    projectId: e.projectId,
    scriptId: e.scriptId,
    scriptName: e.scriptName,
    scriptVersion: e.scriptVersion,
    status: e.status,
    stage: e.stage,
    buildNumber: build,
    // Built from the saved Jenkins address each time, so a link always points at the configured server.
    buildUrl: build === null ? null : jenkinsBuildUrl(e.jenkinsBaseUrl, e.jobName, build),
    reportUrl: build === null ? null : jenkinsReportUrl(e.jenkinsBaseUrl, e.jobName, build),
    total: e.total,
    passed: e.passed,
    failed: e.failed,
    skipped: e.skipped,
    errorMessage: e.errorMessage,
    triggeredBy: e.triggeredBy,
    createdAt: e.createdAt.toISOString(),
    startedAt: e.startedAt ? e.startedAt.toISOString() : null,
    completedAt: e.completedAt ? e.completedAt.toISOString() : null,
    durationMs: e.durationMs,
  };
}
```

Create `PlaywrightPlatform/server/src/routes/executions.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { parse, shape } from '../http';
import { actorOf, signedIn, writers } from '../plugins/auth';
import { idParams } from '../schemas/common';
import {
  executionListResponse,
  executionResponse,
  listExecutionsQuery,
  toExecutionDto,
} from '../schemas/executions';
import type { ExecutionService } from '../services/execution-service';

export interface ExecutionRouteDeps {
  executions: ExecutionService;
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
}
```

- [ ] **Step 7: Wire it into the app**

In `PlaywrightPlatform/server/src/app.ts` add imports:

```ts
import { executionRoutes } from './routes/executions';
import { ExecutionService } from './services/execution-service';
```

Add to `AppDeps`:

```ts
  /** Clock for the time-based rules of runs. Tests pass their own. */
  now?: () => number;
```

Change the signature of `buildApp`:

```ts
export async function buildApp({ config, db, webRoot, now = Date.now }: AppDeps): Promise<FastifyInstance> {
```

After the `jenkinsService` line:

```ts
  const executionService = new ExecutionService(
    repos.executions,
    repos.scripts,
    jenkinsService,
    audit,
    transact,
    { publicUrl: config.publicUrl, now },
    app.log,
  );
```

After the `jenkinsRoutes` registration:

```ts
      await api.register(executionRoutes, { executions: executionService });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm test -w server -- test/execution-run.test.ts`, then `npm run typecheck`, then `npm test`
Expected: 11 passed; typecheck clean; whole suite green.

- [ ] **Step 9: Commit**

```bash
git add PlaywrightPlatform/server/src PlaywrightPlatform/server/test/helpers.ts PlaywrightPlatform/server/test/execution-helpers.ts PlaywrightPlatform/server/test/execution-run.test.ts
git commit -m "feat(platform): start a script run on Jenkins and read its history"
```

---

### Task 5: Keep a run in step with Jenkins

**Files:**
- Modify: `PlaywrightPlatform/server/src/services/execution-service.ts`
- Modify: `PlaywrightPlatform/server/src/repositories/execution-repository.ts`
- Modify: `PlaywrightPlatform/server/src/repositories/script-repository.ts`
- Modify: `PlaywrightPlatform/server/test/execution-helpers.ts`
- Test: `PlaywrightPlatform/server/test/execution-sync.test.ts`

**Interfaces:**
- Consumes: `ExecutionService`, `ExecutionRepository.updateActive` and `.findActive`, `startWorld`, `startRun`, `run`, `JOB` (Task 4); `JenkinsClient.queueItem`, `.build`, `.cancelQueue`, `BuildState`, `jenkinsReportUrl`, `JenkinsStub.holdNext`, `StubBuild` (Task 2); `JenkinsLink` (Task 3).
- Produces:
  - `ExecutionService.get(id)` now asks Jenkins about an unfinished run, at most once every 2 seconds
  - `ExecutionService.run` first brings the script's unfinished run up to date
  - Private `sync(execution: Execution, link: JenkinsLink): Promise<void>` and `finish(execution, decide: (total: number) => Outcome, times: { startedAt?: Date; completedAt: Date; durationMs?: number }): Promise<void>`, and the constant `FINAL` — Task 6 uses all three inside the same file
  - `ExecutionRepository.lockActive(id): Promise<{ total: number } | null>`
  - `ScriptRepository.markRunResult(id: number, version: number, state: 'PASSED' | 'FAILED'): Promise<void>`
  - Test helpers `poll(world, id, headers?)`, `setBuild(stub, queueId, number, build?)`, `STARTED`

- [ ] **Step 1: Add the polling helpers**

In `PlaywrightPlatform/server/test/execution-helpers.ts` change the stub import to also bring in `StubBuild`:

```ts
import type { JenkinsStub, StubBuild } from './jenkins-stub';
```

Append:

```ts
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
```

- [ ] **Step 2: Write the failing test**

Create `PlaywrightPlatform/server/test/execution-sync.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB, poll, run, setBuild, STARTED, startRun, startWorld, type RunWorld } from './execution-helpers';
import { closeApp } from './helpers';
import { startJenkinsStub, type JenkinsStub, type StubBuild } from './jenkins-stub';
import { SAMPLE } from './script-helpers';

/** A build that ended after 65 seconds. Add the result. */
const ENDED = { building: false, duration: 65_000 };

describe('executions: sync with Jenkins', () => {
  let stub: JenkinsStub;
  let world: RunWorld;
  let nextBuild: number;

  beforeAll(async () => {
    stub = await startJenkinsStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    world = await startWorld(stub);
    nextBuild = 41;
  });
  afterEach(() => closeApp(world.ctx));

  const row = (id: number) => world.ctx.db('test_executions').where({ id }).first();
  const scriptState = async (): Promise<string> =>
    (await world.ctx.db('test_scripts').where({ id: world.scriptId }).first()).lifecycle_state;
  const build = (number: number): StubBuild => {
    const found = stub.builds.get(`${JOB}/${number}`);
    if (!found) throw new Error(`the stub has no build ${number}`);
    return found;
  };

  /** Starts a run, lets Jenkins end its build with `result`, and returns the run as read back. */
  const endWith = async (result: StubBuild['result'], prepare?: (id: number) => Promise<unknown>) => {
    const started = await startRun(world, stub);
    if (prepare) await prepare(started.id);
    setBuild(stub, started.queueId, nextBuild++, { ...ENDED, result });
    const res = await poll(world, started.id);
    expect(res.statusCode).toBe(200);
    return res.json().execution;
  };

  it('stays QUEUED while Jenkins has not started the build', async () => {
    const { id } = await startRun(world, stub);
    expect((await poll(world, id)).json().execution).toMatchObject({
      status: 'QUEUED',
      stage: 'QUEUED',
      buildNumber: null,
      buildUrl: null,
    });
  });

  it('a cancelled queue item ends the run as ABORTED', async () => {
    const { id, queueId } = await startRun(world, stub);
    stub.queue.get(queueId)!.cancelled = true;
    const execution = (await poll(world, id)).json().execution;
    expect(execution).toMatchObject({ status: 'ABORTED', stage: 'COMPLETED', buildNumber: null });
    expect(execution.completedAt).not.toBeNull();
    expect((await row(id)).callback_token_hash).toBeNull();
    expect(await scriptState()).toBe('SAVED');
  });

  it('a running build is RUNNING, with its number, links, and start time', async () => {
    const { id, queueId } = await startRun(world, stub);
    setBuild(stub, queueId, 41);
    const execution = (await poll(world, id)).json().execution;
    expect(execution).toMatchObject({
      status: 'RUNNING',
      stage: 'RUNNING',
      buildNumber: 41,
      buildUrl: `${stub.url}/job/${JOB}/41/`,
      reportUrl: `${stub.url}/job/${JOB}/41/artifact/playwright-report/index.html`,
      startedAt: new Date(STARTED).toISOString(),
      completedAt: null,
      durationMs: null,
    });
    expect((await row(id)).report_url).toBe(execution.reportUrl);
  });

  it('SUCCESS is PASSED, with duration and completion time, and marks the script', async () => {
    const execution = await endWith('SUCCESS');
    expect(execution).toMatchObject({
      status: 'PASSED',
      stage: 'COMPLETED',
      buildNumber: 41,
      errorMessage: null,
      startedAt: new Date(STARTED).toISOString(),
      completedAt: new Date(STARTED + 65_000).toISOString(),
      durationMs: 65_000,
    });
    expect((await row(execution.id)).callback_token_hash).toBeNull();
    expect(await scriptState()).toBe('PASSED');

    // The web app's project overview counts scripts by that state.
    const project = await world.ctx.app.inject({
      method: 'GET',
      url: `/api/projects/${world.projectId}`,
      headers: world.asViewer,
    });
    expect(project.json().overview).toMatchObject({ passedScripts: 1, notExecuted: 0 });
  });

  it('UNSTABLE is FAILED and marks the script', async () => {
    expect((await endWith('UNSTABLE')).status).toBe('FAILED');
    expect(await scriptState()).toBe('FAILED');
  });

  it('FAILURE is FAILED when the build reported tests, and ERROR when it did not', async () => {
    const reported = (id: number) =>
      world.ctx.db('test_executions').where({ id }).update({ total_tests: 3, passed_tests: 2, failed_tests: 1 });
    expect(await endWith('FAILURE', reported)).toMatchObject({
      status: 'FAILED',
      total: 3,
      passed: 2,
      failed: 1,
      errorMessage: null,
    });
    expect(await scriptState()).toBe('FAILED');

    expect(await endWith('FAILURE')).toMatchObject({
      status: 'ERROR',
      stage: 'COMPLETED',
      errorMessage: 'The build failed before the tests ran. Open the Jenkins build for the log.',
    });
    // An ERROR says nothing about the script, so the state stays as the last real result left it.
    expect(await scriptState()).toBe('FAILED');
  });

  it('an aborted build is ABORTED, a build that never ran is ERROR, and neither marks the script', async () => {
    expect((await endWith('ABORTED')).status).toBe('ABORTED');
    expect(await endWith('NOT_BUILT')).toMatchObject({
      status: 'ERROR',
      errorMessage: 'The build ended without running the tests. Open the Jenkins build for the log.',
    });
    expect(await scriptState()).toBe('SAVED');
  });

  it('a queue item or a build that Jenkins no longer has ends the run as ERROR', async () => {
    const queued = await startRun(world, stub);
    stub.queue.clear();
    expect((await poll(world, queued.id)).json().execution).toMatchObject({
      status: 'ERROR',
      stage: 'COMPLETED',
      errorMessage: 'Jenkins no longer has this run. Open the job in Jenkins to see what happened.',
    });

    const running = await startRun(world, stub);
    setBuild(stub, running.queueId, 41);
    expect((await poll(world, running.id)).json().execution.status).toBe('RUNNING');
    stub.builds.clear();
    expect((await poll(world, running.id)).json().execution).toMatchObject({ status: 'ERROR', buildNumber: 41 });
  });

  it('a run still queued after 10 minutes ends as ERROR and leaves the Jenkins queue', async () => {
    const { id, queueId } = await startRun(world, stub);
    world.clock.t += 9 * 60_000;
    expect((await poll(world, id)).json().execution.status).toBe('QUEUED');
    world.clock.t += 60_000;
    expect((await poll(world, id)).json().execution).toMatchObject({
      status: 'ERROR',
      stage: 'COMPLETED',
      errorMessage: 'Jenkins did not start the build. Check that an agent is online.',
    });
    expect(stub.queue.get(queueId)!.cancelled).toBe(true);
  });

  it('asks Jenkins at most once every 2 seconds for a run', async () => {
    const { id } = await startRun(world, stub);
    const get = () => world.ctx.app.inject({ method: 'GET', url: `/api/executions/${id}`, headers: world.asUser });
    await get();
    const afterFirst = stub.requests.length;
    await get();
    await get();
    expect(stub.requests.length).toBe(afterFirst);
    world.clock.t += 2_000;
    await get();
    expect(stub.requests.length).toBe(afterFirst + 1);
  });

  it('a Jenkins error during sync changes nothing', async () => {
    const { id, queueId } = await startRun(world, stub);
    setBuild(stub, queueId, 41);
    await poll(world, id);
    const before = await row(id);

    for (const status of [503, 401]) {
      stub.failWith = status;
      const res = await poll(world, id);
      expect(res.statusCode).toBe(200);
      expect(res.json().execution).toMatchObject({ status: 'RUNNING', buildNumber: 41 });
    }
    expect(await row(id)).toEqual(before);

    // Jenkins is back: the run carries on from where it was.
    stub.failWith = null;
    Object.assign(build(41), { ...ENDED, result: 'SUCCESS' });
    expect((await poll(world, id)).json().execution.status).toBe('PASSED');
  });

  it('a final status never changes, and Jenkins is not asked again', async () => {
    const execution = await endWith('SUCCESS');
    build(41).result = 'FAILURE';
    const asked = stub.requests.length;
    expect((await poll(world, execution.id)).json().execution.status).toBe('PASSED');
    expect(stub.requests.length).toBe(asked);
  });

  it('a late answer from Jenkins cannot reopen a finished run', async () => {
    const { id } = await startRun(world, stub);
    // The build has reported its number, but nobody has polled yet: the stored status is QUEUED.
    await world.ctx.db('test_executions').where({ id }).update({ jenkins_build_number: 41 });
    stub.builds.set(`${JOB}/41`, { building: true, result: null, timestamp: STARTED, duration: 0 });

    // The first poll's answer ("still running") is held back while the build ends and a
    // second poll records the result.
    const held = stub.holdNext();
    const slow = poll(world, id);
    await held.arrived;
    Object.assign(build(41), { ...ENDED, result: 'SUCCESS' });
    expect((await poll(world, id)).json().execution.status).toBe('PASSED');

    held.release();
    expect((await slow).json().execution.status).toBe('PASSED');
    expect(await row(id)).toMatchObject({ status: 'PASSED', stage: 'COMPLETED' });
  });

  it('a run of an older version does not mark the script', async () => {
    const started = await startRun(world, stub);
    const saved = await world.ctx.app.inject({
      method: 'PUT',
      url: `/api/scripts/${world.scriptId}`,
      headers: world.asUser,
      payload: { content: `${SAMPLE}\n// edited while the run was in progress\n`, baseVersion: 1 },
    });
    expect(saved.statusCode).toBe(200);

    setBuild(stub, started.queueId, 41, { ...ENDED, result: 'SUCCESS' });
    expect((await poll(world, started.id)).json().execution).toMatchObject({ status: 'PASSED', scriptVersion: 1 });
    expect(await scriptState()).toBe('SAVED');
  });

  it('a run nobody watched is brought up to date before a new run is refused', async () => {
    const first = await startRun(world, stub);
    setBuild(stub, first.queueId, 41, { ...ENDED, result: 'SUCCESS' });
    // Nobody polled, so the stored status is still QUEUED.
    expect((await row(first.id)).status).toBe('QUEUED');

    expect((await run(world)).statusCode).toBe(201);
    expect((await row(first.id)).status).toBe('PASSED');
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test -w server -- test/execution-sync.test.ts`
Expected: FAIL — 14 of 15. `stays QUEUED while Jenkins has not started the build` passes already, because nothing has to change for it. `a late answer from Jenkins cannot reopen a finished run` fails by timeout (about 20 seconds): no request reaches the stub yet.

- [ ] **Step 4: Add the two repository methods**

In `PlaywrightPlatform/server/src/repositories/execution-repository.ts` add to the class:

```ts
  /**
   * Locks an unfinished run until the transaction ends and returns how many tests its build
   * has reported. Null when the run already has a final status.
   */
  async lockActive(id: number): Promise<{ total: number } | null> {
    const row = await this.db('test_executions')
      .where({ id })
      .whereIn('status', UNFINISHED)
      .forUpdate()
      .first('total_tests');
    return row ? { total: row.total_tests } : null;
  }
```

In `PlaywrightPlatform/server/src/repositories/script-repository.ts` add to the class, after `softDelete`:

```ts
  /**
   * Records how a run of `version` ended. Skipped when the script has since moved to a newer
   * version, whose content has not been run. A run is not an edit, so `updated_at` and
   * `updated_by` are left alone.
   */
  async markRunResult(id: number, version: number, state: 'PASSED' | 'FAILED'): Promise<void> {
    await this.db('test_scripts')
      .where({ id, version })
      .whereNot('status', 'DELETED')
      .update({ lifecycle_state: state });
  }
```

- [ ] **Step 5: Teach the service to sync**

All changes are in `PlaywrightPlatform/server/src/services/execution-service.ts`.

Replace the import block with:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import { JenkinsError, type BuildState } from '../jenkins/jenkins-client';
import { jenkinsReportUrl } from '../jenkins/urls';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ExecutionPatch, ExecutionRepository } from '../repositories/execution-repository';
import type { ScriptRepository } from '../repositories/script-repository';
import { hashToken, newToken } from '../security/tokens';
import type { Actor, Execution, ExecutionStatus } from '../types';
import type { AuditService } from './audit-service';
import { toAppError, type JenkinsLink, type JenkinsService } from './jenkins-service';
```

Add above `export class ExecutionService`:

```ts
const SYNC_INTERVAL_MS = 2_000;
const QUEUE_TIMEOUT_MS = 10 * 60_000;

const FINAL: ReadonlySet<ExecutionStatus> = new Set<ExecutionStatus>(['PASSED', 'FAILED', 'ABORTED', 'ERROR']);

const BUILD_FAILED_EARLY = 'The build failed before the tests ran. Open the Jenkins build for the log.';
const BUILD_NOT_RUN = 'The build ended without running the tests. Open the Jenkins build for the log.';
const BUILD_LOST = 'Jenkins no longer has this run. Open the job in Jenkins to see what happened.';
const QUEUE_TIMED_OUT = 'Jenkins did not start the build. Check that an agent is online.';

interface Outcome {
  status: 'PASSED' | 'FAILED' | 'ABORTED' | 'ERROR';
  errorMessage?: string;
}

/** The final status for a build that ended. `total` is how many tests the build reported back. */
function outcomeOf(result: BuildState['result'], total: number): Outcome {
  switch (result) {
    case 'SUCCESS':
      return { status: 'PASSED' };
    case 'UNSTABLE':
      return { status: 'FAILED' };
    case 'FAILURE':
      // The pipeline marks failing tests UNSTABLE, so FAILURE means the build itself broke,
      // unless it got far enough to report tests.
      return total > 0 ? { status: 'FAILED' } : { status: 'ERROR', errorMessage: BUILD_FAILED_EARLY };
    case 'ABORTED':
      return { status: 'ABORTED' };
    default:
      return { status: 'ERROR', errorMessage: BUILD_NOT_RUN };
  }
}
```

Add as the first member of the class, above the constructor:

```ts
  /** When each unfinished run was last checked against Jenkins (milliseconds). */
  private readonly lastSync = new Map<number, number>();
```

In `run`, directly after `const link = await this.jenkins.link();`, add:

```ts
    // A run nobody watched still reads as unfinished. Bring it up to date before refusing a new one.
    const stale = await this.executions.findActive(scriptId);
    if (stale) await this.sync(stale, link);
```

Replace `get` with:

```ts
  /** Reads a run. An unfinished one is first brought up to date with Jenkins, at most once every 2 seconds. */
  async get(id: number): Promise<Execution> {
    const execution = await this.find(id);
    if (FINAL.has(execution.status)) return execution;
    const now = this.options.now();
    const last = this.lastSync.get(id);
    if (last !== undefined && now - last < SYNC_INTERVAL_MS) return execution;
    this.lastSync.set(id, now);
    await this.sync(execution, await this.jenkins.link());
    return this.find(id);
  }
```

Add these private methods above `find`:

```ts
  /**
   * Brings one unfinished run up to date with Jenkins. Status comes only from Jenkins.
   * If Jenkins cannot be reached, or refuses, the run is left as it is: one bad poll must
   * not fail a run.
   */
  private async sync(execution: Execution, link: JenkinsLink): Promise<void> {
    try {
      let buildNumber = execution.buildNumber;
      if (buildNumber === null) {
        // Until the build has a number, only the queue item knows what became of the run.
        const item = execution.queueId === null ? null : await link.client.queueItem(execution.queueId);
        if (item?.cancelled) {
          await this.finish(execution, () => ({ status: 'ABORTED' }), { completedAt: this.nowDate() });
          return;
        }
        if (!item || item.buildNumber === null) {
          await this.expireIfStuck(execution, link);
          return;
        }
        buildNumber = item.buildNumber;
        await this.executions.updateActive(execution.id, {
          buildNumber,
          reportUrl: jenkinsReportUrl(link.baseUrl, execution.jobName, buildNumber),
        });
      }

      const build = await link.client.build(execution.jobName, buildNumber);
      const startedAt = new Date(build.timestamp);
      if (build.building) {
        if (execution.status !== 'RUNNING') {
          await this.executions.updateActive(execution.id, { status: 'RUNNING', stage: 'RUNNING', startedAt });
        }
        return;
      }
      await this.finish(execution, (total) => outcomeOf(build.result, total), {
        startedAt,
        completedAt: new Date(build.timestamp + build.duration),
        durationMs: build.duration,
      });
    } catch (err) {
      if (!(err instanceof JenkinsError)) throw err;
      // Unreachable or refused: nothing changes, and the caller answers with what is stored.
      if (err.kind !== 'NOT_FOUND') return;
      await this.finish(execution, () => ({ status: 'ERROR', errorMessage: BUILD_LOST }), {
        completedAt: this.nowDate(),
      });
    }
  }

  /** A run that has waited 10 minutes for a build is given up, and taken out of the Jenkins queue. */
  private async expireIfStuck(execution: Execution, link: JenkinsLink): Promise<void> {
    if (this.options.now() - execution.createdAt.getTime() <= QUEUE_TIMEOUT_MS) return;
    // Otherwise the build could start later, with a run token that no longer works.
    if (execution.queueId !== null) await link.client.cancelQueue(execution.queueId);
    await this.finish(execution, () => ({ status: 'ERROR', errorMessage: QUEUE_TIMED_OUT }), {
      completedAt: this.nowDate(),
    });
  }

  /**
   * Gives a run its final status. `decide` is told how many tests the build reported; the
   * count is read under a lock, so a report arriving at the same moment is either counted
   * or refused. Does nothing when the run is already final.
   */
  private async finish(
    execution: Execution,
    decide: (total: number) => Outcome,
    times: { startedAt?: Date; completedAt: Date; durationMs?: number },
  ): Promise<void> {
    const status = await this.transact(async (r) => {
      const reported = await r.executions.lockActive(execution.id);
      if (!reported) return null;
      const outcome = decide(reported.total);
      const patch: ExecutionPatch = { status: outcome.status, stage: 'COMPLETED', callbackTokenHash: null, ...times };
      if (outcome.errorMessage) patch.errorMessage = outcome.errorMessage;
      await r.executions.updateActive(execution.id, patch);
      if (outcome.status === 'PASSED' || outcome.status === 'FAILED') {
        await r.scripts.markRunResult(execution.scriptId, execution.scriptVersion, outcome.status);
      }
      return outcome.status;
    });
    if (!status) return;
    this.lastSync.delete(execution.id);
    this.log.info(`[EXECUTION] Run ${execution.id} finished: ${status}`);
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm test -w server -- test/execution-sync.test.ts`, then `npm test -w server -- test/execution-run.test.ts`, then `npm run typecheck`, then `npm test`
Expected: 15 passed; 11 passed; typecheck clean; whole suite green.

- [ ] **Step 7: Commit**

```bash
git add PlaywrightPlatform/server/src PlaywrightPlatform/server/test/execution-helpers.ts PlaywrightPlatform/server/test/execution-sync.test.ts
git commit -m "feat(platform): keep a run's status in step with Jenkins"
```

---

### Task 6: Stop a run, and the two endpoints the pipeline calls

**Files:**
- Modify: `PlaywrightPlatform/server/src/services/execution-service.ts`
- Modify: `PlaywrightPlatform/server/src/schemas/executions.ts`
- Modify: `PlaywrightPlatform/server/src/routes/executions.ts`
- Test: `PlaywrightPlatform/server/test/execution-pipeline.test.ts`

**Interfaces:**
- Consumes: `ExecutionService` with its private `sync`, `finish`, `find`, `nowDate`, `record`, and the constant `FINAL` (Tasks 4 and 5); `ExecutionRepository.updateActive` and `.find` (Task 4); `JenkinsClient.stopBuild` and `.cancelQueue` (Task 2); `toAppError` (Task 3); `jenkinsReportUrl` (Task 2); the existing `ScriptRepository.findVersion` and `safeEqual` in `src/security/tokens.ts`; test helpers `startWorld`, `startRun`, `run`, `poll`, `setBuild`, `JOB`, `STARTED`.
- Produces:
  - `ExecutionService.stop(actor, id): Promise<Execution>`
  - `ExecutionService.scriptFor(id, token: string, buildNumber: number | null): Promise<string>`
  - `ExecutionService.report(id, token: string, report: RunReport): Promise<void>` with `RunReport = { total: number; passed: number; failed: number; skipped: number; errorMessage?: string }`
  - `runReportBody` in `schemas/executions.ts`
  - Routes `POST /api/executions/:id/stop`, `GET /api/executions/:id/script`, `POST /api/executions/:id/result`

- [ ] **Step 1: Write the failing test**

Create `PlaywrightPlatform/server/test/execution-pipeline.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB, poll, run, setBuild, STARTED, startRun, startWorld, type RunWorld } from './execution-helpers';
import { closeApp } from './helpers';
import { startJenkinsStub, type JenkinsStub } from './jenkins-stub';
import { newScript, SAMPLE } from './script-helpers';

type Headers = Record<string, string>;

const COUNTS = { total: 1, passed: 1, failed: 0, skipped: 0 };
const PASSED_BUILD = { building: false, result: 'SUCCESS' as const, duration: 1_000 };

describe('executions: stop and the pipeline endpoints', () => {
  let stub: JenkinsStub;
  let world: RunWorld;

  beforeAll(async () => {
    stub = await startJenkinsStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    world = await startWorld(stub);
  });
  afterEach(() => closeApp(world.ctx));

  const row = (id: number) => world.ctx.db('test_executions').where({ id }).first();
  const bearer = (token: string | null): Headers => (token === null ? {} : { authorization: `Bearer ${token}` });
  const stop = (id: number, headers: Headers = world.asUser) =>
    world.ctx.app.inject({ method: 'POST', url: `/api/executions/${id}/stop`, headers });
  const fetchScript = (id: number, token: string | null, extra: Headers = {}) =>
    world.ctx.app.inject({
      method: 'GET',
      url: `/api/executions/${id}/script`,
      headers: { ...bearer(token), ...extra },
    });
  const postResult = (id: number, token: string | null, payload: object) =>
    world.ctx.app.inject({ method: 'POST', url: `/api/executions/${id}/result`, headers: bearer(token), payload });
  const stopRequests = () => stub.requests.filter((req) => req.method === 'POST' && req.path.endsWith('/stop'));

  describe('stop', () => {
    it('stops a queued run: taken out of the Jenkins queue and ABORTED at once', async () => {
      const { id, queueId } = await startRun(world, stub);
      const res = await stop(id);
      expect(res.statusCode).toBe(200);
      expect(res.json().execution).toMatchObject({ status: 'ABORTED', stage: 'COMPLETED', buildNumber: null });
      expect(stub.queue.get(queueId)!.cancelled).toBe(true);
      expect((await row(id)).callback_token_hash).toBeNull();
      const audit = await world.ctx.db('audit_logs').where({ action: 'execution.stop' }).first();
      expect(audit.resource_id).toBe(String(id));
    });

    it('stops a running build', async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41);
      await poll(world, id);
      const res = await stop(id, world.asAdmin);
      expect(res.statusCode).toBe(200);
      expect(res.json().execution).toMatchObject({ status: 'ABORTED', stage: 'COMPLETED', buildNumber: 41 });
      expect(stopRequests().map((req) => req.path)).toEqual([`/job/${JOB}/41/stop`]);
    });

    it('stops a build that started without anyone polling', async () => {
      const { id, queueId } = await startRun(world, stub);
      setBuild(stub, queueId, 41);
      // Nobody polled: the stored run is still QUEUED and has no build number.
      const res = await stop(id);
      expect(res.json().execution).toMatchObject({ status: 'ABORTED', buildNumber: 41 });
      expect(stopRequests()).toHaveLength(1);
      expect(stub.queue.get(queueId)!.cancelled).toBe(false);
    });

    it('refuses a VIEWER, a missing session, an unknown run, and a run that has already finished', async () => {
      const { id, queueId } = await startRun(world, stub);
      expect((await stop(id, world.asViewer)).statusCode).toBe(403);
      expect((await stop(id, {})).statusCode).toBe(401);
      expect((await stop(999)).statusCode).toBe(404);

      // The build ended without anyone polling; stop learns that and says so.
      setBuild(stub, queueId, 41, PASSED_BUILD);
      const res = await stop(id);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('EXECUTION_FINISHED');
      expect((await row(id)).status).toBe('PASSED');
      expect(stopRequests()).toHaveLength(0);
      // And again, now that the stored status is final.
      expect((await stop(id)).statusCode).toBe(409);
    });

    it('answers 502 and changes nothing when Jenkins cannot be reached', async () => {
      const { id } = await startRun(world, stub);
      stub.failWith = 503;
      const res = await stop(id);
      expect(res.statusCode).toBe(502);
      expect(res.json().error.code).toBe('JENKINS_UNREACHABLE');
      expect((await row(id)).status).toBe('QUEUED');
      expect(await world.ctx.db('audit_logs').where({ action: 'execution.stop' }).first()).toBeUndefined();
    });
  });

  describe('pipeline endpoints', () => {
    it('serves the script to the build and records the build number it reports', async () => {
      const { id, token } = await startRun(world, stub);
      const res = await fetchScript(id, token, { 'x-build-number': '41' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
      expect(res.body).toBe(SAMPLE);
      expect(await row(id)).toMatchObject({
        status: 'QUEUED',
        jenkins_build_number: 41,
        report_url: `${stub.url}/job/${JOB}/41/artifact/playwright-report/index.html`,
      });

      // The number lets a poll find the build after Jenkins has forgotten the queue item.
      stub.queue.clear();
      stub.builds.set(`${JOB}/41`, { building: true, result: null, timestamp: STARTED, duration: 0 });
      expect((await poll(world, id)).json().execution).toMatchObject({ status: 'RUNNING', buildNumber: 41 });
    });

    it('ignores a build number that is not a positive whole number, and keeps the first one', async () => {
      const { id, token } = await startRun(world, stub);
      for (const bad of ['abc', '0', '-3', '1.5', '99999999999']) {
        expect((await fetchScript(id, token, { 'x-build-number': bad })).statusCode).toBe(200);
      }
      expect((await row(id)).jenkins_build_number).toBeNull();

      await fetchScript(id, token, { 'x-build-number': '41' });
      await fetchScript(id, token, { 'x-build-number': '42' });
      expect((await row(id)).jenkins_build_number).toBe(41);
    });

    it('serves the recorded version after the script is edited, deleted, and its project archived', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      const edited = await world.ctx.app.inject({
        method: 'PUT',
        url: `/api/scripts/${world.scriptId}`,
        headers: world.asUser,
        payload: { content: `${SAMPLE}\n// newer\n`, baseVersion: 1 },
      });
      expect(edited.statusCode).toBe(200);
      expect((await fetchScript(id, token)).body).toBe(SAMPLE);

      const removed = await world.ctx.app.inject({
        method: 'DELETE',
        url: `/api/scripts/${world.scriptId}`,
        headers: world.asUser,
      });
      expect(removed.statusCode).toBe(204);
      const archived = await world.ctx.app.inject({
        method: 'PUT',
        url: `/api/projects/${world.projectId}`,
        headers: world.asAdmin,
        payload: { status: 'ARCHIVED' },
      });
      expect(archived.statusCode).toBe(200);
      expect((await fetchScript(id, token)).body).toBe(SAMPLE);

      // The run itself can still finish and be read.
      setBuild(stub, queueId, 41, PASSED_BUILD);
      expect((await poll(world, id)).json().execution).toMatchObject({
        status: 'PASSED',
        scriptName: 'Login Test',
        scriptVersion: 1,
      });
    });

    it('refuses a missing, wrong, or foreign token, and a session token', async () => {
      const first = await startRun(world, stub);
      const other = await newScript(world.ctx, world.asAdmin, world.projectId, { name: 'Other Test' });
      expect((await run(world, world.asUser, other.id)).statusCode).toBe(201);
      const foreignToken = stub.lastParams.RUN_TOKEN;
      const sessionToken = world.asUser.authorization.slice('Bearer '.length);

      const refused = async (id: number, token: string | null) => {
        const script = await fetchScript(id, token);
        const result = await postResult(id, token, COUNTS);
        expect([script.statusCode, result.statusCode]).toEqual([401, 401]);
        expect(script.json().error.code).toBe('UNAUTHENTICATED');
        expect(script.body).not.toContain('@playwright/test');
      };
      await refused(first.id, null);
      await refused(first.id, 'not-the-token');
      await refused(first.id, foreignToken);
      await refused(first.id, sessionToken);
      await refused(999, first.token);
      expect((await row(first.id)).total_tests).toBe(0);

      // The right token still works after all the wrong ones.
      expect((await fetchScript(first.id, first.token)).statusCode).toBe(200);
    });

    it('refuses the token once the run has finished', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      setBuild(stub, queueId, 41, PASSED_BUILD);
      expect((await poll(world, id)).json().execution.status).toBe('PASSED');

      expect((await fetchScript(id, token)).statusCode).toBe(401);
      expect((await postResult(id, token, { ...COUNTS, total: 9 })).statusCode).toBe(401);
      expect(await row(id)).toMatchObject({ status: 'PASSED', total_tests: 0, callback_token_hash: null });
    });

    it('stores the counts and the message from the build, and never the status', async () => {
      const { id, queueId, token } = await startRun(world, stub);
      const res = await postResult(id, token, {
        total: 3,
        passed: 2,
        failed: 1,
        skipped: 0,
        errorMessage: 'login: expected title',
        status: 'PASSED',
      });
      expect(res.statusCode).toBe(204);
      expect(await row(id)).toMatchObject({
        status: 'QUEUED',
        total_tests: 3,
        passed_tests: 2,
        failed_tests: 1,
        skipped_tests: 0,
        error_message: 'login: expected title',
      });

      // Jenkins decides the outcome; the counts and the message travel with it.
      setBuild(stub, queueId, 41, { building: false, result: 'UNSTABLE', duration: 1_000 });
      expect((await poll(world, id)).json().execution).toMatchObject({
        status: 'FAILED',
        total: 3,
        passed: 2,
        failed: 1,
        errorMessage: 'login: expected title',
      });
    });

    it('validates the report and trims a long message', async () => {
      const { id, token } = await startRun(world, stub);
      const bad = [
        {},
        { ...COUNTS, total: -1 },
        { ...COUNTS, passed: 1.5 },
        { ...COUNTS, failed: 'two' },
        { ...COUNTS, errorMessage: 7 },
      ];
      for (const payload of bad) expect((await postResult(id, token, payload)).statusCode).toBe(400);
      expect((await row(id)).total_tests).toBe(0);

      expect((await postResult(id, token, { ...COUNTS, errorMessage: 'x'.repeat(5_000) })).statusCode).toBe(204);
      expect((await row(id)).error_message).toHaveLength(2_000);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm test -w server -- test/execution-pipeline.test.ts`
Expected: FAIL — all 12 tests, with 404 where another status is expected (the routes do not exist).

- [ ] **Step 3: Add stop and the pipeline methods to the service**

All changes are in `PlaywrightPlatform/server/src/services/execution-service.ts`.

Change the tokens import to:

```ts
import { hashToken, newToken, safeEqual } from '../security/tokens';
```

Add below `runInProgress`:

```ts
function alreadyFinished(): AppError {
  return new AppError(409, 'EXECUTION_FINISHED', 'This run has already finished.');
}

// One answer for every reason, so a caller without the token learns nothing about the run.
function badRunToken(): AppError {
  return new AppError(401, 'UNAUTHENTICATED', 'The run token is not valid for this run.');
}

/** What a build reports when its tests have run. */
export interface RunReport {
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  errorMessage?: string;
}
```

Add these public methods after `list`:

```ts
  /**
   * Aborts an unfinished run. A run still waiting in the queue is ABORTED at once. For a
   * build, the answer carries what Jenkins says right after the stop request, which may
   * still be RUNNING.
   */
  async stop(actor: Actor, id: number): Promise<Execution> {
    const stored = await this.find(id);
    if (FINAL.has(stored.status)) throw alreadyFinished();
    const link = await this.jenkins.link();

    // The queued run may have become a build, or ended, since it was last read.
    await this.sync(stored, link);
    const execution = await this.find(id);
    if (FINAL.has(execution.status)) throw alreadyFinished();

    try {
      if (execution.buildNumber !== null) {
        await link.client.stopBuild(execution.jobName, execution.buildNumber);
      } else if (execution.queueId !== null) {
        await link.client.cancelQueue(execution.queueId);
      }
    } catch (err) {
      throw toAppError(err);
    }
    await this.record(actor, 'execution.stop', id, {
      scriptId: execution.scriptId,
      buildNumber: execution.buildNumber,
    });

    if (execution.buildNumber === null) {
      // Nothing is building, so there is nothing more to wait for.
      await this.finish(execution, () => ({ status: 'ABORTED' }), { completedAt: this.nowDate() });
    } else {
      await this.sync(execution, link);
    }
    this.log.info(`[EXECUTION] Stop requested for run ${id}`);
    return this.find(id);
  }

  /**
   * The script for a build: the version recorded when Run was pressed, whatever has happened
   * to the script since. The build also reports its number here, which is how a run is found
   * again after Jenkins has forgotten the queue item.
   */
  async scriptFor(id: number, token: string, buildNumber: number | null): Promise<string> {
    const execution = await this.authorize(id, token);
    if (buildNumber !== null && execution.buildNumber === null) {
      await this.executions.updateActive(id, {
        buildNumber,
        reportUrl: jenkinsReportUrl(execution.jenkinsBaseUrl, execution.jobName, buildNumber),
      });
    }
    const version = await this.scripts.findVersion(execution.scriptId, execution.scriptVersion);
    if (!version) throw notFound('Script version');
    return version.content;
  }

  /** Stores what the build reports. Status is never taken from here: it comes only from Jenkins. */
  async report(id: number, token: string, report: RunReport): Promise<void> {
    await this.authorize(id, token);
    const stored = await this.executions.updateActive(id, {
      total: report.total,
      passed: report.passed,
      failed: report.failed,
      skipped: report.skipped,
      errorMessage: report.errorMessage ?? null,
    });
    // False when the run reached a final status between the check and the write.
    if (!stored) throw badRunToken();
  }
```

Add this private method above `find`:

```ts
  /** The run a token belongs to. Refused unless the token is that run's own and the run is unfinished. */
  private async authorize(id: number, token: string): Promise<Execution> {
    const execution = await this.executions.find(id);
    const expected = execution?.callbackTokenHash;
    if (!execution || !expected || FINAL.has(execution.status) || !safeEqual(hashToken(token), expected)) {
      throw badRunToken();
    }
    return execution;
  }
```

- [ ] **Step 4: Add the schema and the routes**

Append to `PlaywrightPlatform/server/src/schemas/executions.ts`:

```ts
const count = z.number().int().min(0).max(1_000_000);

/** What the pipeline posts when the tests have run. Unknown keys, such as a status, are dropped. */
export const runReportBody = z.object({
  total: count,
  passed: count,
  failed: count,
  skipped: count,
  // Trimmed rather than refused: a long failure message must not cost the run its counts.
  // PostgreSQL text cannot hold a NUL character, so those are removed.
  errorMessage: z
    .string()
    .transform((text) => text.replace(/\u0000/g, '').slice(0, 2000))
    .optional(),
});
```

In `PlaywrightPlatform/server/src/routes/executions.ts` change the first import, add the `AppError` import, and add `runReportBody` to the schemas import:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../errors';
```
```ts
import {
  executionListResponse,
  executionResponse,
  listExecutionsQuery,
  runReportBody,
  toExecutionDto,
} from '../schemas/executions';
```

Add above `executionRoutes`:

```ts
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
```

Add inside `executionRoutes`, after the existing routes:

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm test -w server -- test/execution-pipeline.test.ts`, then `npm run typecheck`, then `npm test`
Expected: 12 passed; typecheck clean; whole suite green.

- [ ] **Step 6: Check the layering and the token, then commit**

Run (from the repo root): `grep -rn "fetch(" PlaywrightPlatform/server/src --include=*.ts | grep -v -e jenkins-client.ts -e jenkins/pipeline.ts`
Expected: no output. (`pipeline.ts` is left out because the `fetch` in it is text: the report script that the Jenkins build runs.)

Run: `grep -rnE "log\.(info|warn|error)\(.*(token|Token)" PlaywrightPlatform/server/src/services/execution-service.ts PlaywrightPlatform/server/src/services/jenkins-service.ts`
Expected: no output — no log line mentions a token.

```bash
git add PlaywrightPlatform/server/src PlaywrightPlatform/server/test/execution-pipeline.test.ts
git commit -m "feat(platform): stop a run and serve the pipeline its script"
```

---

### Task 7: Extension client methods and run view helpers

**Files:**
- Modify: `PlaywrightExtension/utils/platform-client.js`
- Create: `PlaywrightExtension/utils/execution-view.js`
- Modify: `PlaywrightExtension/tests/platform-client.test.mjs`
- Test: `PlaywrightExtension/tests/execution-view.test.mjs`

**Interfaces:**
- Consumes: the API of Tasks 3 to 6 — `GET/PUT /api/jenkins/settings`, `POST /api/jenkins/test`, `POST /api/jenkins/job`, `POST /api/scripts/:id/run`, `GET /api/executions/:id`, `POST /api/executions/:id/stop`, `GET /api/scripts/:id/executions?limit=`; and the existing `GET /api/projects/:projectId/scripts?search=` and `GET /api/scripts/:id`. The execution object has the fields of spec section 6.1.
- Produces:
  - On the object returned by `createPlatformClient` (and so on `PlatformClient`): `listScripts(projectId, search = '')`, `getScript(scriptId)`, `getJenkinsSettings()`, `saveJenkinsSettings({ baseUrl, username, jobName, token })`, `testJenkins({ baseUrl, username, token })`, `createJenkinsJob()`, `runScript(scriptId)`, `getExecution(executionId)`, `stopExecution(executionId)`, `listExecutions(scriptId, limit = 10)`
  - Errors thrown by the client now also carry `code` and `details` from the server
  - From `execution-view.js`: `isFinal(status): boolean`, `statusView(status): { label, className }`, `durationText(ms): string`, `countsText(execution): string`, `runSummary(execution): string`, `safeJenkinsLink(url, jenkinsBaseUrl = ''): string | null`, `runLinks(execution, jenkinsBaseUrl = ''): Array<{ label, href }>`, `runControls({ role, projectStatus, jenkinsConfigured, execution }): { showRun, runDisabled, showStop, note }`

All commands in this task run from the repo root.

- [ ] **Step 1: Write the failing view test**

Create `PlaywrightExtension/tests/execution-view.test.mjs`:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  countsText,
  durationText,
  isFinal,
  runControls,
  runLinks,
  runSummary,
  safeJenkinsLink,
  statusView,
} from '../utils/execution-view.js';

describe('execution view', () => {
  it('names every status and gives it one of the fixed classes', () => {
    assert.deepEqual(statusView('QUEUED'), { label: 'Queued', className: 'run-status run-wait' });
    assert.deepEqual(statusView('RUNNING'), { label: 'Running', className: 'run-status run-run' });
    assert.deepEqual(statusView('PASSED'), { label: 'Passed', className: 'run-status run-ok' });
    assert.deepEqual(statusView('FAILED'), { label: 'Failed', className: 'run-status run-bad' });
    assert.deepEqual(statusView('ABORTED'), { label: 'Aborted', className: 'run-status run-off' });
    assert.deepEqual(statusView('ERROR'), { label: 'Error', className: 'run-status run-bad' });
  });

  it('never builds a label or a class from a status it does not know', () => {
    for (const odd of ['"><img src=x onerror=alert(1)>', 'constructor', '__proto__', undefined, null, 7]) {
      assert.deepEqual(statusView(odd), { label: 'Unknown', className: 'run-status run-off' });
    }
  });

  it('knows which statuses are final, and treats an unknown one as final so polling ends', () => {
    assert.equal(isFinal('QUEUED'), false);
    assert.equal(isFinal('RUNNING'), false);
    for (const status of ['PASSED', 'FAILED', 'ABORTED', 'ERROR', 'SOMETHING_NEW', undefined]) {
      assert.equal(isFinal(status), true);
    }
  });

  it('formats durations', () => {
    assert.equal(durationText(0), '0s');
    assert.equal(durationText(42_400), '42s');
    assert.equal(durationText(65_000), '1m 05s');
    assert.equal(durationText(3_725_000), '1h 02m');
    for (const none of [null, undefined, -1, NaN, '65000']) assert.equal(durationText(none), '');
  });

  it('formats counts, and says nothing when no test was reported', () => {
    assert.equal(countsText({ total: 3, passed: 2, failed: 1, skipped: 0 }), '3 tests: 2 passed, 1 failed');
    assert.equal(countsText({ total: 1, passed: 1, failed: 0, skipped: 0 }), '1 test: 1 passed, 0 failed');
    assert.equal(
      countsText({ total: 4, passed: 2, failed: 1, skipped: 1 }),
      '4 tests: 2 passed, 1 failed, 1 skipped',
    );
    assert.equal(countsText({ total: 0, passed: 0, failed: 0, skipped: 0 }), '');
    assert.equal(countsText(null), '');
  });

  it('summarises a run for the recent runs list', () => {
    assert.equal(
      runSummary({ id: 12, status: 'PASSED', scriptVersion: 2, durationMs: 65_000 }),
      '#12 · Passed · v2 · 1m 05s',
    );
    assert.equal(runSummary({ id: 13, status: 'RUNNING', scriptVersion: 3, durationMs: null }), '#13 · Running · v3');
  });

  it('offers a link only for an http or https address', () => {
    assert.equal(safeJenkinsLink('http://localhost:7070/job/run/41/'), 'http://localhost:7070/job/run/41/');
    assert.equal(safeJenkinsLink('https://ci.example.com/job/run/41/'), 'https://ci.example.com/job/run/41/');
    const bad = [
      'javascript:alert(1)',
      ' JavaScript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///c:/secret.txt',
      'chrome://settings',
      '//evil.example/x',
      'job/run/41/',
      '',
      null,
      undefined,
      41,
    ];
    for (const url of bad) assert.equal(safeJenkinsLink(url), null);
  });

  it('when the Jenkins address is known, offers a link only under it', () => {
    const base = 'http://localhost:7070';
    assert.equal(safeJenkinsLink('http://localhost:7070/job/run/41/', base), 'http://localhost:7070/job/run/41/');
    assert.equal(safeJenkinsLink('http://localhost:7070/job/run/41/', `${base}/`), 'http://localhost:7070/job/run/41/');
    const bad = [
      'http://localhost:7070@evil.example/job/run/41/',
      'http://localhost:70700/job/run/41/',
      'http://evil.example/http://localhost:7070/',
      'https://localhost:7070/job/run/41/',
    ];
    for (const url of bad) assert.equal(safeJenkinsLink(url, base), null);
  });

  it('offers the Jenkins link once there is a build, and the report link once the tests ran', () => {
    const urls = {
      buildUrl: 'http://localhost:7070/job/run/41/',
      reportUrl: 'http://localhost:7070/job/run/41/artifact/playwright-report/index.html',
    };
    const jenkins = { label: 'Open in Jenkins', href: urls.buildUrl };
    const report = { label: 'Open report', href: urls.reportUrl };

    assert.deepEqual(runLinks({ status: 'QUEUED', buildUrl: null, reportUrl: null }), []);
    assert.deepEqual(runLinks({ status: 'RUNNING', ...urls }), [jenkins]);
    assert.deepEqual(runLinks({ status: 'PASSED', ...urls }), [jenkins, report]);
    assert.deepEqual(runLinks({ status: 'FAILED', ...urls }), [jenkins, report]);
    assert.deepEqual(runLinks({ status: 'ERROR', ...urls }), [jenkins]);
    assert.deepEqual(runLinks({ status: 'ABORTED', ...urls }), [jenkins]);
    assert.deepEqual(runLinks({ status: 'PASSED', buildUrl: 'javascript:alert(1)', reportUrl: 'javascript:alert(2)' }), []);
    assert.deepEqual(runLinks({ status: 'PASSED', ...urls }, 'http://other:8080'), []);
    assert.deepEqual(runLinks(null), []);
  });

  it('offers Run to ADMIN and USER in an active project once Jenkins is set up', () => {
    const base = { projectStatus: 'ACTIVE', jenkinsConfigured: true, execution: null };
    const offered = { showRun: true, runDisabled: false, showStop: false, note: '' };
    assert.deepEqual(runControls({ ...base, role: 'ADMIN' }), offered);
    assert.deepEqual(runControls({ ...base, role: 'USER' }), offered);
    assert.deepEqual(runControls({ ...base, role: 'VIEWER' }), { ...offered, showRun: false });
    assert.deepEqual(runControls({ ...base, role: undefined }), { ...offered, showRun: false });
  });

  it('replaces Run with a line when Jenkins is not set up or the project is archived', () => {
    const writer = { role: 'USER', execution: null };
    assert.deepEqual(runControls({ ...writer, projectStatus: 'ACTIVE', jenkinsConfigured: false }), {
      showRun: false,
      runDisabled: false,
      showStop: false,
      note: 'Jenkins is not set up yet. An administrator must set it up under Settings → Jenkins.',
    });
    assert.deepEqual(runControls({ ...writer, projectStatus: 'ARCHIVED', jenkinsConfigured: true }), {
      showRun: false,
      runDisabled: false,
      showStop: false,
      note: 'This project is archived, so its scripts cannot be run.',
    });
    // A VIEWER cannot run anything, so there is nothing to explain.
    assert.equal(runControls({ role: 'VIEWER', projectStatus: 'ACTIVE', jenkinsConfigured: false, execution: null }).note, '');
  });

  it('while a run is unfinished, disables Run and offers Stop to writers only', () => {
    const base = { projectStatus: 'ACTIVE', jenkinsConfigured: true };
    for (const status of ['QUEUED', 'RUNNING']) {
      assert.deepEqual(runControls({ ...base, role: 'USER', execution: { status } }), {
        showRun: true,
        runDisabled: true,
        showStop: true,
        note: '',
      });
      assert.equal(runControls({ ...base, role: 'VIEWER', execution: { status } }).showStop, false);
    }
    assert.deepEqual(runControls({ ...base, role: 'USER', execution: { status: 'PASSED' } }), {
      showRun: true,
      runDisabled: false,
      showStop: false,
      note: '',
    });
  });
});
```

- [ ] **Step 2: Write the failing client tests**

In `PlaywrightExtension/tests/platform-client.test.mjs`, add these tests inside the `describe('platform client', …)` block, after the last existing test:

```js
  const SIGNED_IN = { url: 'http://localhost:3000', token: 'tok-123', user: USER };

  it("listScripts asks for a project's scripts, with the search text when given", async () => {
    saved = SIGNED_IN;
    responder = () => json(200, { items: [{ id: 3, name: 'Login Test' }], total: 1, page: 1, pageSize: 100 });
    assert.deepEqual(await client.listScripts(7), [{ id: 3, name: 'Login Test' }]);
    assert.equal(calls[0].url, 'http://localhost:3000/api/projects/7/scripts?pageSize=100');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');

    await client.listScripts(7, '  log in & out ');
    assert.equal(calls[1].url, 'http://localhost:3000/api/projects/7/scripts?pageSize=100&search=log+in+%26+out');
  });

  it('getScript returns the script with its content', async () => {
    saved = SIGNED_IN;
    responder = () => json(200, { script: { id: 3, content: 'x' } });
    assert.deepEqual(await client.getScript(3), { id: 3, content: 'x' });
    assert.equal(calls[0].url, 'http://localhost:3000/api/scripts/3');
  });

  it('Jenkins settings: reads them, and saves without a token unless one was typed', async () => {
    saved = SIGNED_IN;
    const settings = { configured: true, baseUrl: 'http://localhost:7070', username: 'ci', jobName: 'run', hasToken: true };
    responder = () => json(200, { settings });
    assert.deepEqual(await client.getJenkinsSettings(), settings);
    assert.equal(calls[0].url, 'http://localhost:3000/api/jenkins/settings');

    const kept = await client.saveJenkinsSettings({ baseUrl: 'http://localhost:7070', username: 'ci', jobName: 'run', token: '' });
    assert.deepEqual(kept, settings);
    assert.equal(calls[1].init.method, 'PUT');
    assert.deepEqual(JSON.parse(calls[1].init.body), { baseUrl: 'http://localhost:7070', username: 'ci', jobName: 'run' });

    await client.saveJenkinsSettings({ baseUrl: 'http://localhost:7070', username: 'ci', jobName: '', token: 'secret' });
    assert.deepEqual(JSON.parse(calls[2].init.body), { baseUrl: 'http://localhost:7070', username: 'ci', token: 'secret' });
  });

  it('testJenkins sends only the fields that were filled in', async () => {
    saved = SIGNED_IN;
    const result = { ok: true, version: '2.555.2', pipelinePlugin: true, message: 'Connected to Jenkins 2.555.2.' };
    responder = () => json(200, result);
    assert.deepEqual(await client.testJenkins({ baseUrl: 'http://localhost:7070', username: '', token: 'secret' }), result);
    assert.equal(calls[0].url, 'http://localhost:3000/api/jenkins/test');
    assert.equal(calls[0].init.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].init.body), { baseUrl: 'http://localhost:7070', token: 'secret' });

    await client.testJenkins();
    assert.deepEqual(JSON.parse(calls[1].init.body), {});
  });

  it('createJenkinsJob, runScript, and stopExecution post without a body', async () => {
    saved = SIGNED_IN;
    responder = (url) =>
      url.endsWith('/jenkins/job')
        ? json(200, { created: true, jobUrl: 'http://localhost:7070/job/run/' })
        : json(url.endsWith('/run') ? 201 : 200, { execution: { id: 12, status: 'QUEUED' } });

    assert.deepEqual(await client.createJenkinsJob(), { created: true, jobUrl: 'http://localhost:7070/job/run/' });
    assert.deepEqual(await client.runScript(3), { id: 12, status: 'QUEUED' });
    assert.deepEqual(await client.stopExecution(12), { id: 12, status: 'QUEUED' });

    assert.deepEqual(
      calls.map((call) => call.url),
      [
        'http://localhost:3000/api/jenkins/job',
        'http://localhost:3000/api/scripts/3/run',
        'http://localhost:3000/api/executions/12/stop',
      ],
    );
    for (const call of calls) {
      assert.equal(call.init.method, 'POST');
      assert.equal(call.init.body, undefined);
      // The server refuses a JSON content type that comes with no body.
      assert.equal(call.init.headers['Content-Type'], undefined);
    }
  });

  it('getExecution and listExecutions read runs', async () => {
    saved = SIGNED_IN;
    responder = (url) =>
      url.includes('/scripts/') ? json(200, { items: [{ id: 12 }] }) : json(200, { execution: { id: 12 } });
    assert.deepEqual(await client.getExecution(12), { id: 12 });
    assert.equal(calls[0].url, 'http://localhost:3000/api/executions/12');
    assert.deepEqual(await client.listExecutions(3), [{ id: 12 }]);
    assert.equal(calls[1].url, 'http://localhost:3000/api/scripts/3/executions?limit=10');
    await client.listExecutions(3, 5);
    assert.equal(calls[2].url, 'http://localhost:3000/api/scripts/3/executions?limit=5');
    await client.listExecutions(3, 500);
    assert.equal(calls[3].url, 'http://localhost:3000/api/scripts/3/executions?limit=10');
  });

  it('a refused run carries the server code and details, so the panel can show the run in progress', async () => {
    saved = SIGNED_IN;
    responder = () =>
      json(409, {
        error: {
          code: 'RUN_IN_PROGRESS',
          message: 'This script is already running. Wait for that run to finish, or stop it.',
          details: { executionId: 12 },
        },
      });
    await assert.rejects(client.runScript(3), (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'RUN_IN_PROGRESS');
      assert.deepEqual(err.details, { executionId: 12 });
      assert.match(err.message, /already running/);
      return true;
    });
  });

  it('the new methods refuse ids that are not positive whole numbers, and need a sign-in', async () => {
    saved = SIGNED_IN;
    for (const bad of ['3/../../users', 0, -1, 1.5, NaN, undefined]) {
      await assert.rejects(client.listScripts(bad), /Choose a project/);
      await assert.rejects(client.getScript(bad), /Choose a script/);
      await assert.rejects(client.runScript(bad), /Choose a script/);
      await assert.rejects(client.listExecutions(bad), /Choose a script/);
      await assert.rejects(client.getExecution(bad), /Choose a run/);
      await assert.rejects(client.stopExecution(bad), /Choose a run/);
    }
    assert.equal(calls.length, 0);

    saved = { url: '', token: '', user: null };
    await assert.rejects(client.getJenkinsSettings(), /Sign in to the platform first/);
    await assert.rejects(client.runScript(3), /Sign in to the platform first/);
    assert.equal(calls.length, 0);
  });
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `node --test "PlaywrightExtension/tests/*.test.mjs"`
Expected: FAIL — `execution-view.test.mjs` cannot find `../utils/execution-view.js`, and the 8 new client tests fail with `client.listScripts is not a function` (or the matching method name). The 31 existing tests still pass.

- [ ] **Step 4: Write the view helpers**

Create `PlaywrightExtension/utils/execution-view.js`:

```js
// Pure helpers that turn a run (an "execution" from the platform API) into what the side
// panel shows. No DOM and no chrome.* calls, so they are tested with node --test.

const STATUS = {
  QUEUED: { label: 'Queued', tone: 'wait' },
  RUNNING: { label: 'Running', tone: 'run' },
  PASSED: { label: 'Passed', tone: 'ok' },
  FAILED: { label: 'Failed', tone: 'bad' },
  ABORTED: { label: 'Aborted', tone: 'off' },
  ERROR: { label: 'Error', tone: 'bad' },
};

const UNFINISHED = new Set(['QUEUED', 'RUNNING']);

// True once a run can no longer change. A status this code does not know counts as final,
// so polling always ends.
export function isFinal(status) {
  return !UNFINISHED.has(status);
}

// { label, className } for a status. Both come from the fixed table above, never from the
// server's text.
export function statusView(status) {
  const known = typeof status === 'string' && Object.hasOwn(STATUS, status) ? STATUS[status] : null;
  return known
    ? { label: known.label, className: `run-status run-${known.tone}` }
    : { label: 'Unknown', className: 'run-status run-off' };
}

// "42s", "1m 05s", "1h 02m", or "" when the run has no duration yet.
export function durationText(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

// "3 tests: 2 passed, 1 failed", or "" when the build reported no test.
export function countsText(execution) {
  const total = Number(execution?.total) || 0;
  if (total <= 0) return '';
  const parts = [`${Number(execution.passed) || 0} passed`, `${Number(execution.failed) || 0} failed`];
  const skipped = Number(execution.skipped) || 0;
  if (skipped > 0) parts.push(`${skipped} skipped`);
  return `${total} ${total === 1 ? 'test' : 'tests'}: ${parts.join(', ')}`;
}

// One line for the recent runs list: "#12 · Passed · v2 · 1m 05s".
export function runSummary(execution) {
  const parts = [`#${execution.id}`, statusView(execution.status).label, `v${execution.scriptVersion}`];
  const duration = durationText(execution.durationMs);
  if (duration) parts.push(duration);
  return parts.join(' · ');
}

// The address to link to, or null when no link may be offered. Only http and https are ever
// linked. When the panel knows the Jenkins address (an ADMIN's panel does), the link must
// also be under it.
export function safeJenkinsLink(url, jenkinsBaseUrl = '') {
  if (typeof url !== 'string' || url === '') return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  const base = String(jenkinsBaseUrl || '').replace(/\/+$/, '');
  // The slash matters: "http://ci:8080@evil.example/" starts with "http://ci:8080" but not with "http://ci:8080/".
  if (base && !url.startsWith(`${base}/`)) return null;
  return parsed.href;
}

// The links the status card offers: [{ label, href }]. The report exists only after the tests ran.
export function runLinks(execution, jenkinsBaseUrl = '') {
  const links = [];
  const build = safeJenkinsLink(execution?.buildUrl, jenkinsBaseUrl);
  if (build) links.push({ label: 'Open in Jenkins', href: build });
  const testsRan = execution?.status === 'PASSED' || execution?.status === 'FAILED';
  const report = testsRan ? safeJenkinsLink(execution.reportUrl, jenkinsBaseUrl) : null;
  if (report) links.push({ label: 'Open report', href: report });
  return links;
}

// What the script view offers: { showRun, runDisabled, showStop, note }. Run is for ADMIN and
// USER, in an active project, once Jenkins is set up. `note` says why Run is missing.
export function runControls({ role, projectStatus, jenkinsConfigured, execution }) {
  const canWrite = role === 'ADMIN' || role === 'USER';
  const active = projectStatus === 'ACTIVE';
  const busy = Boolean(execution) && !isFinal(execution.status);
  let note = '';
  if (canWrite && !active) note = 'This project is archived, so its scripts cannot be run.';
  else if (canWrite && !jenkinsConfigured) {
    note = 'Jenkins is not set up yet. An administrator must set it up under Settings → Jenkins.';
  }
  return {
    showRun: canWrite && active && Boolean(jenkinsConfigured),
    runDisabled: busy,
    showStop: canWrite && busy,
    note,
  };
}
```

- [ ] **Step 5: Add the client methods**

In `PlaywrightExtension/utils/platform-client.js`, add below `normalizeUrl`:

```js
// Ids go into URL paths, so anything but a positive whole number is refused before a request is made.
function positiveId(value, message) {
  if (!Number.isInteger(value) || value <= 0) throw new Error(message);
}
```

In `request`, replace the three lines that build and throw the error with:

```js
      const err = new Error(detail || data?.error?.message || `Platform request failed (${res.status})`);
      err.status = res.status;
      // Lets a caller react to one particular refusal, such as RUN_IN_PROGRESS.
      err.code = data?.error?.code ?? null;
      err.details = data?.error?.details ?? null;
      throw err;
```

In `saveScript`, replace the comment and the `if (!Number.isInteger(projectId) …` line with:

```js
      positiveId(projectId, 'Choose a project.');
```

Add these methods after `saveScript`, inside the returned object:

```js
    // A project's scripts, most recently updated first. `search` matches the name,
    // description, test scenario, and tags.
    async listScripts(projectId, search = '') {
      positiveId(projectId, 'Choose a project.');
      const platform = await signedIn();
      const query = new URLSearchParams({ pageSize: '100' });
      const text = String(search || '').trim();
      if (text) query.set('search', text);
      const { data } = await request(platform.url, `/projects/${projectId}/scripts?${query}`, { token: platform.token });
      return data.items;
    },

    // One script with its content.
    async getScript(scriptId) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/scripts/${scriptId}`, { token: platform.token });
      return data.script;
    },

    // { configured, baseUrl, username, jobName, hasToken }. The address and username are empty
    // unless the signed-in user is an ADMIN. The token is never returned.
    async getJenkinsSettings() {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/jenkins/settings', { token: platform.token });
      return data.settings;
    },

    // An empty token keeps the one the server already has; an empty job name means the default.
    async saveJenkinsSettings({ baseUrl, username, jobName = '', token = '' }) {
      const platform = await signedIn();
      const body = { baseUrl, username };
      if (jobName) body.jobName = jobName;
      if (token) body.token = token;
      const { data } = await request(platform.url, '/jenkins/settings', { method: 'PUT', token: platform.token, body });
      return data.settings;
    },

    // Tries a connection: { ok, version, pipelinePlugin, message }. Only the fields that were
    // filled in are sent; the server uses the saved value for the rest.
    async testJenkins({ baseUrl = '', username = '', token = '' } = {}) {
      const platform = await signedIn();
      const body = {};
      if (baseUrl) body.baseUrl = baseUrl;
      if (username) body.username = username;
      if (token) body.token = token;
      const { data } = await request(platform.url, '/jenkins/test', { method: 'POST', token: platform.token, body });
      return data;
    },

    // Creates the pipeline job in Jenkins, or updates its definition: { created, jobUrl }.
    async createJenkinsJob() {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/jenkins/job', { method: 'POST', token: platform.token });
      return data;
    },

    // Starts a run of the script's current version on Jenkins and returns the run.
    async runScript(scriptId) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/scripts/${scriptId}/run`, { method: 'POST', token: platform.token });
      return data.execution;
    },

    // Reads a run. The server brings an unfinished run up to date with Jenkins first.
    async getExecution(executionId) {
      positiveId(executionId, 'Choose a run.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/executions/${executionId}`, { token: platform.token });
      return data.execution;
    },

    async stopExecution(executionId) {
      positiveId(executionId, 'Choose a run.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/executions/${executionId}/stop`, {
        method: 'POST',
        token: platform.token,
      });
      return data.execution;
    },

    // A script's runs, newest first, as stored (Jenkins is not asked). `limit` is 1 to 50.
    async listExecutions(scriptId, limit = 10) {
      positiveId(scriptId, 'Choose a script.');
      const platform = await signedIn();
      const size = Number.isInteger(limit) && limit >= 1 && limit <= 50 ? limit : 10;
      const { data } = await request(platform.url, `/scripts/${scriptId}/executions?limit=${size}`, {
        token: platform.token,
      });
      return data.items;
    },
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test "PlaywrightExtension/tests/*.test.mjs"`
Expected: `tests 51`, `pass 51`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add PlaywrightExtension/utils/platform-client.js PlaywrightExtension/utils/execution-view.js PlaywrightExtension/tests
git commit -m "feat(extension): add platform client methods and view helpers for Jenkins runs"
```

---

### Task 8: Side panel — the Projects tab and the Jenkins settings block

**Files:**
- Modify: `PlaywrightExtension/sidepanel.html`
- Modify: `PlaywrightExtension/sidepanel.css`
- Modify: `PlaywrightExtension/sidepanel.js`

**Interfaces:**
- Consumes: every `PlatformClient` method and every `execution-view.js` export of Task 7; the existing `Storage`, `showToast`, `copyText`, and `setupPlatform` in `sidepanel.js`.
- Produces: `setupProjectsPanel()` and `setupJenkinsSettings()` in `sidepanel.js`; two document events — `platform-auth` (`detail.user` is the signed-in user or null), sent by `setupPlatform`, and `jenkins-settings` (`detail.settings`), sent after a save.

The side panel has no automated tests. Its decisions (which buttons show, which links are safe, how a status reads) are the tested functions of Task 7; this task only wires them to the page. The checks in Step 5 are a syntax check and a search for HTML-writing calls. The panel is checked by hand in Task 9.

All commands in this task run from the repo root.

- [ ] **Step 1: Add the markup**

In `PlaywrightExtension/sidepanel.html`, inside `<div class="nav-items">`, after the `orchestrator` button, add:

```html
      <div class="nav-divider"></div>
      <button class="nav-btn" data-panel="projects">🗂️<span class="tooltip">Projects</span></button>
```

Before the `<!-- SETTINGS -->` comment, add:

```html
      <!-- PROJECTS -->
      <div class="panel" id="panel-projects">
        <div class="panel-header">
          <span class="panel-icon">🗂️</span>
          <div><h2>Projects</h2><p>Stored scripts — run them on Jenkins</p></div>
          <span class="badge">Platform</span>
        </div>
        <div class="panel-body">
          <div id="projects-message" class="projects-message" role="status" style="display:none"></div>

          <div class="projects-view" id="projects-view-list" style="display:none">
            <div class="btn-row"><button class="btn btn-secondary btn-sm" id="projects-refresh">↻ Refresh</button></div>
            <div class="item-list" id="projects-list"></div>
          </div>

          <div class="projects-view" id="projects-view-scripts" style="display:none">
            <div class="btn-row">
              <button class="btn btn-secondary btn-sm" id="scripts-back">← Projects</button>
              <span class="crumb" id="scripts-project-name"></span>
            </div>
            <div class="form-group">
              <label for="scripts-search">Search scripts</label>
              <input type="text" id="scripts-search" maxlength="200" placeholder="Name, description, or tag">
            </div>
            <div class="item-list" id="scripts-list"></div>
          </div>

          <div class="projects-view" id="projects-view-script" style="display:none">
            <div class="btn-row"><button class="btn btn-secondary btn-sm" id="script-back">← Scripts</button></div>
            <div class="script-title" id="script-name"></div>
            <div class="script-meta" id="script-meta"></div>
            <div class="btn-row">
              <button class="btn btn-primary" id="script-run" style="display:none">▶ Run on Jenkins</button>
              <button class="btn btn-danger" id="script-stop" style="display:none">⏹ Stop</button>
            </div>
            <div id="script-run-note" class="projects-message" style="display:none"></div>
            <div class="run-card" id="run-card" style="display:none">
              <div class="run-card-head">
                <span id="run-status" class="run-status"></span>
                <span id="run-title"></span>
              </div>
              <div id="run-counts"></div>
              <div id="run-times"></div>
              <div id="run-error" class="run-error"></div>
              <div class="btn-row" id="run-links"></div>
            </div>
            <div class="output-section">
              <div class="output-header"><span>Recent runs</span></div>
              <div class="item-list" id="run-history"></div>
            </div>
            <div class="output-section">
              <div class="output-header"><span>Script</span>
                <div class="output-header-btns"><button class="btn btn-icon" id="script-copy">📋 Copy</button></div>
              </div>
              <div class="output-content" id="script-code"></div>
            </div>
          </div>
        </div>
      </div>

```

After the closing `</div>` of `<div class="settings-section" id="platform-section">`, add:

```html
          <div class="settings-section" id="jenkins-section" style="display:none">
            <h3>Jenkins</h3>
            <div id="jenkins-summary" style="font-size:12px;color:var(--text2)"></div>
            <div id="jenkins-admin" style="display:none">
              <div class="form-group" style="margin-top:8px">
                <label for="jenkins-url">Jenkins URL</label>
                <input type="text" id="jenkins-url" maxlength="300" placeholder="http://localhost:8080">
              </div>
              <div class="form-group" style="margin-top:8px">
                <label for="jenkins-username">Username</label>
                <input type="text" id="jenkins-username" maxlength="100" autocomplete="off">
              </div>
              <div class="form-group" style="margin-top:8px">
                <label for="jenkins-token">API Token</label>
                <input type="password" id="jenkins-token" maxlength="200" autocomplete="off">
              </div>
              <div class="form-group" style="margin-top:8px">
                <label for="jenkins-job">Job Name</label>
                <input type="text" id="jenkins-job" maxlength="100" placeholder="playwright-platform-run">
              </div>
              <div class="btn-row" style="margin-top:10px">
                <button class="btn btn-secondary" id="jenkins-test">🧪 Test Connection</button>
                <button class="btn btn-primary" id="jenkins-save">💾 Save</button>
                <button class="btn btn-secondary" id="jenkins-create-job">🛠 Create Job</button>
              </div>
              <div id="jenkins-status" role="status" style="font-size:12px;color:var(--text2);padding:6px 0 0"></div>
            </div>
          </div>
```

- [ ] **Step 2: Add the styles**

In `PlaywrightExtension/sidepanel.css`, add `#panel-projects` to the per-agent hues, after the `#panel-settings` line:

```css
#panel-projects     { --panel-hue: #a5d6ff; }
```

Add before the `/* ---- COPY FLASH ---- */` comment:

```css
/* ---- PROJECTS ---- */
.projects-view { display: flex; flex-direction: column; gap: 10px; }
.projects-message { font-size: 12px; color: var(--text2); }
.crumb { font-size: 12px; font-weight: 600; color: var(--text); align-self: center; word-break: break-word; }
.item-list { display: flex; flex-direction: column; gap: 4px; }
.item {
  display: flex; flex-direction: column; align-items: flex-start; gap: 2px; width: 100%; text-align: left;
  background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius);
  padding: 8px 10px; cursor: pointer; color: var(--text); font-family: var(--font); transition: border-color 0.15s;
}
.item:hover, .item.selected { border-color: var(--accent); }
.item:focus-visible { outline: 2px solid var(--accent2); outline-offset: 1px; }
.item-title { font-size: 12px; font-weight: 600; word-break: break-word; }
.item-sub { font-size: 11px; color: var(--text2); word-break: break-word; }
.item-empty { font-size: 11px; color: var(--text3); padding: 4px; }
.script-title { font-size: 14px; font-weight: 600; word-break: break-word; }
.script-meta { font-size: 11px; color: var(--text2); word-break: break-word; }
.run-card {
  display: flex; flex-direction: column; gap: 6px; font-size: 12px;
  background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px;
}
.run-card-head { display: flex; align-items: center; gap: 8px; font-weight: 600; }
.run-status {
  font-size: 10px; font-weight: 700; padding: 2px 8px; border-radius: 10px;
  text-transform: uppercase; letter-spacing: 0.4px; border: 1px solid currentColor;
}
.run-wait { color: var(--text2); }
.run-run { color: var(--warn); }
.run-ok { color: var(--success); }
.run-bad { color: var(--danger); }
.run-off { color: var(--text3); }
.run-error {
  color: var(--danger); font-family: var(--mono); font-size: 11px;
  white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow-y: auto;
}
.run-error:empty, #run-counts:empty, #run-times:empty, #run-links:empty { display: none; }
a.btn { text-decoration: none; }
```

- [ ] **Step 3: Send the sign-in state, and call the two new set-up functions**

In `PlaywrightExtension/sidepanel.js`, add to the imports, after the `platform-client.js` import:

```js
import { countsText, durationText, isFinal, runControls, runLinks, runSummary, statusView } from './utils/execution-view.js';
```

In `init()`, add two lines directly above `setupPlatform();`, so both listen before the first sign-in state is sent:

```js
  setupProjectsPanel();
  setupJenkinsSettings();
```

In `setupPlatform()`, add as the last statement inside `render`, after the `status.textContent = …` line:

```js
    // The Projects tab and the Jenkins block follow the sign-in state.
    document.dispatchEvent(new CustomEvent('platform-auth', { detail: { user: user || null } }));
```

- [ ] **Step 4: Write the two set-up functions**

In `PlaywrightExtension/sidepanel.js`, add both functions directly above the `// ---- 11. SETTINGS ----` comment:

```js
// Projects tab: browse the platform's projects and scripts, and run a stored script on Jenkins.
// Every value shown here came from the server, so it is written with textContent and built
// with DOM methods, never parsed as HTML.
function setupProjectsPanel() {
  const $ = (id) => document.getElementById(id);
  const message = $('projects-message');
  const views = { list: $('projects-view-list'), scripts: $('projects-view-scripts'), script: $('projects-view-script') };
  const projectList = $('projects-list');
  const projectName = $('scripts-project-name');
  const searchInput = $('scripts-search');
  const scriptList = $('scripts-list');
  const scriptName = $('script-name');
  const scriptMeta = $('script-meta');
  const scriptCode = $('script-code');
  const runBtn = $('script-run');
  const stopBtn = $('script-stop');
  const runNote = $('script-run-note');
  const card = $('run-card');
  const runStatus = $('run-status');
  const runTitle = $('run-title');
  const runCounts = $('run-counts');
  const runTimes = $('run-times');
  const runError = $('run-error');
  const runLinksEl = $('run-links');
  const runHistory = $('run-history');
  const required = [
    message, views.list, views.scripts, views.script, projectList, projectName, searchInput, scriptList,
    scriptName, scriptMeta, scriptCode, runBtn, stopBtn, runNote, card, runStatus, runTitle, runCounts,
    runTimes, runError, runLinksEl, runHistory,
  ];
  if (required.some((el) => !el)) return;

  const POLL_MS = 3000;
  const SEARCH_DELAY_MS = 300;
  const EXPIRED = 'Platform session expired — sign in again under Settings → Platform.';

  const state = {
    user: null,       // the signed-in platform user
    jenkins: null,    // the Jenkins settings as the server reports them
    project: null,    // the open project
    script: null,     // the open script, with its content
    execution: null,  // the run shown in the status card
    runs: [],         // the open script's recent runs
    turn: 0,          // goes up on every navigation, so an answer that arrives late is dropped
    pollTimer: null,
    searchTimer: null,
  };

  const show = (el, visible) => { el.style.display = visible ? '' : 'none'; };
  const say = (text) => { message.textContent = text; show(message, Boolean(text)); };
  const fail = (err) => say(err.status === 401 ? EXPIRED : `❌ ${err.message}`);
  const showView = (name) => {
    for (const [key, el] of Object.entries(views)) show(el, key === name);
  };
  const scriptDetail = (script) =>
    [`v${script.version}`, script.language, ...script.tags.map((tag) => `#${tag}`)].join(' · ');

  // One row of a list: a title and a line of detail.
  function item(title, detail, onOpen) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item';
    const top = document.createElement('span');
    top.className = 'item-title';
    top.textContent = title;
    const bottom = document.createElement('span');
    bottom.className = 'item-sub';
    bottom.textContent = detail;
    row.append(top, bottom);
    row.addEventListener('click', onOpen);
    return row;
  }

  function emptyLine(text) {
    const line = document.createElement('div');
    line.className = 'item-empty';
    line.textContent = text;
    return line;
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
  }

  // Asks again in 3 seconds while the shown run is unfinished. A chain of timeouts, not an
  // interval, so a slow answer never overlaps the next request.
  function keepWatching() {
    stopPolling();
    const watched = state.execution;
    if (!watched || isFinal(watched.status)) return;
    const turn = state.turn;
    state.pollTimer = setTimeout(async () => {
      try {
        const fresh = await PlatformClient.getExecution(watched.id);
        if (turn !== state.turn || state.execution?.id !== watched.id) return;
        say('');
        renderRun(fresh);
      } catch (err) {
        if (turn !== state.turn) return;
        if (err.status === 401) { fail(err); return; }
        // One failed poll does not end the watch: the last known state stays on screen.
        say(`⚠️ ${err.message}`);
      }
      keepWatching();
    }, POLL_MS);
  }

  function renderControls() {
    const controls = runControls({
      role: state.user?.role,
      projectStatus: state.script?.projectStatus,
      jenkinsConfigured: Boolean(state.jenkins?.configured),
      execution: state.execution,
    });
    show(runBtn, controls.showRun);
    runBtn.disabled = controls.runDisabled;
    show(stopBtn, controls.showStop);
    runNote.textContent = controls.note;
    show(runNote, Boolean(controls.note));
  }

  function renderRuns() {
    if (state.runs.length === 0) {
      runHistory.replaceChildren(emptyLine('No runs yet.'));
      return;
    }
    runHistory.replaceChildren(...state.runs.map((execution) => {
      const row = item(runSummary(execution), new Date(execution.createdAt).toLocaleString(), () => selectRun(execution.id));
      if (state.execution?.id === execution.id) row.classList.add('selected');
      return row;
    }));
  }

  // Shows a run in the status card, or hides the card when there is none.
  function renderRun(execution) {
    state.execution = execution;
    show(card, Boolean(execution));
    if (execution) {
      // The list shows the same run, so it must not lag behind the card.
      state.runs = state.runs.map((run) => (run.id === execution.id ? execution : run));
      const status = statusView(execution.status);
      runStatus.className = status.className;
      runStatus.textContent = status.label;
      const build = execution.buildNumber ? ` · build ${execution.buildNumber}` : '';
      runTitle.textContent = `Run #${execution.id} · v${execution.scriptVersion}${build}`;
      runCounts.textContent = countsText(execution);
      const duration = durationText(execution.durationMs);
      runTimes.textContent = [
        execution.triggeredBy ? `Started by ${execution.triggeredBy}` : '',
        duration ? `Took ${duration}` : '',
      ].filter(Boolean).join(' · ');
      runError.textContent = execution.errorMessage || '';
      runLinksEl.replaceChildren(...runLinks(execution, state.jenkins?.baseUrl || '').map(({ label, href }) => {
        const link = document.createElement('a');
        link.className = 'btn btn-secondary btn-sm';
        link.textContent = label;
        link.href = href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
      }));
    }
    renderControls();
    renderRuns();
  }

  async function loadRuns() {
    if (!state.script) return;
    const turn = state.turn;
    try {
      const runs = await PlatformClient.listExecutions(state.script.id, 10);
      if (turn !== state.turn) return;
      state.runs = runs;
      renderRuns();
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  // Shows one run in the card. Reading it makes the server bring it up to date with Jenkins.
  async function selectRun(id) {
    const turn = state.turn;
    try {
      const execution = await PlatformClient.getExecution(id);
      if (turn !== state.turn) return;
      renderRun(execution);
      keepWatching();
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  async function openList() {
    const turn = ++state.turn;
    stopPolling();
    state.project = null;
    state.script = null;
    state.execution = null;
    if (!state.user) {
      showView(null);
      say('Sign in under Settings → Platform to see your projects.');
      return;
    }
    showView('list');
    say('Loading…');
    try {
      const projects = await PlatformClient.listProjects();
      if (turn !== state.turn) return;
      say(projects.length === 0 ? 'No projects yet. An administrator creates them in the platform web app.' : '');
      projectList.replaceChildren(...projects.map((project) => item(
        project.name,
        `${project.scriptCount} ${project.scriptCount === 1 ? 'script' : 'scripts'}`,
        () => openProject(project),
      )));
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  function openProject(project) {
    state.project = project;
    projectName.textContent = project.name;
    searchInput.value = '';
    loadScripts();
  }

  async function loadScripts() {
    if (!state.project) return;
    const turn = ++state.turn;
    stopPolling();
    state.script = null;
    state.execution = null;
    showView('scripts');
    say('Loading…');
    const search = searchInput.value;
    try {
      const scripts = await PlatformClient.listScripts(state.project.id, search);
      if (turn !== state.turn) return;
      const none = search.trim()
        ? 'No scripts match the search.'
        : 'This project has no scripts yet. Save one from the Generator or Recorder.';
      say(scripts.length === 0 ? none : '');
      scriptList.replaceChildren(...scripts.map((script) => item(script.name, scriptDetail(script), () => openScript(script.id))));
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  async function openScript(scriptId) {
    const turn = ++state.turn;
    stopPolling();
    clearTimeout(state.searchTimer);
    state.script = null;
    state.execution = null;
    state.runs = [];
    showView(null);
    say('Loading…');
    try {
      const [script, jenkins, runs] = await Promise.all([
        PlatformClient.getScript(scriptId),
        PlatformClient.getJenkinsSettings(),
        PlatformClient.listExecutions(scriptId, 10),
      ]);
      if (turn !== state.turn) return;
      state.script = script;
      state.jenkins = jenkins;
      state.runs = runs;
      scriptName.textContent = script.name;
      scriptMeta.textContent = scriptDetail(script);
      scriptCode.textContent = script.content;
      say('');
      showView('script');
      renderRun(null);
      // A run that is still going is shown again, so closing the panel never loses it.
      const unfinished = runs.find((execution) => !isFinal(execution.status));
      if (unfinished) await selectRun(unfinished.id);
    } catch (err) {
      if (turn !== state.turn) return;
      showView('scripts');
      fail(err);
    }
  }

  runBtn.addEventListener('click', async () => {
    if (!state.script) return;
    const turn = state.turn;
    runBtn.disabled = true;
    say('Starting the run…');
    try {
      const execution = await PlatformClient.runScript(state.script.id);
      if (turn !== state.turn) return;
      say('');
      state.runs = [execution, ...state.runs].slice(0, 10);
      renderRun(execution);
      keepWatching();
    } catch (err) {
      if (turn !== state.turn) return;
      fail(err);
      // A start that failed is kept in history, and a refusal may name the run in progress.
      await loadRuns();
      if (turn !== state.turn) return;
      const inProgress = err.code === 'RUN_IN_PROGRESS' ? err.details?.executionId : null;
      if (Number.isInteger(inProgress)) await selectRun(inProgress);
      else renderControls();
    }
  });

  stopBtn.addEventListener('click', async () => {
    const watched = state.execution;
    if (!watched) return;
    const turn = state.turn;
    stopBtn.disabled = true;
    try {
      const execution = await PlatformClient.stopExecution(watched.id);
      if (turn !== state.turn) return;
      say('');
      renderRun(execution);
      keepWatching();
    } catch (err) {
      if (turn !== state.turn) return;
      fail(err);
      // 409: it had already finished. Read it again to show how.
      if (err.status === 409) await selectRun(watched.id);
    } finally {
      stopBtn.disabled = false;
    }
  });

  $('projects-refresh')?.addEventListener('click', () => openList());
  $('scripts-back')?.addEventListener('click', () => openList());
  $('script-back')?.addEventListener('click', () => loadScripts());
  $('script-copy')?.addEventListener('click', () => copyText(scriptCode.textContent || ''));
  searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadScripts, SEARCH_DELAY_MS);
  });

  // Sign-in, sign-out, and a changed role all start again from the project list.
  document.addEventListener('platform-auth', (event) => {
    const user = event.detail.user;
    const same = (state.user?.id ?? null) === (user?.id ?? null) && (state.user?.role ?? null) === (user?.role ?? null);
    const first = state.turn === 0;
    state.user = user;
    if (first || !same) openList();
  });

  // Jenkins was set up or changed under Settings: Run may now be available.
  document.addEventListener('jenkins-settings', (event) => {
    state.jenkins = event.detail.settings;
    if (state.script) renderRun(state.execution);
  });

  // Leaving the tab stops the polling; coming back picks the watch up again.
  document.querySelectorAll('.nav-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.getAttribute('data-panel') !== 'projects') { stopPolling(); return; }
      if (state.execution && !isFinal(state.execution.status)) selectRun(state.execution.id);
    });
  });
}

// Settings → Jenkins. Shown once signed in to the platform. An ADMIN gets the form; other
// roles only see whether Jenkins is set up. The API token goes to the platform server, which
// stores it encrypted; the extension never keeps it.
function setupJenkinsSettings() {
  const $ = (id) => document.getElementById(id);
  const section = $('jenkins-section');
  const summary = $('jenkins-summary');
  const adminForm = $('jenkins-admin');
  const urlInput = $('jenkins-url');
  const usernameInput = $('jenkins-username');
  const tokenInput = $('jenkins-token');
  const jobInput = $('jenkins-job');
  const status = $('jenkins-status');
  const testBtn = $('jenkins-test');
  const saveBtn = $('jenkins-save');
  const jobBtn = $('jenkins-create-job');
  const required = [section, summary, adminForm, urlInput, usernameInput, tokenInput, jobInput, status, testBtn, saveBtn, jobBtn];
  if (required.some((el) => !el)) return;

  let shownFor = null;  // id and role of the user the block was last drawn for

  // textContent and .value only: these values come from the server.
  const fill = (settings) => {
    summary.textContent = settings.configured ? '✅ Jenkins is set up.' : 'Jenkins is not set up yet.';
    urlInput.value = settings.baseUrl;
    usernameInput.value = settings.username;
    jobInput.value = settings.jobName;
    tokenInput.value = '';
    tokenInput.placeholder = settings.hasToken ? 'saved — leave empty to keep it' : '';
    jobBtn.disabled = !settings.configured;
  };

  async function load(user) {
    section.style.display = user ? '' : 'none';
    adminForm.style.display = user?.role === 'ADMIN' ? '' : 'none';
    status.textContent = '';
    if (!user) return;
    summary.textContent = 'Loading…';
    try {
      fill(await PlatformClient.getJenkinsSettings());
    } catch (err) {
      summary.textContent = `⚠️ ${err.message}`;
    }
  }

  document.addEventListener('platform-auth', (event) => {
    const user = event.detail.user;
    const key = user ? `${user.id}:${user.role}` : '';
    if (key === shownFor) return;
    shownFor = key;
    load(user);
  });

  const form = () => ({
    baseUrl: urlInput.value.trim(),
    username: usernameInput.value.trim(),
    jobName: jobInput.value.trim(),
    token: tokenInput.value,
  });

  // Runs one button's action and puts its result, or the reason it failed, in the status line.
  async function act(button, busyText, work) {
    button.disabled = true;
    status.textContent = busyText;
    try {
      status.textContent = await work();
    } catch (err) {
      status.textContent = `❌ ${err.message}`;
    } finally {
      button.disabled = false;
    }
  }

  testBtn.addEventListener('click', () => act(testBtn, 'Testing…', async () => {
    const result = await PlatformClient.testJenkins(form());
    return `${result.ok ? '✅' : '❌'} ${result.message}`;
  }));

  saveBtn.addEventListener('click', () => act(saveBtn, 'Saving…', async () => {
    const settings = await PlatformClient.saveJenkinsSettings(form());
    fill(settings);
    document.dispatchEvent(new CustomEvent('jenkins-settings', { detail: { settings } }));
    return '✅ Saved. Press Create Job if the job is not in Jenkins yet.';
  }));

  jobBtn.addEventListener('click', () => act(jobBtn, 'Creating the job…', async () => {
    const result = await PlatformClient.createJenkinsJob();
    return `✅ Job ${result.created ? 'created' : 'updated'}: ${result.jobUrl}`;
  }));
}

```

- [ ] **Step 5: Check the syntax, the HTML-writing calls, and the ids**

Run: `cp PlaywrightExtension/sidepanel.js PlaywrightExtension/.sidepanel-check.mjs && node --check PlaywrightExtension/.sidepanel-check.mjs; rm -f PlaywrightExtension/.sidepanel-check.mjs`
Expected: no output. (The copy has the `.mjs` ending so Node parses it as a module.)

Run: `sed -n '/^function setupProjectsPanel/,/^\/\/ ---- 11\. SETTINGS ----/p' PlaywrightExtension/sidepanel.js | grep -nE "innerHTML|outerHTML|insertAdjacentHTML|document\.write"`
Expected: no output — the two new functions never write HTML.

Run this to confirm every id the two functions look up exists in the page:

```bash
sed -n '/^function setupProjectsPanel/,/^\/\/ ---- 11\. SETTINGS ----/p' PlaywrightExtension/sidepanel.js \
  | grep -oE "[$][(]'[a-z-]+'[)]" | sed -E "s/.*'([a-z-]+)'.*/\1/" | sort -u \
  | while read id; do grep -q "id=\"$id\"" PlaywrightExtension/sidepanel.html || echo "missing id: $id"; done
```

Expected: no output.

Run: `node --test "PlaywrightExtension/tests/*.test.mjs"`
Expected: `tests 51`, `pass 51`, `fail 0`.

- [ ] **Step 6: Commit**

```bash
git add PlaywrightExtension/sidepanel.html PlaywrightExtension/sidepanel.css PlaywrightExtension/sidepanel.js
git commit -m "feat(extension): browse projects and run stored scripts on Jenkins from the side panel"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `PlaywrightPlatform/README.md`
- Modify: `PlaywrightPlatform/.env.example`
- Modify: `CLAUDE.md` (repo root)

**Interfaces:**
- Consumes: everything built in Tasks 1 to 8. Produces nothing later tasks use.

- [ ] **Step 1: Update `PlaywrightPlatform/README.md`**

Replace the first paragraph (under `# Playwright Platform`) with:

```markdown
Backend, database, and web app for Playwright AI Studio: projects, Playwright scripts with
version history, runs of those scripts on Jenkins, users, roles, and audit logging today;
skills, reports, and healing in later releases. The database already contains the tables
for all of those.
```

In the **Architecture** block, replace the diagram with:

```
web/ (React + Vite)  ──HTTP /api──▶  server/ (Fastify)  ──Knex──▶  PostgreSQL (Docker)
Chrome extension     ──HTTP /api──▶  routes → services → repositories
                                              │
                                              └──HTTP──▶  Jenkins  ──HTTP /api (run token)──▶  server/
```

and add this bullet to the list under it:

```markdown
- **jenkins/jenkins-client.ts** is the only code that calls Jenkins. The extension never does.
```

Add three rows to the table under **Roles**:

```markdown
| Browse projects and scripts, and see runs, in the extension | yes | yes | yes |
| Run a script on Jenkins, and stop a run | yes | yes | no |
| Set up Jenkins (extension: Settings → Jenkins) | yes | no | no |
```

Under **Scripts**, replace the last bullet and the sentence after the list:

```markdown
- **Run** happens in the extension's **Projects** tab (see "Run a script on Jenkins" below).
  In the web app, **Run** and **Heal** are still shown disabled.

The server stores and returns script content as text. It never executes it; a run hands the
script to a Jenkins build.
```

Add this section after **Connect the extension**:

```markdown
## Run a script on Jenkins

Runs are started, watched, and stopped in the extension's side panel. The extension talks
only to this server; the server talks to Jenkins.

**What Jenkins needs**

- The **Pipeline** plugin (`workflow-aggregator`). Test Connection reports whether it is there.
- A **Windows** agent with **Node.js 18 or newer** on its PATH. The job uses `bat` steps.
- Network access from the agent to this server, and to npm and the Playwright browser
  download.
- A Jenkins user and an **API token** for it: in Jenkins, open your user menu → **Security**
  (older versions: **Configure**) → **API Token** → **Add new Token**. The user needs
  permission to create jobs, build, and cancel builds.

**Set it up once (ADMIN)**

1. In the side panel open **Settings** and sign in under **Platform**.
2. Under **Jenkins** enter the Jenkins URL, the username, and the API token.
3. Press **Test Connection**, then **Save**, then **Create Job**. This creates the pipeline
   job `playwright-platform-run` in Jenkins; pressing it again updates the job's definition.

**Run (ADMIN or USER)**

1. Open the **Projects** tab, a project, and a script.
2. Press **Run on Jenkins**. The card shows Queued, Running, and then Passed or Failed with
   the test counts, the duration, and links to the Jenkins build and its Playwright report.
3. **Stop** aborts a queued or running build. **Recent runs** lists the script's last 10 runs.

**How it works**

- Each run is a row in `test_executions` with the script version that was current when Run
  was pressed. One script can have one unfinished run at a time.
- The build downloads that version from this server with a one-time run token, runs it with
  Playwright on Chromium, and posts the test counts back. The token works only for that run
  and only until the run ends.
- Status comes from Jenkins, and is read whenever someone looks at the run. A run nobody
  looks at keeps its last known status until it is opened, or until Run is pressed again.
- A passed or failed run sets the script's state, which the project overview counts.

**The address Jenkins calls back**

The build reaches this server at `PLATFORM_PUBLIC_URL`, by default
`http://127.0.0.1:<APP_PORT>`. That works when Jenkins runs on the same machine. For Jenkins
on another machine, set `APP_HOST=0.0.0.0` and `PLATFORM_PUBLIC_URL` to an address that
machine can reach, and put the server behind HTTPS.

**Security**

- The API token is stored encrypted with `SECRETS_ENCRYPTION_KEY` and is never returned by
  the API, logged, or written to the audit log. If that key changes, enter the token again.
- A stored script is code. Anyone with the USER role can run code on the Jenkins agent by
  saving a script and running it. Give that role only to people you would give a shell there.

**Limits**

Windows agents only; one script per run; Chromium only. Every build installs its packages
and the browser afresh, so a run takes a few minutes. Per-test results, screenshots, and
traces come with the reports release.
```

Under **Tests**, replace the sentence after the code block with:

```markdown
Both suites rebuild `playwright_db_test`. Do not run them at the same time. The server tests
start their own local stand-in for Jenkins, so no Jenkins is needed to run them.
```

Add these rows to the table under **API**:

```markdown
| GET | `/jenkins/settings` | signed in (address and username: ADMIN only) |
| PUT | `/jenkins/settings` | ADMIN |
| POST | `/jenkins/test` | ADMIN |
| POST | `/jenkins/job` | ADMIN |
| POST | `/scripts/:id/run` | ADMIN, USER |
| GET | `/scripts/:id/executions` | signed in (optional `?limit=`, 1 to 50) |
| GET | `/executions/:id` | signed in |
| POST | `/executions/:id/stop` | ADMIN, USER |
| GET | `/executions/:id/script` | run token (the Jenkins build) |
| POST | `/executions/:id/result` | run token (the Jenkins build) |
```

Add these rows to the table under **Troubleshooting**:

```markdown
| Run answers `JENKINS_NOT_CONFIGURED` | Nobody has saved the Jenkins connection. An ADMIN opens the extension's Settings → Jenkins. |
| Run answers `JENKINS_REJECTED` | The username or API token is wrong, the Jenkins user lacks permission, or the job does not exist. Press Test Connection, then Create Job. |
| Run answers `JENKINS_UNREACHABLE` | Jenkins is not running or the URL is wrong. Open the Jenkins URL in a browser. |
| A run ends as ERROR "Jenkins did not start the build" | No agent took the build within 10 minutes. Check Build Executor Status in Jenkins. |
| A run ends as ERROR "The build failed before the tests ran" | Open the build's console log. Usual causes: Node.js is not on the agent's PATH, the agent cannot reach `PLATFORM_PUBLIC_URL`, or the package or browser download is blocked. |
| A run stays RUNNING after the build ended | Nobody has looked at it since. Open the script in the Projects tab; the run is read again from Jenkins. |
| Run or Test Connection answers `INTERNAL_ERROR` after `SECRETS_ENCRYPTION_KEY` changed | The stored Jenkins token can no longer be read. Enter the API token again under Settings → Jenkins and press Save. |
```

- [ ] **Step 2: Update `PlaywrightPlatform/.env.example`**

Replace these four lines:

```
# Jenkins (not read until the Jenkins sub-project)
JENKINS_URL=http://localhost:8080
JENKINS_USERNAME=
JENKINS_API_TOKEN=
```

with:

```
# Jenkins: the URL, username, and API token are entered in the extension
# (Settings → Jenkins) and stored in the database; the token is encrypted with
# SECRETS_ENCRYPTION_KEY. Only PLATFORM_PUBLIC_URL (below) is read from this file.
```

- [ ] **Step 3: Update `CLAUDE.md` in the repo root**

In the **Repository Layout** table, replace the `PlaywrightPlatform/` row with:

```markdown
| `PlaywrightPlatform/` | Test-management backend (Fastify + PostgreSQL) and React web app; the extension signs in to it over HTTP, and it runs stored scripts on Jenkins | Node + Docker |
```

Under **Commands → PlaywrightPlatform**, replace the sentence that starts "Layering is strict" with:

```markdown
Layering is strict: `routes/` → `services/` → `repositories/`; only repositories query the database; only `web/src/api/` calls `fetch` in the web app; only `server/src/jenkins/jenkins-client.ts` calls Jenkins. Server tests use a local stand-in for Jenkins (`server/test/jenkins-stub.ts`). See `PlaywrightPlatform/README.md`.
```

Under **Architecture → Extension**, replace the **Platform link** bullet with:

```markdown
- **Platform link** (`utils/platform-client.js`, `utils/code-extract.js`, `utils/execution-view.js`): optional sign-in to the Playwright Platform (Settings → Platform, `setupPlatform()` in `sidepanel.js`), the "💾 Save to Project" buttons in the Generator, Recorder, and Orchestrator panels (`setupSaveToProject()`), the **Projects** tab that browses stored scripts and runs them on Jenkins (`setupProjectsPanel()`), and the Jenkins connection form under Settings (`setupJenkinsSettings()`, ADMIN only). The extension never calls Jenkins: every request goes to the platform API through `platform-client.js`. The three `utils/` modules are free of DOM and `chrome.*` calls and are tested with `node --test "PlaywrightExtension/tests/*.test.mjs"`; decisions such as which buttons show and which links are safe live there, not in `sidepanel.js`. Text that came from the server is always written with `textContent`. The extension works unchanged when not signed in.
```

Under **Cross-project Conventions**, add:

```markdown
- Platform API changes must be kept in sync on both sides: the routes in `PlaywrightPlatform/server/src/routes/` and `PlaywrightExtension/utils/platform-client.js`.
```

- [ ] **Step 4: Run every automated check**

Stop any Vite server on port 5174 first; the web tests need that port.

Run (in `PlaywrightPlatform/`): `npm run typecheck`, then `npm test`, then `npm run build`, then `npm run test:e2e`
Expected: typecheck clean; server suite green with 258 tests (193 before this plan, 65 added); build succeeds; 25 web tests pass (the web app is unchanged, this proves the server changes did not break it).

Run (from the repo root): `node --test "PlaywrightExtension/tests/*.test.mjs"`
Expected: `tests 51`, `pass 51`, `fail 0`.

Run (from the repo root): `git diff --stat 5c7d908..HEAD -- PlaywrightPlatform/web` and `git status --short PlaywrightPlatform/web`
Expected: no output from either — the web app was not changed since the branch was cut (`5c7d908`).

- [ ] **Step 5: Commit the documentation**

```bash
git add PlaywrightPlatform/README.md PlaywrightPlatform/.env.example CLAUDE.md
git commit -m "docs: document running stored scripts on Jenkins"
```

- [ ] **Step 6: Check against the real Jenkins (needs the owner)**

This step cannot be done by an agent alone: the Jenkins username and API token are typed by the owner into the side panel. Until it is done, report the feature as **not verified against a real Jenkins**.

Before starting, confirm on the Jenkins machine: `node --version` in a new terminal prints 18 or newer, and **Manage Jenkins → Plugins → Installed** lists **Pipeline**.

With the platform running (`npm run dev:server`) and the extension reloaded in `chrome://extensions`:

1. Settings → Platform: sign in as the ADMIN.
2. Settings → Jenkins: enter `http://localhost:7070`, the Jenkins username, and the API token. **Test Connection** shows "Connected to Jenkins 2.555.2." **Save**, then **Create Job**. The job `playwright-platform-run` appears in Jenkins.
3. Projects → a project → a script that passes → **Run on Jenkins**. The card goes Queued → Running → Passed, with counts and a duration. **Open in Jenkins** and **Open report** open the build and its Playwright report.
4. Run a script with a failing assertion. The card ends Failed with the counts and the first failure message.
5. Start a run and press **Stop** while it is Running. The card ends Aborted, and the build is aborted in Jenkins.
6. In the build's console log in Jenkins, search for the text `Bearer`. It must not appear with a token after it.
7. In the web app, the project's Overview counts the passed and the failed script.

If a run ends as ERROR, open the build's console log; the **Troubleshooting** table in the README lists the usual causes.

- [ ] **Step 7: Manual checklist in Chrome (needs a person)**

Record each line as pass or fail. Until it is run, report the side panel as **not verified in Chrome**.

1. Not signed in: the Projects tab says to sign in under Settings → Platform, and Settings shows no Jenkins block.
2. Signed in as ADMIN: the Jenkins block shows the form. After a save, the token field is empty and its placeholder says it is saved.
3. Projects tab: the project list shows names and script counts. Opening a project lists its scripts; typing in the search box narrows the list; **← Projects** and **← Scripts** go back.
4. A script shows its name, version, language, tags, and code. **Copy** copies the code.
5. Signed in as USER: Run works; the Jenkins block shows only whether Jenkins is set up.
6. Signed in as VIEWER: no Run and no Stop button; Recent runs and the status card are visible.
7. Start a run, close the side panel, and reopen it. Opening the script shows the run again and it keeps updating. (Review Focus 1.)
8. With a run in progress, press Run from a second browser profile signed in as another user. It shows the run in progress instead of starting a second one. (Review Focus 3.)
9. Stop the platform server during a run. The card keeps its last state and a warning line appears; start the server again and the card carries on. 
10. In the web app, name a script `<img src=x onerror=alert(1)>`. In the Projects tab the name shows as text and no alert appears. (Review Focus 5.)
11. Sign out: the Projects tab goes back to the sign-in line and the Jenkins block disappears.
12. Save to Project, the Generator, the Recorder, and **Run via Playwright** (Bridge) work as before.

---
