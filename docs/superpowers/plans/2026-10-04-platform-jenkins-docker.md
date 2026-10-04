# Platform Jenkins Docker Execution — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run each Jenkins build's `npx playwright test` inside the official Playwright Docker image (`mcr.microsoft.com/playwright`) on the user's own machine, changing only *where* the tests execute.

**Architecture:** The generated pipeline gains a `Preflight` stage (Docker + image check), keeps `Prepare` (agent downloads the script), and replaces the Windows `Install`/`Test` steps with `docker run` calls of the image. The report script writes `result-body.json` instead of POSTing it; the agent POSTs that file. A new server setting `PLAYWRIGHT_DOCKER_IMAGE` is passed to Jenkins as a `PLAYWRIGHT_IMAGE` parameter and used to pin `@playwright/test`.

**Tech Stack:** TypeScript, Fastify 5, Vitest (server); Jenkins Pipeline with `isUnix()` sh/bat branches.

**Spec:** `docs/superpowers/specs/2026-10-04-platform-jenkins-docker-design.md`

## Global Constraints

- Branch `feat/platform-jenkins-docker`, cut from `feat/platform-jenkins` (= `main`, commit `41758e7`). Work from the repo root `PlaywrightExt/` unless a step says otherwise.
- Work in the existing checkout; do not create a new worktree or clone. This machine has `core.autocrlf=true` and no `.gitattributes`, so a fresh checkout gives the test fixtures CRLF line endings and the script-content tests fail. Switch branches in place; the files that differ between branches are re-checked out but none of them carry the script-content fixtures.
- The current checkout is on `fix/jenkins-followups` with uncommitted changes. Preserve them: `git stash push` (tracked changes only) before switching branches; the untracked files stay in place. The stash is restored later on `fix/jenkins-followups`.
- No database migration. No extension, web, Bridge, or Orchestrator change. No new endpoint.
- Layering unchanged: `routes/` → `services/` → `repositories/`; only `src/jenkins/jenkins-client.ts` calls Jenkins.
- Status mapping is unchanged: `SUCCESS`→`PASSED`, `UNSTABLE`→`FAILED`, `FAILURE`→(`total>0` ? `FAILED` : `ERROR` "The build failed before the tests ran…"), `ABORTED`→`ABORTED`. The only `ExecutionService.finish` change is to keep a build-reported error message on the `FAILURE`+no-tests `ERROR`.
- The image value must never contain spaces or shell metacharacters; it is validated in config and derived into a version in code.
- Server commands run in `PlaywrightPlatform/`: `npm test -w server -- <file>` for one file, `npm test` for all, `npm run typecheck`. PostgreSQL must be up (`npm run db:up`).
- Commit after each task, with the `Co-authored-by: CommandCodeBot <noreply@commandcode.ai>` trailer.

## Decisions Made in This Plan

The spec resolves these; repeated here so the tasks are unambiguous.

1. **Image:** `mcr.microsoft.com/playwright:v1.63.0-noble` (current stable, verified 2026-10-04). `playwrightVersionFromTag` extracts `1.63.0`.
2. **Install and Test are two `docker run` calls**, so a failed `npm install` is `FAILURE` while a non-zero `npx playwright test` is `UNSTABLE`.
3. **The report script runs inside the Test container** and writes `result-body.json`; the agent POSTs the file in `post { always }`. Preflight failure writes an error `result-body.json` and fails the build, so the same POST runs.
4. **The `docker run` command is built by one Groovy helper**; `isUnix()` chooses `sh`/`bat` and the `$WORKSPACE`/`%WORKSPACE%` spelling.
5. **`PLAYWRIGHT_IMAGE` is declared in `jobConfigXml()` (with a default) and passed at trigger time** from `config.playwrightDockerImage`.
6. **Version pinning is baked at job-creation time.** Changing `PLAYWRIGHT_DOCKER_IMAGE` requires pressing **Create Job** again.

---

## File Map

