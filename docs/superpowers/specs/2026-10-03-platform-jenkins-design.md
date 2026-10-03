# Platform Jenkins Execution — Design

Date: 2026-10-03
Status: approved
Sub-project: 4 of 5 (see `2026-10-03-platform-foundation-design.md`, section 1). Sub-project 3 (Skills) is not built; the two are independent.
Source requirements: `../Req.md` sections 8, 10, 19–25, 27, 30, 39 (one level above this repo), and the owner's direction of 2026-10-03 quoted in section 2
Branch: `feat/platform-jenkins`, cut from `feat/platform-scripts`

## 1. Context

Sub-projects 1 and 2 delivered sign-in, projects, and a database-backed script
repository with versions. The extension can sign in to the platform and save a
generated or recorded script into a project. Nothing can run a stored script yet:
the database tables for Jenkins configuration and executions exist (migration
`005_ci_execution`), but no API or UI uses them.

A Jenkins server runs on the owner's machine at `http://localhost:7070`
(version 2.555.2). The address is configuration, not a constant.

## 2. Decisions already made

The owner's direction, in their words: the plugin "will show the project and the test
script"; "the project admin page is there, that is fine"; "on the plugin there should
be a mechanism that I can run Jenkins job … that control, it will be driven by the
plugin itself".

From that, and approved in conversation:

1. **The extension is the control surface.** Browsing projects and scripts, running a
   script on Jenkins, watching it, and stopping it all happen in the side panel.
2. **The web app is not changed** in this sub-project.
3. **The extension talks only to the platform API.** The server is the only thing that
   talks to Jenkins or the database.
4. **Jenkins settings are entered in the extension's Settings panel, by an ADMIN,** and
   stored on the server. There is one Jenkins server for the installation.
5. **Jenkins pulls the script.** The server triggers a parameterised job; the pipeline
   downloads the exact script version from the platform with a one-time run token,
   runs it, and posts a summary back. Rejected: sending the script text as a build
   parameter (size limits, code visible in the Jenkins UI) and writing files into the
   Jenkins workspace from the server (works only when both share a disk).
6. **Result detail is a summary:** final status, test counts, duration, error message,
   and links to the Jenkins build and its Playwright report.
7. **One script per run.**

## 3. Goal and success criteria

After this sub-project:

- A signed-in person opens the **Projects** tab in the side panel, sees the projects,
  opens one, sees its scripts, searches them, and opens a script to read its code.
- An ADMIN enters the Jenkins URL, username, and API token under Settings → Jenkins,
  presses **Test Connection**, sees the Jenkins version or the reason it failed,
  saves, and presses **Create Job** to create the pipeline job in Jenkins.
- An ADMIN or USER presses **Run on Jenkins** on a script. A build starts in Jenkins,
  the panel shows Queued, then Running, then Passed or Failed with test counts and
  duration, without the person opening Jenkins.
- **Stop** aborts a queued or running build and the panel shows Aborted.
- The script page in the panel lists that script's recent runs.
- The run is recorded in `test_executions` with the script version that ran, who
  started it, and the Jenkins build number.
- Existing features (web app, Save to Project, Generator, Recorder, Bridge runs)
  behave as before.

## 4. Out of scope

- Per-test result rows, screenshots, videos, traces, and the report shown inside the
  platform or the panel (sub-project 5). `execution_results` stays unused.
- Healer hand-off from a failed run (sub-project 5).
- Running several scripts in one build, schedules, tags as a run filter, and
  environment or browser choices. `environment` and `browser` are stored as null.
- A Run button or run history in the web app.
- More than one Jenkins server, Jenkins folders, and per-project job selection UI.
  Every project uses the one configured job; `project_ci_jobs` gets one row per
  project the first time that project runs.
- Linux Jenkins agents. The generated pipeline uses Windows `bat` steps. The
  pipeline text is one function, so adding `sh` later is a contained change.
- Jenkins webhooks into the platform other than the pipeline's own result callback.

## 5. Data rules

No migration is needed; every column below exists.

**Jenkins settings** — one row in `jenkins_configurations` with `name = 'default'`.

| Field | Rule |
|---|---|
| `base_url` | `http` or `https` URL, at most 300 characters, trailing slash removed |
| `username` | 1–100 characters |
| API token | 1–200 characters; stored in `secret_ciphertext`, encrypted with AES-256-GCM under `SECRETS_ENCRYPTION_KEY`; never returned by any endpoint |
| `job_name` | 1–100 characters from `[A-Za-z0-9_.-]`; default `playwright-platform-run` |
| platform URL | The address Jenkins uses to reach the platform. It is not stored: it is the `PLATFORM_PUBLIC_URL` setting, default `http://127.0.0.1:<APP_PORT>` |

Saving settings without a token keeps the stored token, so an ADMIN can change the
URL or job name without re-entering it.

