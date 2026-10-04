# Platform Jenkins Docker Execution — Design

Date: 2026-10-04
Status: implemented on `feat/platform-jenkins-docker`. Checked against a real Jenkins 2.555.2 on Windows (service account LocalSystem, Docker Desktop) on 2026-10-04: builds 30 to 33 covered a passing run, a failing run, a repeat run, and an image that cannot be pulled. Not checked: a Linux agent, and a stopped Docker daemon (the platform database on that machine runs in Docker).
Follow-up to sub-project 4 ("Platform Jenkins Execution", `docs/superpowers/specs/2026-10-03-platform-jenkins-design.md`). This is not a new sub-project: it changes only *where* the tests execute.
Source requirements: `../ReqJenkinDocker.md` (one level above this repo), and the owner's direction of 2026-10-04.
Branch: `feat/platform-jenkins-docker`, cut from `feat/platform-jenkins`.

## 1. Context

Sub-project 4 runs a stored Playwright script on Jenkins. Today the generated pipeline runs on a
Windows agent with `bat` steps: it runs `npm install` and `npx playwright install chromium` on the
agent itself, and needs Node.js on the agent's `PATH`.

The change: each build runs `npx playwright test` inside the official Playwright Docker image
(`mcr.microsoft.com/playwright`) on the user's own machine. Nothing else about a run changes — the
extension drives runs, the server triggers Jenkins, the build downloads the script with a one-time
run token, and status comes only from Jenkins.

## 2. Decisions already made (from ReqJenkinDocker.md)

1. **Docker via `docker run`, not the Docker Pipeline plugin.** The pipeline calls
   `docker run --rm …` from the agent's shell. It must not use `agent { docker { } }`.
2. **Image and version pinning.** A server setting `PLAYWRIGHT_DOCKER_IMAGE`; the image is passed
   to the build as a `PLAYWRIGHT_IMAGE` job parameter; the generated `package.json` pins
   `@playwright/test` to the exact version in the tag.
3. **Networking and the run token: the container never talks to the platform.** The agent
   downloads the script; the container gets no `RUN_TOKEN` and no `PLATFORM_URL`; the result-summary
   script writes `result-body.json` instead of POSTing it; the agent POSTs the file.
4. **Status rules stay as they are.** A non-zero exit from the container's test command marks the
   build `UNSTABLE`; any other stage failing gives `FAILURE`.
5. **Preflight and clearer errors.** A first `Preflight` stage checks Docker and the image, and on
   failure posts a plain reason before failing the build.
6. **Keep everything else unchanged.** No new endpoints, no extension/web/Bridge/Orchestrator
   changes, no migration.

## 3. Goal and success criteria

After this change:

- A run's tests execute inside the Playwright Docker image; the agent needs only Docker and `curl`
  (no Node.js).
- The job has a fourth parameter `PLAYWRIGHT_IMAGE`, and the generated `package.json` pins
  `@playwright/test` to the version in the image tag, so Playwright finds the browsers the image
  already has.
- The run token never reaches the container and never appears in the console log; the container
  never calls the platform.
- A build on an agent without Docker, or that cannot pull the image, ends as `ERROR` with a plain
  reason ("Docker is not available on the Jenkins agent", "Could not pull …").
- Existing features (web app, Save to Project, Generator, Recorder, Bridge runs, status mapping)
  behave as before.

## 4. Out of scope

- The Docker Pipeline plugin and `agent { docker { } }` (unreliable workspace mounting on Windows
  agents with Docker Desktop).
- Changing the extension, web app, Bridge, Orchestrator, or any endpoint.
- A database migration.
- Non-Chromium browsers, multiple scripts per run, schedules, tags as a run filter.
- Running the platform server itself in Docker.

## 5. Data rules

No migration is needed. One new server setting:

| Variable | Rule |
|---|---|
| `PLAYWRIGHT_DOCKER_IMAGE` | Full image reference `registry/name:tag`, for example `mcr.microsoft.com/playwright:v1.63.0-noble`. Validated with a strict regex: characters `[A-Za-z0-9._/-]` plus one `:` before the tag, no spaces or shell metacharacters. Default `mcr.microsoft.com/playwright:v1.63.0-noble` (the current stable tag, verified 2026-10-04). |