| File | Task | Responsibility |
|---|---|---|
| `PlaywrightPlatform/server/src/config.ts` | 1 | `PLAYWRIGHT_DOCKER_IMAGE` → `config.playwrightDockerImage` |
| `PlaywrightPlatform/.env.example` | 1 | New setting with a comment |
| `PlaywrightPlatform/server/test/config.test.ts` | 1 | Default + rejection tests |
| `PlaywrightPlatform/server/src/jenkins/pipeline.ts` | 2 | Docker stages, `playwrightVersionFromTag`, pinned `package.json`, `PLAYWRIGHT_IMAGE` param |
| `PlaywrightPlatform/server/test/jenkins-client.test.ts` | 2 | Pipeline-text and version-derivation tests |
| `PlaywrightPlatform/server/src/services/jenkins-service.ts` | 3 | `createJob` passes the image |
| `PlaywrightPlatform/server/src/services/execution-service.ts` | 3, 4 | `run` passes `PLAYWRIGHT_IMAGE` (3); `finish` keeps a reported error (4) |
| `PlaywrightPlatform/server/src/app.ts` | 3 | Wire the image into both services |
| `PlaywrightPlatform/server/test/jenkins-settings.test.ts` | 3 | `Create Job` config.xml declares `PLAYWRIGHT_IMAGE` |
| `PlaywrightPlatform/server/test/execution-run.test.ts` | 3 | `run` passes `PLAYWRIGHT_IMAGE` |
| `PlaywrightPlatform/server/test/execution-sync.test.ts` | 4 | Preflight message preserved |
| `PlaywrightPlatform/README.md`, `CLAUDE.md` | 5 | Documentation |

Task order: 1 → 2 → 3 → 4 → 5.

---

### Task 1: The `PLAYWRIGHT_DOCKER_IMAGE` setting

**Files:** `server/src/config.ts`, `PlaywrightPlatform/.env.example`, `server/test/config.test.ts`.

**Interfaces:**
- Produces: `Config.playwrightDockerImage: string`; default `mcr.microsoft.com/playwright:v1.63.0-noble`; validation rejects spaces/shell metacharacters and anything that is not `registry/name:tag`.

- [ ] **Step 1: Write the failing config tests**

In `server/test/config.test.ts`, extend the `loadConfig` describe with:

```ts
  it('defaults the Playwright Docker image to the current stable tag', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: key });
    expect(config.playwrightDockerImage).toBe('mcr.microsoft.com/playwright:v1.63.0-noble');
  });

  it('reads a custom Playwright Docker image', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      SECRETS_ENCRYPTION_KEY: key,
      PLAYWRIGHT_DOCKER_IMAGE: 'registry.example.com/team/playwright:v1.62.1-jammy',
    });
    expect(config.playwrightDockerImage).toBe('registry.example.com/team/playwright:v1.62.1-jammy');
  });

  it.each([
    ['a space', 'mcr.microsoft.com/playwright: v1.63.0'],
    ['a shell metacharacter', 'mcr.microsoft.com/playwright:v1.63.0;rm'],
    ['no tag', 'mcr.microsoft.com/playwright'],
    ['a bare name', 'playwright'],
    ['an empty tag', 'mcr.microsoft.com/playwright:'],
  ])('rejects a Playwright Docker image with %s', (_label, image) => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: key, PLAYWRIGHT_DOCKER_IMAGE: image }),
    ).toThrow(ConfigError);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w server -- test/config.test.ts`
Expected: FAIL — `config.playwrightDockerImage` is undefined.

- [ ] **Step 3: Implement the setting**

In `server/src/config.ts`, add to `envSchema` (after `PLATFORM_PUBLIC_URL`):

```ts
  // The Playwright Docker image builds run tests in. The tag must be a full
  // registry/name:tag reference: no spaces and no shell metacharacters.
  PLAYWRIGHT_DOCKER_IMAGE: z
    .string()
    .default('mcr.microsoft.com/playwright:v1.63.0-noble')
    .refine((v) => /^[A-Za-z0-9][A-Za-z0-9._/-]*:[A-Za-z0-9._-]+$/.test(v), 'must be a docker image like registry/name:tag'),
```

Add to the `Config` interface:

```ts
  /** The Playwright Docker image runs execute tests in. */
  playwrightDockerImage: string;
```

Add to the returned object:

```ts
    playwrightDockerImage: e.PLAYWRIGHT_DOCKER_IMAGE,
```

Append to `PlaywrightPlatform/.env.example`:

