# Platform Foundation — Design

Date: 2026-10-03
Status: awaiting review
Source requirements: `../Req.md` (one level above this repo)

## 1. Context

Playwright AI Studio today is three independent projects: a Chrome MV3 extension
(agents run in the side panel, state in `chrome.storage.local`), a local WebSocket
Bridge (`PlaywrightBridge/server.js`, real headed Playwright runs and `claude -p`),
and a standalone Orchestrator CLI. There is no backend, database, authentication,
or CI integration.

`Req.md` asks for a test-management and CI/CD platform wrapped around the existing
agents: projects, database-stored scripts with versions, Skills, Jenkins execution,
results, reports, and reviewed healing. That is too large for one spec, so it is
split into five sub-projects, each with its own spec, plan, and verification:

1. **Foundation** (this spec)
2. Scripts — CRUD, versioning, diff/restore, tags, search, "Save to Project"
3. Skills — global/project skills, versions, attachment, agent context
4. Jenkins and execution — configuration, workspace, trigger/monitor/stop, webhook
5. Results, reports, healing — result ingest, artifacts, report proxy, healer review

Dependency order: 1 → 2 → (3 and 4 in either order) → 5.

## 2. Decisions already made

- **UI surface:** a web app served by the backend holds the platform UI. The
  extension keeps its agents and gains hooks into the platform.
- **Stack:** Fastify + Knex + PostgreSQL on the server, React + Vite on the web,
  TypeScript throughout.
- **Schema timing:** the complete database schema for all five sub-projects is
  created in this sub-project. Later sub-projects add API and UI on top of existing
  tables, and add a corrective migration only if a table proves wrong.

## 3. Goal and success criteria

After this sub-project:

- `docker compose up -d` starts PostgreSQL; `npm run db:migrate` creates every
  table in section 6; `npm run db:rollback` removes them; `npm run db:seed`
  creates the first admin.
- A user can sign in to the web app, create a project, find it in the list, open
  its dashboard, edit it, and archive it. Each action writes an audit row.
- Role rules in section 8 are enforced by the API, not only by the UI.
- The extension can store a platform URL, sign in, and show the signed-in user.
- Planner, Generator, Recorder, Healer, and both run paths in the extension behave
  exactly as before.

## 4. Out of scope

API and UI for scripts, skills, Jenkins, executions, results, reports, and healing.
Their tables exist but nothing reads or writes them yet. `PlaywrightBridge` and
`PlaywrightOrchestrator` are not modified.

## 5. Layout

```
PlaywrightPlatform/
  package.json              npm workspaces: server, web
  docker-compose.yml        postgres:16; pgadmin under the "tools" profile
  .env.example
  .gitignore                .env, node_modules, dist
  server/
    knexfile.ts
    migrations/             one file per domain, see section 6
    seeds/                  first admin
    src/
      app.ts                builds the Fastify instance (used by tests)
      server.ts             reads config, starts listening
      config.ts             env parsing with Zod; fails fast on missing values
      db.ts                 Knex instance
      plugins/              auth, rbac, csrf, error-handler, rate-limit, logger
      routes/               HTTP only: validate, call a service, shape response
      services/             AuthService, UserService, ProjectService, AuditService
      repositories/         the only code that issues queries
      schemas/              Zod request and response schemas
    test/
  web/
    src/
      api/                  typed fetch client; the only code that calls the API
      pages/                Login, Projects, ProjectDashboard, Users
      components/           AppShell, Sidebar, ConfirmDialog, StatusBadge, ...
    e2e/                    Playwright tests
```

Layering rule: routes never import repositories or Knex; services never touch
`request`/`reply`; React components never call `fetch` directly. Repositories
return plain objects, so replacing PostgreSQL means rewriting `repositories/` and
migrations only.

In development Vite serves the web app on 5173 and proxies `/api` to the server on
`APP_PORT` (default 3000). In production the server serves `web/dist` itself, so
web and API share one origin.