**Executions** — one row in `test_executions` per run.

| Column | Value |
|---|---|
| `project_id`, `script_id`, `script_version` | The script and the version that was current when Run was pressed |
| `jenkins_job_id` | The project's `project_ci_jobs` row |
| `trigger_type` | `MANUAL` |
| `triggered_by` | The signed-in user |
| `status` | `QUEUED` → `RUNNING` → `PASSED`, `FAILED`, `ABORTED`, or `ERROR` |
| `stage` | `QUEUED` → `RUNNING` → `COMPLETED` |
| `jenkins_queue_id`, `jenkins_build_number` | Set as Jenkins reports them |
| `total_tests`, `passed_tests`, `failed_tests`, `skipped_tests` | From the pipeline's callback; zero if it never arrives |
| `report_url` | `<build URL>artifact/playwright-report/index.html` once the build has a number |
| `error_message` | Why a run ended as `ERROR`, or the first failing test's message for `FAILED`; at most 2,000 characters |
| `callback_token_hash` | SHA-256 of the run token; cleared when the run reaches a final status |
| `started_at`, `completed_at`, `duration` | From Jenkins' build timestamp and duration (milliseconds) |

`PASSED` and `FAILED` mean the tests ran and passed or did not. `ERROR` means the run
could not be carried out (Jenkins unreachable, job missing, the build failed before
tests ran). `ABORTED` means someone stopped it.

**Status mapping from Jenkins**

| Jenkins | Execution |
|---|---|
| Queue item, no build yet | `QUEUED` |
| Queue item cancelled | `ABORTED` |
| Build `building: true` | `RUNNING` |
| Build `SUCCESS` | `PASSED` |
| Build `UNSTABLE` or `FAILURE`, and a callback reported test counts | `FAILED` |
| Build `FAILURE` with no callback | `ERROR` ("The build failed before the tests ran. Open the Jenkins build for the log.") |
| Build `ABORTED` | `ABORTED` |
| Queue item or build not found (404) | `ERROR` |

