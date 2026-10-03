# Playwright Platform

Backend, database, and web app for Playwright AI Studio: projects, users, roles, and audit
logging today; scripts, skills, Jenkins execution, reports, and healing in later releases.
The database already contains the tables for all of those.

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
headers tell browsers to upgrade requests to HTTPS. Set `APP_HOST=0.0.0.0` only when a
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

## Connect the extension

Load `PlaywrightExtension/` unpacked in Chrome, open Settings in the side panel, enter the
platform URL (for example `http://localhost:3000`) and your credentials under **Platform**,
and choose **Sign in**. The password is not stored; a 30-day token is.

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