`Config` gains `playwrightDockerImage: string`. The value is read at job creation (to bake the
pinned `@playwright/test` version into the pipeline text) and at run trigger (as the
`PLAYWRIGHT_IMAGE` parameter).

## 6. The pipeline

The job keeps its three existing parameters and gains a fourth:

- `EXECUTION_ID` (string), `PLATFORM_URL` (string), `RUN_TOKEN` (password), `PLAYWRIGHT_IMAGE` (string).

Stages:

1. **Preflight** (agent, host): `docker version`, then `docker image inspect %PLAYWRIGHT_IMAGE%` and
   `docker pull %PLAYWRIGHT_IMAGE%` when the image is not present. On failure the agent posts
   `{ total: 0, passed: 0, failed: 0, skipped: 0, errorMessage }` with a plain reason and fails the
   build (`FAILURE`).
2. **Prepare** (agent, host): unchanged in shape — `deleteDir()`, write `package.json` (now with
   `@playwright/test` pinned exactly), `playwright.config.ts`, `report-result.cjs`, `mkdir tests`,
   and `curl` the script with `RUN_TOKEN` and `X-Build-Number`. There is no
   `npx playwright install chromium`.
3. **Install** (container): `docker run` of the image runs `npm install --no-audit --no-fund`. A
   non-zero exit fails the build (`FAILURE`).
4. **Test** (container): `docker run` of the image runs
   `npx playwright test; rc=$?; node report-result.cjs; exit $rc` — the report script always runs
   and writes `result-body.json`, and the container exits with the test's code so a non-zero exit
   marks the build `UNSTABLE`.
5. **post `always`** (agent, host): POST `result-body.json` to
   `…/api/executions/%EXECUTION_ID%/result` with `curl` and `Authorization: Bearer %RUN_TOKEN%`
   when the file exists, then `archiveArtifacts artifacts: 'playwright-report/**'` as today.

### 6.1 Docker invocation

One Groovy helper builds the `docker run` command once; `isUnix()` chooses `sh` or `bat` for the
outer invocation, so a single pipeline works on both agent types. The container is Linux regardless
of the agent, so the inner command is always `sh -c '…'`.

- Mount the workspace at `/work` and set `-w /work`. The host path is `%WORKSPACE%` on Windows,
  `$WORKSPACE` on Linux. Docker Desktop must share that drive (the WSL2 backend shares it by
  default).
- Flags: `--rm --init --ipc=host` (Chromium needs `--ipc=host`). On Linux also `-u <uid>:<gid>` and
  `-e HOME=/tmp`, so files the container writes are not root-owned (otherwise the next build's
  `deleteDir()` fails).
- A named volume caches npm: `-v playwright-npm-cache:/tmp/.npm -e npm_config_cache=/tmp/.npm`, so
  builds after the first are fast.

### 6.2 The report script

`report-result.cjs` keeps everything up to building the result body (counts and first error), then
writes that body to `result-body.json` instead of `fetch`-POSTing it. It no longer reads
`PLATFORM_URL`, `EXECUTION_ID`, or `RUN_TOKEN`.

## 7. Server structure

| File | Change |
|---|---|
| `src/config.ts` | Adds `PLAYWRIGHT_DOCKER_IMAGE` (validated) and `Config.playwrightDockerImage` |
| `src/jenkins/pipeline.ts` | `pipelineScript(image)` and `jobConfigXml(image)` take the image; add the `PLAYWRIGHT_IMAGE` parameter; the Docker stages and the Groovy helper; pinned `package.json`; `playwrightVersionFromTag(tag)` |
| `src/services/jenkins-service.ts` | `createJob` passes the configured image to `jobConfigXml` |
| `src/services/execution-service.ts` | `run` passes `PLAYWRIGHT_IMAGE` at trigger; `finish` keeps a build-reported error message on `FAILURE` with no tests |
| `src/app.ts` | Wires the image into the two services |
| `PlaywrightPlatform/.env.example` | Adds `PLAYWRIGHT_DOCKER_IMAGE` |
| `PlaywrightPlatform/README.md` | Docker requirements, image setting, troubleshooting |
| `CLAUDE.md` | Updates the Jenkins line |

The Jenkins client is unchanged: `trigger` already accepts an arbitrary parameter map.

