# Playwright Platform

Backend, database, and web app for Playwright AI Studio: projects, Playwright scripts with
version history, runs of those scripts on Jenkins, users, roles, and audit logging today;
skills, reports, and healing in later releases. The database already contains the tables
for all of those.

## Architecture

```
web/ (React + Vite)  ──HTTP /api──▶  server/ (Fastify)  ──Knex──▶  PostgreSQL (Docker)
Chrome extension     ──HTTP /api──▶  routes → services → repositories
                                              │
                                              └──HTTP──▶  Jenkins  ──HTTP /api (run token)──▶  server/
```

- **routes/** parse and validate HTTP, then call a service.
- **services/** hold the rules (roles, last-admin protection, audit).
- **repositories/** are the only code that queries the database.
- **jenkins/jenkins-client.ts** is the only code that calls Jenkins. The extension never does.
- The web app sends a session cookie plus a CSRF header; the extension sends a bearer token.

## Requirements

Node 20 or newer, Docker, and a free port 5432 (or set `POSTGRES_PORT`).

## First-time setup

```bash
cd PlaywrightPlatform
npm install
cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Edit `.env`:

| Variable | What to put |
|---|---|
| `SECRETS_ENCRYPTION_KEY` | The value printed by the command above |
| `POSTGRES_PASSWORD`, and the password inside `DATABASE_URL` and `DATABASE_URL_TEST` | One new password, the same in all three |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | The first administrator (password at least 8 characters) |

Then:

```bash
docker compose up -d postgres   # start PostgreSQL
npm run db:migrate              # create all tables
npm run db:seed                 # create the first admin
```

## Run in development

```bash
npm run dev:server   # API on http://127.0.0.1:3000
npm run dev:web      # web app on http://localhost:5173
```

Open http://localhost:5173 and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.

## Run in production

```bash
npm run build
NODE_ENV=production npm run start
```

The server then serves the web app and the API from one origin on `APP_PORT`.
Put it behind HTTPS: in production the session cookie is `Secure` and the security
headers tell browsers to upgrade requests to HTTPS. Behind a reverse proxy also set
`TRUST_PROXY` to the proxy's own address or CIDR range (`loopback` for a proxy on the
same host); otherwise every request appears to come from the proxy, so the login rate
limit is shared by all users and audit rows record the proxy's address. Leave it
`false` when there is no proxy: trusting forwarded headers from anyone lets a client
forge its address. Set `APP_HOST=0.0.0.0` only when a
reverse proxy or firewall controls access.

## Database commands

| Command | Effect |
|---|---|
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:rollback` | Revert the most recent batch |
| `npm run db:seed` | Create the first admin if absent |
| `docker compose --profile tools up -d pgadmin` | pgAdmin on http://127.0.0.1:5050 (set `PGADMIN_PASSWORD` in `.env` first) |

Schema changes are always a new file in `server/src/migrations/` added to the list in
`index.ts`. Never edit a migration that has already been applied anywhere.

## Roles

| Action | ADMIN | USER | VIEWER |
|---|---|---|---|
| View projects | yes | yes | yes |
| Create, edit, archive, delete projects | yes | no | no |
| Manage users (Settings → Users) | yes | no | no |
| View, search, and download scripts and their history | yes | yes | yes |
| Create, import, edit, duplicate, restore, and delete scripts | yes | yes | no |
| Browse projects and scripts, and see runs, in the extension | yes | yes | yes |
| Run a script on Jenkins, and stop a run | yes | yes | no |
| Set up Jenkins (extension: Settings → Jenkins) | yes | no | no |

## Scripts

Scripts live in the database, inside a project (project → **Scripts** tab).

- **Versions.** Saving changed content creates a new version (`v1`, `v2`, …). Changing the
  name, description, test scenario, or tags does not. History is never rewritten: restoring
  `v1` creates a new version with that content. The **Version History** page compares any two
  versions side by side.
- **Two people editing.** A save is refused if someone else saved a newer version in the
  meantime. The page keeps your text and offers **Reload latest** or **Compare with latest**;
  after comparing, **Keep my text** puts your text on top of the latest version so it can be saved.
- **Limits.** Name up to 200 characters, unique within the project (case does not matter);
  content up to 1,000,000 characters and 2 MB as sent; up to 20 tags of at most 40 characters
  (letters, digits, spaces, and `- _ . @`).
- **Line endings** are stored as `\n`.
- **Import** accepts `.ts`, `.js`, `.mjs`, and `.cjs` files up to 1 MB.
- **Delete** hides the script and frees its name; the row and its history stay in the database.
- **Archived projects** are read-only: their scripts can be viewed and downloaded, not changed.
- **Run** happens in the extension's **Projects** tab (see "Run a script on Jenkins" below).
  In the web app, **Run** and **Heal** are still shown disabled.

The server stores and returns script content as text. It never executes it; a run hands the
script to a Jenkins build.

## Connect the extension

Load `PlaywrightExtension/` unpacked in Chrome, open Settings in the side panel, enter the
platform URL (for example `http://localhost:3000`) and your credentials under **Platform**,
and choose **Sign in**. The password is not stored; a 30-day token is.

Once signed in, the Generator, Recorder, and Orchestrator panels show **💾 Save to Project**
beside Copy: choose a project and a name, and the script appears in that project's Scripts
tab. Only TypeScript and JavaScript output can be saved.

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

## Tests

```bash
npm test             # server: Vitest against playwright_db_test
npm run test:e2e     # web: Playwright against a server on :3100 and Vite on :5174
node --test "../PlaywrightExtension/tests/*.test.mjs"   # extension client
```

Both suites rebuild `playwright_db_test`. Do not run them at the same time. The server tests
start their own local stand-in for Jenkins, so no Jenkins is needed to run them.

## API

All routes are under `/api`. Errors always look like
`{ "error": { "code": "...", "message": "...", "details": ... } }`.

| Method | Path | Role |
|---|---|---|
| GET | `/health` | public |
| POST | `/auth/login` | public |
| POST | `/auth/logout` | signed in |
| GET | `/auth/me` | signed in |
| GET | `/projects` | signed in |
| POST | `/projects` | ADMIN |
| GET | `/projects/:id` | signed in |
| PUT | `/projects/:id` | ADMIN |
| DELETE | `/projects/:id` | ADMIN (soft delete) |
| GET | `/users` | ADMIN |
| POST | `/users` | ADMIN |
| PUT | `/users/:id` | ADMIN |
| GET | `/projects/:projectId/scripts` | signed in (`status=DELETED`: ADMIN) |
| POST | `/projects/:projectId/scripts` | ADMIN, USER |
| GET | `/scripts/:id` | signed in |
| PUT | `/scripts/:id` | ADMIN, USER |
| DELETE | `/scripts/:id` | ADMIN, USER (soft delete) |
| POST | `/scripts/:id/duplicate` | ADMIN, USER |
| GET | `/scripts/:id/versions` | signed in |
| GET | `/scripts/:id/versions/:version` | signed in |
| POST | `/scripts/:id/versions/:version/restore` | ADMIN, USER |
| GET | `/scripts/:id/download` | signed in (optional `?version=`) |
| GET | `/tags` | signed in |
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

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `Invalid configuration:` at startup | `.env` is missing or a listed variable is empty. Fill in each one named in the message. |
| `/api/health` returns `database: "down"` | PostgreSQL is not running or `DATABASE_URL` is wrong. Run `docker compose ps`; check port and password. |
| `docker compose up` fails with "port is already allocated" | Another PostgreSQL uses 5432. Set `POSTGRES_PORT=5433` and use that port in both database URLs. |
| Tests fail with `database "playwright_db_test" does not exist` | The data volume predates the init script. Run `docker compose exec postgres createdb -U <POSTGRES_USER> playwright_db_test`. |
| Server fails to start with `EADDRINUSE` | Port 3000 is taken. Set `APP_PORT=3001` in `.env`, and start the web app with `VITE_API_TARGET=http://127.0.0.1:3001 npm run dev:web`. |
| Login returns 429 | Ten attempts per 15 minutes per address. Wait, or restart the server in development. |
| Web app shows "Missing or invalid CSRF token" | The page is older than the session. Reload it. |
| Sign-in works but the next request is 401 in production | The site is served over plain HTTP, so the `Secure` cookie is dropped. Serve it over HTTPS. |
| Saving a script says someone else saved a newer version | Two people edited the same version. Choose **Compare with latest**, then **Keep my text** or **Reload latest**. |
| A save answers `PAYLOAD_TOO_LARGE` | The request is over 2 MB. Text with many non-English characters can reach that before 1,000,000 characters. Split the script. |
| A script change answers `PROJECT_NOT_ACTIVE` | The project is archived. Restore it on the Projects page (Status: Archived → Restore). |
| The extension's Save to Project says to sign in first | Open the side panel's Settings → Platform, enter the platform URL and your credentials, and choose **Sign in**. |
| Run answers `JENKINS_NOT_CONFIGURED` | Nobody has saved the Jenkins connection. An ADMIN opens the extension's Settings → Jenkins. |
| Run answers `JENKINS_REJECTED` | The username or API token is wrong, the Jenkins user lacks permission, or the job does not exist. Press Test Connection, then Create Job. |
| Run answers `JENKINS_UNREACHABLE` | Jenkins is not running or the URL is wrong. Open the Jenkins URL in a browser. |
| A run ends as ERROR "Jenkins did not start the build" | No agent took the build within 10 minutes. Check Build Executor Status in Jenkins. |
| A run ends as ERROR "The build failed before the tests ran" | Open the build's console log. Usual causes: Node.js is not on the agent's PATH, the agent cannot reach `PLATFORM_PUBLIC_URL`, or the package or browser download is blocked. |
| A run stays RUNNING after the build ended | Nobody has looked at it since. Open the script in the Projects tab; the run is read again from Jenkins. |
| Run or Test Connection answers `INTERNAL_ERROR` after `SECRETS_ENCRYPTION_KEY` changed | The stored Jenkins token can no longer be read. Enter the API token again under Settings → Jenkins and press Save. |