A run still `QUEUED` 10 minutes after it was created ends as `ERROR` ("Jenkins did
not start the build. Check that an agent is online.") the next time it is read.

## 6. API

All under `/api`. Roles as in the foundation: `signedIn` is any role; `writers` is
ADMIN and USER; `admins` is ADMIN. The extension sends its bearer token.

| Method and path | Who | Purpose |
|---|---|---|
| `GET /jenkins/settings` | signedIn | `{ settings: { configured, baseUrl, username, jobName, hasToken } }`; `baseUrl` and `username` are empty strings for non-admins |
| `PUT /jenkins/settings` | admins | Save URL, username, job name, and optionally the token |
| `POST /jenkins/test` | admins | Try the body's values, or the saved ones when the body is empty: `{ ok, version, pipelinePlugin, message }` |
| `POST /jenkins/job` | admins | Create the pipeline job, or update its definition if it exists: `{ created, jobUrl }` |
| `POST /scripts/:id/run` | writers | Start a run: 201 `{ execution }` |
| `GET /executions/:id` | signedIn | Sync with Jenkins if not final, then `{ execution }` |
| `POST /executions/:id/stop` | writers | Abort: `{ execution }` |
| `GET /scripts/:id/executions?limit=` | signedIn | Newest first, `limit` 1–50, default 10: `{ items }`. Does not sync. |
| `GET /executions/:id/script` | run token | The script content as `text/plain`, for the pipeline |
| `POST /executions/:id/result` | run token | `{ total, passed, failed, skipped, errorMessage? }` from the pipeline |

The extension's Projects tab uses endpoints that already exist: `GET /projects`,
`GET /projects/:id/scripts`, `GET /scripts/:id`.

### 6.1 Execution response

```json
{
  "id": 12, "projectId": 1, "scriptId": 3, "scriptName": "Login Test", "scriptVersion": 2,
  "status": "RUNNING", "stage": "RUNNING",
  "buildNumber": 41, "buildUrl": "http://localhost:7070/job/playwright-platform-run/41/",
  "reportUrl": "http://localhost:7070/job/playwright-platform-run/41/artifact/playwright-report/index.html",
  "total": 0, "passed": 0, "failed": 0, "skipped": 0,
  "errorMessage": null, "triggeredBy": "Ada Admin",
  "createdAt": "…", "startedAt": "…", "completedAt": null, "durationMs": null
}
```

`buildUrl` and `reportUrl` are null until Jenkins assigns a build number.

### 6.2 Errors

| Status | Code | When |
|---|---|---|
| 409 | `JENKINS_NOT_CONFIGURED` | Run, test with an empty body, or create job before settings are saved |
| 409 | `PROJECT_NOT_ACTIVE` | Run in an archived project |
| 409 | `EXECUTION_FINISHED` | Stop on a run that already has a final status |
| 409 | `RUN_IN_PROGRESS` | Run while the same script has a `QUEUED` or `RUNNING` execution |
| 502 | `JENKINS_UNREACHABLE` | Jenkins did not answer, or answered 5xx, on run, stop, or create job |
| 502 | `JENKINS_REJECTED` | Jenkins answered 401 or 403 (wrong username or token, or missing permission), or 404 for the job |
| 401 | `UNAUTHENTICATED` | Missing or wrong run token on the two pipeline endpoints |
| 404 | `NOT_FOUND` | Unknown script or execution |

Messages say what to do, for example: "Jenkins refused the username or API token.
Check Settings → Jenkins." `POST /jenkins/test` never answers 502: a failed test is a
normal result with `ok: false` and the reason in `message`.

### 6.3 Run token

A run token is 32 random bytes, base64url, created when the run starts and passed to
the build as a password-type parameter so Jenkins masks it. Only its SHA-256 hash is
stored. It is valid for its own execution only, for the two pipeline endpoints only,
and only while the execution is `QUEUED` or `RUNNING`. Comparison is constant-time.
The script endpoint serves the version recorded on the execution, not the newest.

### 6.4 Consistency

- **Run** inserts the execution row first, then calls Jenkins. If the Jenkins call
  fails, the row is updated to `ERROR` with the reason and the API answers with the
  502 above; the failed run stays visible in history.
- **Sync** happens inside `GET /executions/:id`, at most once per 2 seconds per
  execution; a second reader within that window gets the stored row. Sync never
  moves an execution out of a final status.
- **Callback and sync can arrive in either order.** The callback writes only the
  counts and the error message; status comes only from Jenkins, so a forged or
  repeated callback cannot mark a run passed.
- **A Jenkins error during sync** leaves the row unchanged and the response carries
  the stored state; the run is not failed because one poll could not reach Jenkins.
- Run, stop, settings save, and job creation write audit rows (`execution.run`,
  `execution.stop`, `jenkins.settings.update`, `jenkins.job.create`). The token is
  never written to the audit log or the server log.

## 7. Jenkins job

`POST /jenkins/job` creates one Pipeline job through `POST /createItem` (or updates
it through `POST /job/<name>/config.xml`), with these parameters: `EXECUTION_ID`
(string), `PLATFORM_URL` (string), `RUN_TOKEN` (password).

The pipeline, on a Windows agent:

1. Clean the workspace.
2. Write `package.json` and `playwright.config.ts` (reporters: `html` with
   `open: 'never'`, and `json` to `results.json`; Chromium only; headless).
3. Download the script: `curl` to `%PLATFORM_URL%/api/executions/%EXECUTION_ID%/script`
   with the run token in an `Authorization: Bearer` header, saved as
   `tests/script.spec.ts`.
4. `npm install`, then `npx playwright install chromium`.
5. `npx playwright test`; a non-zero exit marks the build `UNSTABLE` and the pipeline
   continues.
6. A small Node script reads `results.json` and posts the counts, and the first
   failure message, to `…/result`.
7. Always: archive `playwright-report/**`.

The Jenkins machine needs Node.js on the agent's PATH and the Pipeline plugin
(`workflow-aggregator`). Test Connection reports whether the plugin is installed.
A missing Node.js shows up as an `ERROR` run whose message points at the build log.

Jenkins is called with HTTP Basic authentication (username and API token). With an
API token Jenkins does not require a CSRF crumb.

## 8. Server structure

Layering stays `routes/` → `services/` → `repositories/`.

| File | Responsibility |
|---|---|
| `src/crypto/secret-box.ts` | `encrypt(text)` and `decrypt(ciphertext)` with AES-256-GCM and the configured key |
| `src/jenkins/jenkins-client.ts` | The only code that calls Jenkins: `version`, `hasPlugin`, `jobExists`, `createOrUpdateJob`, `trigger`, `queueItem`, `build`, `stopBuild`, `cancelQueue`. 10-second timeout. Throws typed errors for unreachable and rejected. |
| `src/jenkins/pipeline.ts` | Pure functions that return the pipeline text and the job's `config.xml` |
| `src/repositories/jenkins-repository.ts` | Read and write the settings row and `project_ci_jobs` |
| `src/repositories/execution-repository.ts` | Insert, read, list, and update executions |
| `src/services/jenkins-service.ts` | Settings rules, test connection, create job |
| `src/services/execution-service.ts` | Run, sync, stop, pipeline script, pipeline result |
| `src/schemas/jenkins.ts`, `src/schemas/executions.ts` | Bodies, queries, response shapes |
| `src/routes/jenkins.ts`, `src/routes/executions.ts` | The routes in section 6 |
| `src/config.ts` | Adds `PLATFORM_PUBLIC_URL` |

The Jenkins client takes its `fetch` function as a parameter so tests can point it
at a local stub.

## 9. Extension

All new logic that can be free of DOM and `chrome.*` calls lives in `utils/` and is
tested with `node --test`.

| File | Change |
|---|---|
| `utils/platform-client.js` | Adds `listScripts`, `getScript`, `getJenkinsSettings`, `saveJenkinsSettings`, `testJenkins`, `createJenkinsJob`, `runScript`, `getExecution`, `stopExecution`, `listExecutions` |
| `utils/execution-view.js` (new) | Pure helpers: status label and colour class, duration text, counts text, whether a status is final |
| `sidepanel.html`, `sidepanel.css` | A **Projects** tab; a **Jenkins** block in Settings |
| `sidepanel.js` | `setupProjectsPanel()` and `setupJenkinsSettings()` |

**Projects tab.** Not signed in: a line that says to sign in under Settings →
Platform. Signed in: the project list (name, script count). Opening a project shows
its scripts with a search box (debounced, uses the existing `q` parameter) and a Back
link. Opening a script shows its name, version, language, tags, the code in a
read-only block, and **Run on Jenkins**.

**Running.** Run on Jenkins is shown to ADMIN and USER in an active project. After it
is pressed the panel shows a status card: status, build number, counts, duration,
error message, **Open in Jenkins**, **Open report**, and **Stop** while the run is
not final. The panel polls `GET /executions/:id` every 3 seconds until the status is
final or the person leaves the script. When Jenkins is not configured the button is
replaced by a line that says an administrator must set it up under Settings →
Jenkins. Under the card, **Recent runs** lists the last 10 runs; selecting one shows
it in the card.

**Settings → Jenkins.** Shown to an ADMIN who is signed in to the platform: URL,
username, API token (empty, with "saved" as its placeholder once one is stored), job
name, **Test Connection**, **Save**, **Create Job**, and a status line. Other roles
see whether Jenkins is configured and nothing else.

All text that came from the server is written with `textContent`. Links to Jenkins
open in a new tab and are created only when the URL starts with the configured
Jenkins address.

## 10. Testing

**Server (Vitest, real PostgreSQL, a stub Jenkins).** The stub is a local HTTP server
started by the tests that implements the Jenkins endpoints the client uses and can be
told to answer as unreachable, 401, 403, 404, or any build state.

- Settings: roles; token encrypted at rest and absent from every response and from
  the audit row; save without a token keeps the old one; each field limit.
- Test connection: success with version; wrong token; unreachable; plugin missing.
- Create job: created; updated when it exists; Jenkins errors.
- Run: creates the row, calls Jenkins with the three parameters, returns `QUEUED`;
  VIEWER refused; archived project; not configured; a second run while one is active;
  Jenkins down leaves an `ERROR` row.
- Sync: every row of the mapping table in section 5; the 10-minute queue timeout; the
  2-second limit; a Jenkins error during sync changes nothing; a final status never
  changes.
- Stop: queued and running; already finished; roles.
- Pipeline endpoints: the right token gets the recorded version's content even after
  a newer version is saved; a wrong token, another run's token, and a token for a
  finished run are refused; the callback sets counts and cannot set status.
- Secret box: round trip; a changed ciphertext is rejected.
- Pipeline text: contains the three parameters and no token value.

**Extension (`node --test`).** New platform-client methods call the right path,
method, and body and surface server messages; execution-view helpers for every status.

**Real Jenkins, once, at the end.** With the owner's Jenkins at `localhost:7070`:
test connection, create job, run a passing script and a failing script, stop a
running one. This needs the owner's Jenkins username and API token, entered by the
owner in the panel. Until it is done the feature is recorded as not verified against
a real Jenkins.

**Manual checklist in Chrome** for the Projects tab and the Jenkins settings block,
as for sub-project 2.

## 11. Risks

- **Jenkins must reach the platform.** The server listens on `127.0.0.1` by default,
  which works only when Jenkins runs on the same machine. Another machine needs
  `APP_HOST` and `PLATFORM_PUBLIC_URL` changed; the README says so.
- **The Jenkins machine's tools are outside our control.** A missing Node.js, a
  missing Pipeline plugin, or a blocked browser download fails the build. The run
  ends as `ERROR` with a pointer to the build log rather than a specific diagnosis.
- **First run is slow.** `npm install` and the Chromium download run in every build
  because the workspace is cleaned. Acceptable for one script per run; caching is a
  later improvement.
- **Stored scripts are executed on the Jenkins machine.** Anyone with the USER role
  can run code there through a script. This matches the role's meaning in the
  foundation (USER may write scripts), and is stated in the README.
- **The side panel is still unverified in Chrome** from sub-projects 1 and 2; this
  sub-project adds more panel code with the same limitation until the manual
  checklist is run.