## 8. Decisions made in this spec (points ReqJenkinDocker.md leaves open)

1. **Current stable image is `mcr.microsoft.com/playwright:v1.63.0-noble`** (verified against
   playwright.dev's Docker page and the GitHub releases page on 2026-10-04); `@playwright/test`
   pins to `1.63.0`.
2. **Install and Test are two `docker run` calls**, not one, so a failed `npm install` is `FAILURE`
   while a non-zero `npx playwright test` is `UNSTABLE`. This is what preserves the existing status
   mapping.
3. **The report script runs inside the Test container** and writes `result-body.json`; the agent
   POSTs the file in `post { always }`. Preflight failure POSTs its error directly from the agent
   (which has the token) and then fails the build.
4. **The pinned `@playwright/test` version is baked at job-creation time** from
   `PLAYWRIGHT_DOCKER_IMAGE`. Changing the image requires pressing **Create Job** again (the
   existing documented flow). `playwrightVersionFromTag` extracts `1.63.0` from the tag.
5. **`PLAYWRIGHT_IMAGE` is both declared in `jobConfigXml()` (with a default) and passed at trigger
   time** from `config.playwrightDockerImage`, so the run always uses the current setting.
6. **Status mapping is untouched.** The only `ExecutionService.finish` change is to keep a
   build-reported error message when the outcome is `ERROR` from `FAILURE` with no tests (preflight
   message preservation).

7. **A Preflight failure is reported through the same path as a test result.** The stage writes
   `result-body.json` with the reason and fails the build; the agent posts the file in
   `post { always }`. So the token appears on four lines only (script download and result post,
   once per agent type), and a test pins that each of them is silenced (`@` or `set +x`).
8. **`deleteDir()` moved from Prepare to the start of Preflight.** Otherwise a build that failed
   or was aborted in Preflight could post the `result-body.json` an earlier build left behind.
9. **On Linux, Preflight makes the npm cache volume writable** with one extra `docker run … chmod`.
   Docker creates a named volume owned by root, and the container runs as the agent's user.
10. **The setting must name a version.** `PLAYWRIGHT_DOCKER_IMAGE=…:latest` is refused when the
    server starts, rather than when an ADMIN presses Create Job. A registry with a port
    (`localhost:5000/playwright:v1.63.0-noble`) is accepted.
11. **`ExecutionRepository.lockActive` also returns the reported error message**, which is what
    lets `finish` keep it. No schema change: the column already exists.

## 9. Testing

Server (Vitest, real PostgreSQL, the existing Jenkins stub):

- Pipeline text: uses `docker run`; uses `isUnix()` with `sh` and `bat` branches; mounts `/work`;
  passes `--ipc=host`; uses the npm cache volume; uses the `PLAYWRIGHT_IMAGE` parameter; has no
  `playwright install` step; no `docker run` line contains `RUN_TOKEN` or `PLATFORM_URL`; the result
  is POSTed by `curl` from the agent.
- `jobConfigXml()`: declares four parameters; the markup inside the script is escaped.
- Generated `package.json`: pins `@playwright/test` to the image tag's version, table-driven over
  `-noble` and `-jammy` (and other) tags.
- Config: default image; an invalid image value is rejected; a run passes `PLAYWRIGHT_IMAGE` to
  Jenkins.
- Preflight message preserved: a `FAILURE` build with a reported error message and zero tests ends
  as `ERROR` with that message.
- The whole existing suite stays green.

Run: `npm run typecheck`, `npm test`, `npm run build` in `PlaywrightPlatform/`, and
`node --test "PlaywrightExtension/tests/*.test.mjs"`.

## 10. Risks

- **The agent must have Docker and `curl`.** Missing Docker is caught by `Preflight` and reported
  clearly; a missing `curl` fails the Prepare stage and surfaces as `ERROR` pointing at the build log.
- **First build is slow.** The first pull of the image (about 1–2 GB) is slow; later builds reuse
  the image and the npm cache volume.
- **Windows drive sharing.** The workspace drive must be shared with Docker Desktop, or the
  `/work` mount is empty and the build fails.
- **Linux root-owned files.** Without `-u <uid>:<gid>`, the container writes root-owned files and
  the next build's `deleteDir()` fails; documented in the README and handled by the Linux flags.