```
# The Playwright Docker image builds run tests in (registry/name:tag). Change the
# tag and @playwright/test together, then press Create Job again in the extension.
PLAYWRIGHT_DOCKER_IMAGE=mcr.microsoft.com/playwright:v1.63.0-noble
```

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w server -- test/config.test.ts` then `npm run typecheck`
Expected: config tests pass; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add PlaywrightPlatform/server/src/config.ts PlaywrightPlatform/.env.example PlaywrightPlatform/server/test/config.test.ts
git commit -m "feat(platform): add the Playwright Docker image setting"
```

---

### Task 2: The Docker pipeline and version derivation

**Files:** `server/src/jenkins/pipeline.ts`, `server/test/jenkins-client.test.ts`.

**Interfaces:**
- Produces: `playwrightVersionFromTag(tag): string`; `pipelineScript(image: string): string`; `jobConfigXml(image: string): string`.
- The pipeline: `Preflight` (agent `docker version`, `docker image inspect`/`docker pull`, error → write error `result-body.json`, `FAILURE`), `Prepare` (agent writes files and downloads the script with `RUN_TOKEN`), `Install` (container `npm install`), `Test` (container `npx playwright test; rc=$?; node report-result.cjs; exit $rc`), `post always` (agent POSTs `result-body.json` when present, archives `playwright-report/**`).
- The report script writes `result-body.json` and no longer reads `PLATFORM_URL`, `EXECUTION_ID`, or `RUN_TOKEN`.

- [ ] **Step 1: Rewrite the failing pipeline-text tests**

In `server/test/jenkins-client.test.ts`, replace the `pipeline text` describe and its import line. Import `playwrightVersionFromTag` alongside `jobConfigXml` and `pipelineScript`.

```ts
const IMAGE = 'mcr.microsoft.com/playwright:v1.63.0-noble';

describe('playwrightVersionFromTag', () => {
  it.each([
    ['mcr.microsoft.com/playwright:v1.63.0-noble', '1.63.0'],
    ['mcr.microsoft.com/playwright:v1.62.1-jammy', '1.62.1'],
    ['registry.example.com/team/playwright:v1.60.0', '1.60.0'],
  ])('extracts %s from %s', (tag, version) => {
    expect(playwrightVersionFromTag(tag)).toBe(version);
  });

  it('throws when the tag has no version', () => {
    expect(() => playwrightVersionFromTag('mcr.microsoft.com/playwright:latest')).toThrow();
  });
});

describe('pipeline text', () => {
  const script = pipelineScript(IMAGE);

  it('runs tests with docker run, not on the agent', () => {
    expect(script).toContain('docker run');
    expect(script).toContain('--ipc=host');
    expect(script).toContain('playwright-npm-cache:/tmp/.npm');
    expect(script).toContain('-w /work');
    // The workspace is mounted at /work.
    expect(script).toContain(':/work');
  });

  it('works on both agent types', () => {
    expect(script).toContain('isUnix()');
    expect(script).toContain("sh ");
    expect(script).toContain('bat ');
    expect(script).toContain('%WORKSPACE%');
    expect(script).toContain('$WORKSPACE');
  });

  it('uses the PLAYWRIGHT_IMAGE parameter and pins @playwright/test to its version', () => {
    expect(script).toContain('PLAYWRIGHT_IMAGE');
    expect(script).toContain('"@playwright/test": "1.63.0"');
  });

  it('removes the browser install and the agent-side test run', () => {
    expect(script).not.toContain('playwright install');
    expect(script).toContain('npm install --no-audit --no-fund');
    expect(script).toContain('npx playwright test');
    expect(script).toContain('node report-result.cjs');
  });

  it('still downloads the script with the run token', () => {
    expect(script).toContain('%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script');
    expect(script).toContain('Authorization: Bearer %RUN_TOKEN%');
    expect(script).toContain('X-Build-Number: %BUILD_NUMBER%');
    expect(script).toContain("bat '@curl ");
  });

  it('keeps the token and platform address out of the container', () => {
    const dockerLines = script.split('\n').filter((line) => line.includes('docker run'));
    expect(dockerLines.length).toBeGreaterThan(0);
    for (const line of dockerLines) {
      expect(line).not.toContain('RUN_TOKEN');
      expect(line).not.toContain('PLATFORM_URL');
    }
  });

  it('posts the result from the agent after the container ran', () => {
    expect(script).toContain('result-body.json');
    expect(script).toContain('--data-binary @result-body.json');
    expect(script).toContain("archiveArtifacts artifacts: 'playwright-report/**'");
  });

  it('wraps the pipeline in a job definition with four parameters and escaped markup', () => {
    const xml = jobConfigXml(IMAGE);
    expect(xml).toContain('<name>EXECUTION_ID</name>');
    expect(xml).toContain('<name>PLATFORM_URL</name>');
    expect(xml).toContain('<hudson.model.PasswordParameterDefinition>');
    expect(xml).toContain('<name>RUN_TOKEN</name>');
    expect(xml).toContain('<name>PLAYWRIGHT_IMAGE</name>');
    expect(xml).toContain(`<defaultValue>${IMAGE}</defaultValue>`);
    expect(xml).toContain('<sandbox>true</sandbox>');
    const scriptPart = xml.slice(xml.indexOf('<script>') + 8, xml.indexOf('</script>'));
    expect(scriptPart).not.toMatch(/<|>/);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w server -- test/jenkins-client.test.ts`
