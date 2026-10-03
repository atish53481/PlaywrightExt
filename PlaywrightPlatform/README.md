# Playwright Platform

Backend, database, and web app for Playwright AI Studio: projects, Playwright scripts with
version history, users, roles, and audit logging today; skills, Jenkins execution, reports,
and healing in later releases. The database already contains the tables for all of those.

## Architecture

```
web/ (React + Vite)  ──HTTP /api──▶  server/ (Fastify)  ──Knex──▶  PostgreSQL (Docker)
Chrome extension     ──HTTP /api──▶  routes → services → repositories
```

- **routes/** parse and validate HTTP, then call a service.
- **services/** hold the rules (roles, last-admin protection, audit).
- **repositories/** are the only code that queries the database.
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
- **Run** and **Heal** are shown disabled until the Jenkins and healing releases.

The server stores and returns script content as text. It never executes it.

## Connect the extension

Load `PlaywrightExtension/` unpacked in Chrome, open Settings in the side panel, enter the
platform URL (for example `http://localhost:3000`) and your credentials under **Platform**,
and choose **Sign in**. The password is not stored; a 30-day token is.

Once signed in, the Generator, Recorder, and Orchestrator panels show **💾 Save to Project**
beside Copy: choose a project and a name, and the script appears in that project's Scripts
tab. Only TypeScript and JavaScript output can be saved.

## Tests

```bash
npm test             # server: Vitest against playwright_db_test
npm run test:e2e     # web: Playwright against a server on :3100 and Vite on :5174
node --test "../PlaywrightExtension/tests/*.test.mjs"   # extension client
```

Both suites rebuild `playwright_db_test`. Do not run them at the same time.

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