## 6. Database schema

Conventions for every table:

- `id` is `bigint generated always as identity`.
- Timestamps are `timestamptz`, default `now()`.
- Status-like columns are `text` with a `CHECK` constraint listing allowed values.
- Foreign keys use `ON DELETE RESTRICT`. Nothing is hard-deleted; history is
  protected by soft deletion and status values.
- `created_by`, `updated_by`, `deleted_by`, `reviewed_by`, `triggered_by` reference
  `users(id)` and are nullable for system actions.

### 6.1 Identity and audit (migration 001)

**users** — `email` (unique on `lower(email)`), `display_name`, `password_hash`,
`role` (ADMIN | USER | VIEWER), `status` (ACTIVE | DISABLED), `last_login_at`,
`created_at`, `updated_at`.

**sessions** — `user_id`, `token_hash` (unique; SHA-256 of an opaque random
token), `kind` (WEB | EXTENSION), `csrf_secret`, `expires_at`, `revoked_at`,
`last_used_at`, `created_at`. Index on `user_id`.

**audit_logs** — `user_id` (nullable), `user_email` (copied, so the row survives
later changes), `action`, `resource`, `resource_id` (text), `result`
(SUCCESS | FAILURE), `ip`, `details` (jsonb), `created_at`. Indexes on
`(resource, resource_id)`, `created_at`, `user_id`.

### 6.2 Projects (migration 002)

**projects** — `name`, `description`, `status` (ACTIVE | ARCHIVED | DELETED),
`auto_use_skills` (boolean, default true), `created_by`, `created_at`,
`updated_at`, `deleted_at`, `deleted_by`. Partial unique index on `lower(name)`
where `status <> 'DELETED'`. Index on `status`.

**project_environments** — `project_id`, `name` (DEV | QA | UAT | STAGING |
PRODUCTION), `base_url`, `created_at`, `updated_at`. Unique `(project_id, name)`.

### 6.3 Scripts (migration 003)

**test_scripts** — `project_id`, `name`, `description`, `test_scenario`,
`script_content` (always the content of the latest version), `language`,
`framework`, `script_type`, `version` (latest version number), `status`
(ACTIVE | ARCHIVED | DELETED), `lifecycle_state` (DRAFT | GENERATED | SAVED |
VALIDATED | READY | RUNNING | PASSED | FAILED | HEALING), `created_by`,
`updated_by`, `created_at`, `updated_at`, `deleted_at`, `deleted_by`. Partial
unique index on `(project_id, lower(name))` where `status <> 'DELETED'`. Index on
`(project_id, status)`.

**test_script_versions** — `script_id`, `version`, `script_content`,
`change_summary`, `source` (MANUAL | GENERATED | RECORDED | IMPORTED | HEALED |
RESTORED), `created_by`, `created_at`. Unique `(script_id, version)`. Rows are
never updated.

**tags** — `name`, unique on `lower(name)`.

**script_tags** — `script_id`, `tag_id`; primary key on both.

### 6.4 Skills (migration 004)

**skills** — `name`, `description`, `scope` (GLOBAL | PROJECT), `project_id`
(required when scope is PROJECT, null when GLOBAL, enforced by `CHECK`),
`file_name`, `content` (latest version), `version`, `status` (ACTIVE | ARCHIVED),
`created_by`, `updated_by`, `created_at`, `updated_at`. Index on
`(scope, status)` and `project_id`.

**skill_versions** — `skill_id`, `version`, `content`, `change_summary`,
`created_by`, `created_at`. Unique `(skill_id, version)`.

**skill_tags** — `skill_id`, `tag_id`; primary key on both.

**project_skills** — `project_id`, `skill_id`, `enabled`, `priority` (integer,
lower runs first), `created_at`. Primary key `(project_id, skill_id)`. Index on
`(project_id, priority)`.