Expected: FAIL — `pipelineScript(IMAGE)` ignores its argument (old text) and the new assertions fail.

- [ ] **Step 3: Implement the pipeline**

Rewrite `server/src/jenkins/pipeline.ts`:

- `packageJson(version)` returns the `package.json` with `"@playwright/test": "<version>"`.
- `playwrightVersionFromTag(tag)` matches `/:v?(\d+\.\d+\.\d+)/` and throws a clear `Error` when absent.
- `REPORT_SCRIPT` keeps the report-body building and ends with `fs.writeFileSync('result-body.json', JSON.stringify(body));` — no `fetch`, no `PLATFORM_URL`/`EXECUTION_ID`/`RUN_TOKEN` reads.
- A `PREFLIGHT_FAILURE_SCRIPT` (or inline `writeFile`) writes the preflight error body into `result-body.json`.
- `pipelineScript(image)` defines a Groovy `dockerRun(String command)` helper and the stages described in the spec, with `isUnix()` choosing `sh`/`bat` and the variable spelling.
- `jobConfigXml(image)` declares `PLAYWRIGHT_IMAGE` as a `StringParameterDefinition` with a default of `image`.

The exact Groovy (quoting is the delicate part) is developed against the assertions; keep the assertions substring-based so the quoting is not over-fit.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w server -- test/jenkins-client.test.ts` then `npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add PlaywrightPlatform/server/src/jenkins/pipeline.ts PlaywrightPlatform/server/test/jenkins-client.test.ts
git commit -m "feat(platform): run tests inside the Playwright Docker image"
```

---

### Task 3: Pass the image to Jenkins at job creation and run

**Files:** `server/src/services/jenkins-service.ts`, `server/src/services/execution-service.ts`, `server/src/app.ts`, `server/test/jenkins-settings.test.ts`, `server/test/execution-run.test.ts`.

**Interfaces:**
- Consumes: `Config.playwrightDockerImage` (Task 1); `jobConfigXml(image)` (Task 2).
- Produces: `JenkinsService` receives the image and passes it to `jobConfigXml`; `ExecutionService` passes `PLAYWRIGHT_IMAGE` to `link.client.trigger`.

- [ ] **Step 1: Write the failing assertions**

In `server/test/jenkins-settings.test.ts`, in the "creates the job" test, add after the existing `config.xml` assertion:

```ts
    expect(stub.configs.get('playwright-platform-run')).toContain('<name>PLAYWRIGHT_IMAGE</name>');
