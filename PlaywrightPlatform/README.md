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

A stored script is one file. The Generator and Orchestrator produce page classes and tests
as separate files, so Save joins them into one that runs as it is: the notice above the code
is dropped, imports of the joined files are removed, and imports of the same package are
merged. A recorded script is already one file and is stored unchanged.

## Skills

A skill is a Markdown note of rules, standards, and examples that the AI agents are given:
"use TypeScript", "prefer `getByRole()`", "never hard-code credentials". Skills are managed
in the extension (**Projects** tab → a project → **🧠 Skills**) and in the web app (a
project's **Skills** tab); both do the same things: search by name, description, or tag,
tags, **Duplicate**, and **Download .md**.

- **Project skill**: belongs to one project. ADMIN and USER can write one with **+ New
  Skill**, or load a `.md` file with **⬆ Upload .md** (the file is put in the editor; nothing
  is stored until Save).
- **Global skill**: an ADMIN ticks **Global skill** when creating it. Every project sees it
  in its list and switches it on to use it. Only an ADMIN can change or archive it.
- The checkbox on a row switches the skill on or off for that project; the number sets the
  order (lower first; a project's own skill before a global one with the same number).
- Changing the text makes a new **version**. The editor lists the versions and can restore
  one, which writes it as a new version. **Archive** removes a skill from every list and
  keeps it in the database for the scripts and runs that name it.

**Using skills.** Tick **Use this project's skills in the Planner, Generator, and Healer** in
a project's Skills view. From then on every request the agents send carries that project's
switched-on skills, in order, and the top bar shows `🧠 Skills: <project>`. Untick it to
stop. Above the input of each of the three agents the skills are listed with a tick each, so
one generation can leave some out. A script saved from the Generator or Orchestrator records the skill versions it was
made with (`script_skills`), and a run keeps them (`execution_skill_snapshots`).

**Skills are untrusted text.** They are written by project members, so they are handled as
data everywhere:

- They are placed in the request as reference material under a heading that says so, below
  the application's own instructions. The system prompt is never changed by a skill, and a
  skill cannot close its own block or imitate another.
- They are shown only as plain text, never rendered as HTML or Markdown, and never run.
- An uploaded file name is kept only if it is a plain `.md` name; skill text is limited to
  200,000 characters, and an upload to 300 KB.
- The model can still be influenced by what a skill says, as by any text it reads. Give the
  USER role only to people you trust to write the project's test standards.

## Run a script on Jenkins

Runs are started, watched, and stopped in the extension's side panel. The extension talks
only to this server; the server talks to Jenkins.

**What Jenkins needs**

- The **Pipeline** plugins: `workflow-job`, `workflow-cps`, and `pipeline-model-definition`
  (installing "Pipeline" brings all three). Test Connection names any that are missing.
- **Docker** on the machine that runs the builds: Docker Desktop on Windows (with Linux
  containers), or Docker Engine on Linux. The tests run inside the official Playwright
  image, started with `docker run`. One job serves Windows and Linux agents.
- The account Jenkins runs as must be allowed to run `docker`. On Linux, add it to the
  `docker` group and restart Jenkins. On Windows, Docker Desktop must be running, and the
  drive that holds the Jenkins workspace must be shared with it (with the WSL 2 backend
  every drive is shared).
- **`curl`** on the agent. Windows 10 and later include it.
- Network access from the agent to this server, to the image registry (`mcr.microsoft.com`),
  and to npm.
- Node.js is **not** needed on the agent, and no browser is downloaded: the image has both.
- A Jenkins user and an **API token** for it: in Jenkins, open your user menu → **Security**
  (older versions: **Configure**) → **API Token** → **Add new Token**. The user needs
  permission to create jobs, build, and cancel builds.

**Set it up once (ADMIN)**

1. In the side panel open **Settings** and sign in under **Platform**.
2. Under **Jenkins** enter the Jenkins URL, the username, and the API token.
3. Press **Test Connection**, then **Save**, then **Create Job**. This creates the pipeline
   job `playwright-platform-run` in Jenkins; pressing it again updates the job's definition.
   A job created before the tests ran in Docker keeps its old definition until an ADMIN
   presses **Create Job** again.

**Run (ADMIN or USER)**

The short way: in the Recorder, Generator, or Orchestrator press **💾 Save to Project**, then
**Save & Run on Jenkins**. The script is saved, the Projects tab opens it, and the run starts.
A run that ends Failed or Error offers **🔧 Send to Healer**, which fills the Healer panel
with the script and the errors Jenkins reported. After **Heal Test**, **Review fix for
saving** puts the fixed file in an editable box and shows, line by line, what would change
in the stored script. **Accept** saves it as a new version marked HEALED (with the skills
the Healer was given); **Accept & Run on Jenkins** also runs it. Nothing is saved before
Accept, and a fix is refused if the script was changed after the run it came from.

For a script that is already stored:

1. Open the **Projects** tab, a project, and a script.
2. Press **Run on Jenkins**. The card shows Queued, Running, and then Passed or Failed with
   the test counts, the duration, and links to the Jenkins build and its Playwright report.
3. When the run ends, the card lists every test with its status, its duration, and the
   error of a failed one: the report, inside the panel. A failed test shows its screenshot
   in the row (the platform reads it from Jenkins, so no Jenkins sign-in is needed), and has
   **Screenshot**, **Video**, and **Trace** links to the files the build kept. The links open
   from Jenkins, so for those you must be signed in to Jenkins in that browser; open a trace
   at trace.playwright.dev. A script that does not compile, or
   has no tests, ends as Error with the reason.
4. **Stop** aborts a queued or running build. **Recent runs** lists the script's last 10 runs.
5. **Delete** (ADMIN or USER, asked once more in the panel) removes the script from the
   platform and deletes its builds, with their logs and reports, from Jenkins. It waits for
   an unfinished run to end. If Jenkins cannot be reached the script is still deleted and
   its builds stay in Jenkins. Deleting a script in the web app does the same.

**How it works**

- Each run is a row in `test_executions` with the script version that was current when Run
  was pressed. One script can have one unfinished run at a time.
- The build has four stages. **Preflight** checks that Docker works and pulls the image if
  the agent does not have it. **Prepare** downloads that script version from this server
  with a one-time run token. **Install** and **Test** run `npm install` and
  `npx playwright test` (Chromium) inside the image, with the workspace mounted at `/work`.
  The agent then posts the test counts and each test's result back (stored in
  `execution_results`). The token works only for that run and only until the run ends.
- Only the agent talks to this server. The container is given the workspace and an npm
  cache, and never the run token or this server's address.
- Status comes from Jenkins, and is read whenever someone looks at the run. A run nobody
  looks at keeps its last known status until it is opened, or until Run is pressed again.
- A passed or failed run sets the script's state, which the project overview counts.

**The Playwright image**

`PLAYWRIGHT_DOCKER_IMAGE` in `.env` names the image, by default
`mcr.microsoft.com/playwright:v1.63.0-noble`. The tag must name a Playwright version: the
build installs exactly that version of `@playwright/test`, because any other version looks
for browsers the image does not have. To change the image, edit `.env`, restart the server,
and press **Create Job** again (the version is written into the job).

The first build pulls the image, about 1 to 2 GB, and is slow. Run
`docker pull mcr.microsoft.com/playwright:v1.63.0-noble` on the agent beforehand to avoid
that. Later builds reuse the image and two kinds of Docker volume: the npm cache
(`playwright-npm-cache`) and the installed packages (`playwright-node-modules-<executor>`,
one for each Jenkins executor). The packages are kept out of the workspace on purpose: on
Windows the workspace is a slow mount, and packages kept there cost about a minute a build.
With the volumes a short script finishes in about 15 seconds. To start clean, remove them
with `docker volume rm`; the next build fills them again.

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

One script per run; Chromium only; the tests run headless. Screenshots, videos, and traces
are kept for failed tests only, and are linked from the panel rather than shown in it.
After **Create Job** is pressed again, builds run in Docker, report per-test results, and
keep those files; builds of an older job definition report counts only.

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
| DELETE | `/scripts/:id` | ADMIN, USER (soft delete; also deletes the script's Jenkins builds; 409 `RUN_IN_PROGRESS` during a run) |
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
| GET | `/executions/:id/results` | signed in |
| GET | `/executions/:id/results/:index/screenshot` | signed in (the image, fetched from Jenkins by the server) |
| GET | `/projects/:projectId/skills` | signed in |
| GET | `/projects/:projectId/skills/context` | signed in (what the agents are given) |
| POST | `/projects/:projectId/skills` | ADMIN, USER |
| PUT | `/projects/:projectId/skills/:skillId` | ADMIN, USER (attach, switch, order) |
| POST | `/skills` | ADMIN (global skill) |
| GET | `/skills/:id` | signed in |
| PUT | `/skills/:id` | ADMIN, USER (a global skill: ADMIN) |
| DELETE | `/skills/:id` | ADMIN, USER (archive; a global skill: ADMIN) |
| GET | `/skills/:id/versions` | signed in |
| GET | `/skills/:id/versions/:version` | signed in |
| POST | `/skills/:id/versions/:version/restore` | ADMIN, USER (a global skill: ADMIN) |
| GET | `/scripts/:id/skills` | signed in |
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
| A run ends as ERROR "The build failed before the tests ran" | Open the build's console log. Usual causes: the agent cannot reach `PLATFORM_PUBLIC_URL`, `curl` is missing on the agent, `npm install` could not reach npm, or the job is older than the server (press **Create Job** again). |
| A run ends as ERROR "Docker is not available on the Jenkins agent" | `docker version` failed for the account Jenkins runs as. Start Docker Desktop (Windows) or the Docker service (Linux), then run `docker version` as that account. |
| A run ends as ERROR "Could not pull mcr.microsoft.com/playwright:…" | The agent cannot reach the registry (offline, or behind a proxy Docker does not know), or the image name is wrong. Run `docker pull <image>` on the agent; set the proxy in Docker's own settings. |
| The console log says `permission denied` for `/var/run/docker.sock` | Linux: the Jenkins account is not in the `docker` group. Run `sudo usermod -aG docker jenkins` and restart Jenkins. |
| The Install stage fails with `package.json` not found in `/work` | Windows: the drive holding the Jenkins workspace is not shared with Docker Desktop. Share it under Settings → Resources → File sharing, or use the WSL 2 backend. |
| The Preflight stage fails to delete the workspace on Linux | Files there belong to root, left by a container that ran without the agent's user. Delete the workspace once with `sudo`; the job runs the container as the agent's user. |
| A run stays RUNNING after the build ended | Nobody has looked at it since. Open the script in the Projects tab; the run is read again from Jenkins. |
| Run or Test Connection answers `INTERNAL_ERROR` after `SECRETS_ENCRYPTION_KEY` changed | The stored Jenkins token can no longer be read. Enter the API token again under Settings → Jenkins and press Save. |