**script_skills** — `script_id`, `script_version`, `skill_id`, `skill_version`.
Primary key on all four. `script_version` is added to the fields listed in
`Req.md` because the requirement that each new script version records the skill
versions it was produced with cannot be met without it.

### 6.5 CI and execution (migration 005)

**jenkins_configurations** — `name` (unique), `base_url`, `username`,
`credential_reference` (name of an environment variable holding the token, or
null), `secret_ciphertext` (AES-256-GCM encrypted token, or null), `job_name`,
`folder`, `enabled`, `created_at`, `updated_at`. `CHECK` that at least one of
`credential_reference` and `secret_ciphertext` is set. No plaintext secret column
exists.

**project_ci_jobs** — `project_id`, `jenkins_configuration_id`, `job_name`,
`folder`, `enabled`, `created_at`. Unique
`(project_id, jenkins_configuration_id, job_name, folder)`. This is what
`test_executions.jenkins_job_id` references.

**test_executions** — `project_id`, `script_id` (nullable; null for a
multi-script run), `script_version` (nullable), `jenkins_job_id` (nullable),
`jenkins_build_number`, `jenkins_queue_id`, `ci_provider` (default JENKINS),
`trigger_type` (MANUAL | JENKINS | SCHEDULED | API), `status` (QUEUED | RUNNING |
PASSED | FAILED | ABORTED | ERROR), `stage` (QUEUED | STARTING | RUNNING |
TEST_EXECUTION | GENERATING_REPORT | COMPLETED), `environment`, `browser`, `tags`
(text array), `total_tests`, `passed_tests`, `failed_tests`, `skipped_tests`,
`report_url`, `error_message`, `callback_token_hash`, `triggered_by`,
`started_at`, `completed_at`, `duration` (milliseconds), `created_at`. Indexes on
`(project_id, created_at desc)`, `status`, `script_id`.

**execution_scripts** — `execution_id`, `script_id`, `script_version`. Primary key
on all three. Lists every script in a run, including single-script runs.

**execution_results** — `execution_id`, `script_id` (nullable), `test_name`,
`status` (PASSED | FAILED | SKIPPED), `duration`, `error_message`, `stack_trace`,
`screenshot_path`, `video_path`, `trace_path`, `created_at`. Index on
`execution_id`.

**execution_logs** — `execution_id`, `level`, `message`, `created_at`. Index on
`(execution_id, created_at)`.

**execution_skill_snapshots** — `execution_id`, `skill_id`, `skill_version`,
`skill_name`. Primary key `(execution_id, skill_id)`.

### 6.6 Healing (migration 006)

**healing_proposals** — `script_id`, `base_version`, `execution_id` (nullable),
`proposed_content`, `summary`, `status` (PENDING | ACCEPTED | REJECTED),
`resulting_version` (set on accept), `created_by`, `reviewed_by`, `created_at`,
`reviewed_at`. Index on `(script_id, status)`.

### 6.7 Migrations and seed

Six migration files, one per subsection above, each with `up` and `down`. The
`down` functions drop tables in reverse dependency order. Scripts:
`db:migrate`, `db:rollback`, `db:seed`.

The seed creates one ADMIN user from `ADMIN_EMAIL` and `ADMIN_PASSWORD` if no
user with that email exists. If either variable is missing the seed fails with a
clear message. No default password exists in code.

## 7. API

All routes are under `/api`. Every request body, query, params object, and
response is validated against a Zod schema.