```

In `server/test/execution-run.test.ts`, in the "starts a run" test, add after the `PLATFORM_URL` assertion:

```ts
    expect(stub.lastParams.PLAYWRIGHT_IMAGE).toBe(world.ctx.config.playwrightDockerImage);
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm test -w server -- test/jenkins-settings.test.ts test/execution-run.test.ts`
Expected: FAIL — `PLAYWRIGHT_IMAGE` is not declared and not passed.

- [ ] **Step 3: Wire the image through the services**

- `JenkinsService` constructor gains `playwrightDockerImage: string`; `createJob` calls `jobConfigXml(this.playwrightDockerImage)`.
- `ExecutionOptions` gains `playwrightDockerImage: string`; `run` adds `PLAYWRIGHT_IMAGE: this.options.playwrightDockerImage` to the `trigger` params.
- `app.ts`: `new JenkinsService(..., app.log, config.playwrightDockerImage)` and pass `playwrightDockerImage: config.playwrightDockerImage` in the `ExecutionService` options.

- [ ] **Step 4: Run to verify they pass**

Run: `npm test -w server -- test/jenkins-settings.test.ts test/execution-run.test.ts`, then `npm test`, then `npm run typecheck`
Expected: PASS; whole suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add PlaywrightPlatform/server/src PlaywrightPlatform/server/test/jenkins-settings.test.ts PlaywrightPlatform/server/test/execution-run.test.ts
git commit -m "feat(platform): pass the Playwright image to Jenkins at job creation and run"
```

---

### Task 4: Keep a build-reported error when the tests never ran

**Files:** `server/src/services/execution-service.ts`, `server/test/execution-sync.test.ts`.

**Interfaces:**
- Produces: `outcomeOf` marks the `FAILURE`+no-tests `ERROR` as `keepReported`; `finish` keeps the reported `errorMessage` instead of the generic `BUILD_FAILED_EARLY`.

- [ ] **Step 1: Write the failing test**

In `server/test/execution-sync.test.ts`, add a test that: starts a run, POSTs a report with `total: 0` and an `errorMessage`, then sets the build to `FAILURE` and polls; assert the execution is `ERROR` and `errorMessage` equals the reported message (not "The build failed before the tests ran…").

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -w server -- test/execution-sync.test.ts`
Expected: FAIL — the generic message overwrites the reported one.

- [ ] **Step 3: Implement**

Add `keepReported?: boolean` to `Outcome`; in `outcomeOf` set `keepReported: true` on the `FAILURE` → `ERROR` branch; in `finish` replace `if (outcome.errorMessage) patch.errorMessage = outcome.errorMessage;` with the guarded version that skips the overwrite when `keepReported` and `reported.errorMessage` are both set.

- [ ] **Step 4: Run to verify it passes**

Run: `npm test -w server -- test/execution-sync.test.ts`, then `npm test`, then `npm run typecheck`
Expected: PASS; whole suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add PlaywrightPlatform/server/src/services/execution-service.ts PlaywrightPlatform/server/test/execution-sync.test.ts
git commit -m "feat(platform): keep a build-reported error when tests never ran"
```

---

### Task 5: Documentation

**Files:** `PlaywrightPlatform/README.md`, `CLAUDE.md`.

- [ ] **Step 1: Update the README's "Run a script on Jenkins" section**

Replace "A **Windows** agent with **Node.js 18 or newer**" with the Docker requirements: Docker (Docker Desktop on Windows with Linux containers, or Docker Engine on Linux), `curl`, the Pipeline plugins, and the `docker` group / Docker Desktop for the Jenkins service account. Add the image-setting paragraph, the first-pull note, and the troubleshooting rows listed in the spec (`Docker is not available on the Jenkins agent`, image pull fails, `/var/run/docker.sock` permission, Windows drive not shared, root-owned files).

- [ ] **Step 2: Update `.env.example` note and the Jenkins line in `CLAUDE.md`**

`.env.example` was already updated in Task 1; confirm the comment. Update the `CLAUDE.md` Jenkins line to mention Docker.

- [ ] **Step 3: Commit**

```bash
git add PlaywrightPlatform/README.md CLAUDE.md
git commit -m "docs(platform): document running on Docker and the image setting"
```

---

## Verification

- Run: `npm run typecheck`, `npm test`, and `npm run build` in `PlaywrightPlatform/`; `node --test "PlaywrightExtension/tests/*.test.mjs"`.
- Confirm with `git diff --stat` that `PlaywrightPlatform/web`, `PlaywrightBridge`, and `PlaywrightOrchestrator` are untouched.
- The real-Jenkins checklist in `../ReqJenkinDocker.md` is performed by the owner against `http://localhost:7070`; do not mark it verified without that.