| Method | Path | Role | Behaviour |
|---|---|---|---|
| GET | `/health` | public | Process up and database reachable |
| POST | `/auth/login` | public | Body `{email, password, client}` where client is `web` or `extension`. Web: sets session cookie, returns user and CSRF token. Extension: returns user and bearer token |
| POST | `/auth/logout` | any signed-in | Revokes the current session |
| GET | `/auth/me` | any signed-in | Current user and, for web, a CSRF token |
| GET | `/projects` | any signed-in | Query `search`, `status` (default ACTIVE), `page`, `pageSize`. Each item includes `scriptCount` and `lastRunStatus` (0 and null until later sub-projects populate the tables) |
| POST | `/projects` | ADMIN | Body `{name, description}`. 409 on duplicate live name |
| GET | `/projects/:id` | any signed-in | Project plus overview counters |
| PUT | `/projects/:id` | ADMIN | Name, description, status ACTIVE or ARCHIVED |
| DELETE | `/projects/:id` | ADMIN | Soft delete: status DELETED, `deleted_at`, `deleted_by` |
| GET | `/users` | ADMIN | List users (never includes `password_hash`) |
| POST | `/users` | ADMIN | Body `{email, displayName, password, role}`. 409 on duplicate email |
| PUT | `/users/:id` | ADMIN | Change `displayName`, `role`, `status`, or `password`. Disabling a user or changing the password revokes that user's sessions. An ADMIN cannot disable or demote the last active ADMIN |

Deleted projects return 404 from `GET /projects/:id` and are excluded from lists
unless `status=DELETED` is requested by an ADMIN.

Error responses always have the shape `{ "error": { "code", "message", "details" } }`
with status 400 (validation), 401, 403, 404, 409, 429, or 500. A 500 returns a
generic message and a request ID; the stack trace goes to the server log only.

## 8. Security

**Passwords.** argon2id via the `argon2` package. Login failures return the same
message whether the email exists or not.

**Sessions.** An opaque 256-bit random token; only its SHA-256 hash is stored.
Web sessions travel in a cookie that is `HttpOnly`, `SameSite=Strict`, and
`Secure` when `NODE_ENV=production`, with an 8-hour lifetime. Extension sessions
travel as `Authorization: Bearer` with a 30-day lifetime. Logout revokes the row.

**CSRF.** Cookie-authenticated requests that change state must send an
`X-CSRF-Token` header matching the session's CSRF secret. Bearer requests are
exempt because the browser does not attach the token automatically.

**Roles.** Enforced by a route-level guard in `plugins/rbac.ts`.

| Action | ADMIN | USER | VIEWER |
|---|---|---|---|
| View projects | yes | yes | yes |
| Create, edit, archive, delete project | yes | no | no |
| List, create, edit users | yes | no | no |

USER gains script and run permissions when those sub-projects are built.

**Input and queries.** Zod on all input. Knex parameter binding only; no string
concatenation into SQL. Search input is escaped for `ILIKE` wildcards.

**Rate limiting.** `@fastify/rate-limit`: 10 login attempts per 15 minutes per
IP, 300 requests per minute per session elsewhere.

**CORS.** Allowlist from `CORS_ORIGINS` (the web origin in development and the
extension origin). No wildcard.

**Headers.** `@fastify/helmet` with a content security policy for the served web
app.

**Secrets.** `SECRETS_ENCRYPTION_KEY` (32 bytes, base64) is required at startup
and reserved for encrypting Jenkins tokens in sub-project 4. Pino redacts
`authorization`, `cookie`, `password`, `token`, and `secret` fields. `.env` is
gitignored.

**Audit.** `AuditService.record` is called by services for login success and
failure, logout, project create, update, archive, and delete, and user create and
update, recording user, action, resource, resource ID, IP, and result.

## 9. Web app

- **Login** — email and password; shows the server's error message on failure.
- **App shell** — sidebar following `Req.md` section 54: Dashboard, Projects,
  Playwright Agents, CI/CD, Reports, Skills, Settings. Projects and Settings are
  active in this sub-project; the others are visible and disabled with a "coming
  soon" hint. Header shows the signed-in user, role, and sign-out.
- **Settings → Users** (ADMIN only) — table of users with role and status; create
  user dialog; edit role, status, and password. Without this the USER and VIEWER
  roles could not be assigned to anyone.
- **Projects** — table with name, script count, last run, status; search box,
  refresh, and status filter. "Create Project" opens a dialog with name and
  description and inline validation. Row actions (ADMIN only): edit, archive,
  delete, each destructive one behind a confirmation dialog. Successful create
  navigates to the project dashboard.
- **Project dashboard** — header with name and status, overview counters (total
  scripts, passed, failed, not executed, last execution), and tabs for Scripts,
  Executions, CI/CD, Reports, Skills, Settings. Tabs other than the overview show
  an empty state until their sub-project is built.

Loading, empty, and error states are implemented for every data view. Controls a
role cannot use are hidden, and the API still enforces the rule.

## 10. Extension changes

- New `utils/platform-client.js`: `login`, `logout`, `me`, `listProjects`, using
  `fetch` with the bearer token. It is the only extension file that knows the
  platform API.
- `utils/storage.js`: `getPlatform()` and `savePlatform()` for
  `{ url, token, user }` under a new key `pas_platform`. Existing keys are
  unchanged.
- Settings panel in `sidepanel.html` / `sidepanel.js`: a "Platform" block with
  URL, email, password, Sign in / Sign out, and a connection status line. The
  password is never stored.

No agent, provider, recorder, runner, or Bridge code changes. If the platform is
not configured the extension works exactly as today.

## 11. Configuration

`.env.example`:

```
DATABASE_URL=postgresql://playwright:change-me@localhost:5432/playwright_db
POSTGRES_USER=playwright
POSTGRES_PASSWORD=change-me
POSTGRES_DB=playwright_db
APP_PORT=3000
NODE_ENV=development
CORS_ORIGINS=http://localhost:5173
SECRETS_ENCRYPTION_KEY=
ADMIN_EMAIL=
ADMIN_PASSWORD=
JENKINS_URL=http://localhost:8080
JENKINS_USERNAME=
JENKINS_API_TOKEN=
```

The Jenkins variables are listed for completeness and are not read until
sub-project 4. `config.ts` exits with a list of missing or invalid variables.

## 12. Observability

Pino JSON logs with a request ID on every line. Services log domain events with
a tag, for example `[PROJECT] Created project 101`, `[AUTH] Login failed`.

## 13. Testing

**Server (Vitest, Fastify `inject`, real PostgreSQL from Docker, a separate test
database migrated before the run):**

- Migrations: migrate up creates every table in section 6; rollback removes them.
- Auth: login success and failure, session expiry, logout revocation, bearer and
  cookie paths, CSRF rejection.
- RBAC: every project and user route against each of the three roles and against
  no session.
- Projects: create, duplicate name conflict, name reuse after delete, list search
  and status filter, update, archive, soft delete, 404 after delete.
- Users: create, duplicate email conflict, role change, disable revokes sessions,
  last-admin protection, `password_hash` never present in a response.
- Audit: a row is written for each audited action with the correct result.
- Validation: malformed bodies return 400 in the standard error shape.
- Errors: an unexpected exception returns 500 without a stack trace.

**Web (Playwright, against the running server and database):** sign in, create a
project, land on its dashboard, find it by search, archive it with confirmation;
a VIEWER sees no create or row actions.

**Extension (manual, recorded in the plan as a checklist):** load unpacked, run
Planner and Generator on the mock provider, record and replay a short flow, then
sign in to the platform from Settings and confirm the status line.

## 14. Risks

- **Full schema before features.** Tables for sub-projects 2 to 5 are designed
  ahead of their code. Any change is made by a new migration, never by editing a
  shipped one.
- **Port 8080.** Something answers on `localhost:8080` on the development machine
  but `/login` returns 404, so it may not be Jenkins. This must be resolved before
  sub-project 4 and does not affect this one.
- **Extension origin.** An unpacked extension's ID differs per machine, so
  `CORS_ORIGINS` must be set per installation. The README will explain where to
  find the ID.
