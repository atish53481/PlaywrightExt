# Platform Scripts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the database the home of Playwright scripts: a project member can create, import, edit, version, compare, restore, tag, search, duplicate, download, and delete scripts in the web app, and save a script from the extension's Generator, Recorder, or Orchestrator into a project.

**Architecture:** Eleven Fastify routes call one new `ScriptService`, which uses a `ScriptRepository` and a `TagRepository` over tables that already exist. Every write runs in one transaction together with its audit row and locks the script row before reading its version. The web app gains a Scripts tab and three lazily loaded pages built on two CodeMirror wrapper components. The extension gains one client method, one pure helper module, three buttons, and one dialog.

**Tech Stack:** Node 24, TypeScript, Fastify 5, Knex 3, PostgreSQL 16, Zod 3, Vitest; React 18, Vite, React Router 6 (data router), CodeMirror 6, Playwright Test; vanilla JS MV3 extension tested with `node --test`.

**Spec:** `docs/superpowers/specs/2026-10-03-platform-scripts-design.md`

## Global Constraints

- All work happens in the `PlaywrightExt` repo on branch `feat/platform-scripts`. All paths below are relative to that repo root. Commands run from `PlaywrightPlatform/` unless a step says otherwise.
- Do not modify `PlaywrightBridge/` or `PlaywrightOrchestrator/`. In `PlaywrightExtension/` touch only `utils/platform-client.js`, `utils/code-extract.js` (new), `tests/`, `sidepanel.html`, and `sidepanel.js`. No agent, provider, recorder, runner, or Bridge code changes.
- No database migration. If one proves necessary it is a new migration file, never an edit to a shipped one.
- Server layering: files in `routes/` never import from `repositories/` or `knex`; files in `services/` never import Fastify's request or reply; only `repositories/` and `migrations/` issue queries. SQL goes through Knex parameter binding.
- Web layering: only files in `web/src/api/` call `fetch`; only `web/src/components/CodeEditor.tsx` and `web/src/components/CodeDiff.tsx` import CodeMirror.
- Every route validates body, query, and params with Zod (`parse`) and every JSON response with Zod (`shape`). Error responses always look like `{ "error": { "code", "message", "details" } }`.
- Each write runs in one `Transact` together with its audit row. A write that reads the script's version first locks the script row before reading it.
- Script content is never written to an audit row or a log line. The server never executes, imports, or evaluates it.
- Limits, exactly: name 1–200 characters; description up to 2,000; test scenario up to 5,000; content 1 to 1,000,000 characters; change summary up to 500; at most 20 tags per script, each 1–40 characters of letters, digits, spaces, and `- _ . @`; request body up to 2 MB on the create and update routes only; list `pageSize` 1–100, default 25; `/tags` returns at most 50 names.
- Error codes, exactly: 400 `VALIDATION_ERROR`, 403 `FORBIDDEN`, 404 `NOT_FOUND`, 409 `SCRIPT_NAME_TAKEN`, 409 `VERSION_CONFLICT` (details `{ currentVersion, updatedBy }`), 409 `ALREADY_CURRENT`, 409 `PROJECT_NOT_ACTIVE`, 413 `PAYLOAD_TOO_LARGE`.
- Roles: ADMIN and USER may write (`writers` guard); VIEWER may read and download (`signedIn` guard).
- Audit actions: `script.create`, `script.update` (metadata only), `script.version` (new content), `script.restore`, `script.duplicate`, `script.delete`.
- In the extension, every piece of text that came from the server is written with `textContent`, never `innerHTML`.
- The server package is CommonJS: relative imports have no file extension.
- Vitest and the Playwright E2E run both rebuild `playwright_db_test`. Never run them at the same time. New server test files build their app with `makeApp({ RATE_LIMIT_MAX: '100000' })`: they send more requests per minute than the default limit of 300 allows.

## Decisions Made in This Plan

The spec is silent or imprecise on these points. Each is decided here so the tasks are unambiguous.

1. **Line endings.** Content is stored with `\n` line endings: `\r\n` and lone `\r` are converted when a script is created or updated. Without this, a script pasted on Windows looks modified the moment the editor opens it, and saving it unchanged creates a version.
2. **View and Edit are two modes of one page.** `/scripts/:id` is read-only for everyone; `/scripts/:id?edit=1` is the edit mode for ADMIN and USER. The row actions "View" and "Edit" open these.
3. **The router becomes a data router.** `main.tsx` switches from `<BrowserRouter>` to `createBrowserRouter` with one catch-all route that renders the existing `<Routes>` tree. React Router's `useBlocker`, needed for "leaving with unsaved changes asks for confirmation", only works in a data router.
4. **Two more web dependencies are declared:** `@codemirror/state` and `@codemirror/view`. The wrappers import from them directly; both are already installed as dependencies of `codemirror`, so nothing new enters the bundle.
5. **The conflict comparison has a third button, "Keep my text".** It re-bases the typed text on the latest version so the next Save succeeds. "Reload latest" and "Compare with latest" alone leave no way to keep the text.
6. **Downloads in the web app go through `fetch` and a Blob**, not a bare link, so that an expired session or a deleted script shows a message instead of saving an error page.
7. **Extension "no code yet" message.** The spec says "the same message the Copy button shows today", but the Copy button shows none. The plan uses the messages the Run buttons already show: "Generate code first", "Record some actions first", and "Run the pipeline first".
8. **`extractCode` prefers code blocks.** When panel output has fenced blocks, blocks tagged as TypeScript or JavaScript (or untagged) are joined; blocks tagged as anything else (for example `bash`) are skipped unless they are the only blocks. For the Orchestrator, only the text after its `## GENERATED CODE` heading is used.
9. **Files outside the spec's change list:** `plugins/error-handler.ts` (maps 413 to `PAYLOAD_TOO_LARGE`), `repositories/sql.ts` (shared `escapeLike`, moved out of `project-repository.ts`), `hooks/useDebounced.ts` (moved out of `ProjectsPage.tsx`), `api/client.ts` (`apiDownload`, and `errorMessage` now shows the first validation problem), `scripts/e2e-serve.ts` (a USER account and a high rate limit for browser tests).
10. **Small rules:** tags come back in alphabetical order; a duplicate's default name is cut so that the name plus ` (copy)` fits in 200 characters; a download file name is lower-case, at most 80 characters before `.spec.ts`, and `script` when nothing usable remains; the web app hides write controls in an archived project, since the API refuses those writes.

## Review Focus

Inputs and conditions the spec implies but does not spell out, each pinned by a test in the task that owns the code:

1. **Windows line endings.** A script created with `\r\n` is stored with `\n`; saving the same text again creates no version; an imported CRLF file opens without unsaved changes. (Tasks 1, 3, 6)
2. **The same new tag saved by several requests at once, or in different capitalisation.** Every request succeeds, one tag row exists, and no request fails with a deadlock or a duplicate-key error. (Task 1)
3. **Content inside the character limit whose JSON encoding is large.** 1,000,000 characters that all need escaping are accepted; content that pushes the body past 2 MB is refused with 413 `PAYLOAD_TOO_LARGE` rather than a generic error. (Task 1)
4. **Hostile or non-Latin script names in a download.** Quotes, path separators, line breaks, and non-ASCII letters never reach the `Content-Disposition` header; the file name is always safe and never empty. (Task 4)
5. **An extension panel that holds an error line, a spinner, or its placeholder.** "Save to Project" refuses instead of storing that text as a script. (Task 8)

## Known Limitations (not built by this plan)

- If the web session ends while the editor has unsaved text, the next Save sends the user to the sign-in page and the text is lost. Sessions last 8 hours.
- The extension side panel cannot be driven by an automated test. Task 9 lists the manual checks; the foundation's Settings → Platform block is in the same list because it is still unverified.
- Deleted scripts can be listed by an ADMIN through the API (`status=DELETED`); there is no screen for them and no way to restore one.
- This branch is cut from `feat/platform-foundation`, which is not merged. If that branch changes before it is merged, this one is rebased onto it.

## What Was Checked While Writing This Plan

- Assembled in a scratch copy outside the repo, the server code of Tasks 1–4 passes `tsc --noEmit`, and every edit instruction in those tasks found its anchor in the current files.
- The web code of Tasks 5–7 passes `tsc --noEmit` the same way, except `CodeEditor.tsx` and `CodeDiff.tsx`: CodeMirror is not installed until Task 6, Step 1, so those two files have not been compiled.
- The extension helper code of Task 8, applied to a scratch copy, passes all 31 tests under `node --test`.
- Nothing that needs the database or a browser has been run: no Vitest test and no Playwright test. Every "run to verify it fails" and "run to verify it passes" step is still required, and a step whose result differs from its `Expected:` line is a finding, not a formality.

---

## File Map

```
PlaywrightPlatform/
  README.md                                  + scripts section, roles, API table        (Task 9)
  server/src/
    types.ts                                 + script types                             (Task 1)
    app.ts                                   + ScriptService, scriptRoutes              (Task 1)
    plugins/auth.ts                          + writers guard                            (Task 1)
    plugins/error-handler.ts                 + 413 → PAYLOAD_TOO_LARGE                  (Task 1)
    repositories/index.ts                    + scripts, tags in Repos                   (Task 1)
    repositories/sql.ts                      escapeLike (new)                           (Task 2)
    repositories/project-repository.ts       imports escapeLike                         (Task 2)
    repositories/script-repository.ts        test_scripts + test_script_versions (new)  (Tasks 1–4)
    repositories/tag-repository.ts           tags + script_tags (new)                   (Tasks 1–2)
    schemas/scripts.ts                       Zod schemas and DTO mapping (new)          (Tasks 1–4)
    services/script-service.ts               all script rules (new)                     (Tasks 1–4)
    routes/scripts.ts                        the eleven routes (new)                    (Tasks 1–4)
    scripts/e2e-serve.ts                     + USER account, high rate limit            (Task 5)
  server/test/
    script-helpers.ts                        shared helpers (new)                       (Task 1)
    scripts.test.ts                          create, read                               (Task 1)
    script-list.test.ts                      list, search, tags                         (Task 2)
    script-update.test.ts                    update, concurrency, delete                (Task 3)
    script-versions.test.ts                  versions, restore, duplicate, download     (Task 4)
  web/src/
    main.tsx                                 data router                                (Task 6)
    App.tsx                                  + three lazy routes                        (Tasks 6–7)
    styles.css                               + chips, pager, editor, notices            (Tasks 5–6)
    download.ts                              saveTextFile (new)                         (Task 5)
    importFile.ts                            readScriptFile (new)                       (Task 5)
    api/types.ts                             + script types                             (Task 5)
    api/client.ts                            + apiDownload, better errorMessage         (Task 5)
    api/scripts.ts                           scriptsApi (new)                           (Task 5)
    hooks/useDebounced.ts                    moved from ProjectsPage (new)              (Task 5)
    hooks/useUnsavedGuard.tsx                leave-page confirmation (new)              (Task 6)
    components/CodeEditor.tsx                CodeMirror editor wrapper (new)            (Task 6)
    components/CodeDiff.tsx                  CodeMirror merge wrapper (new)             (Task 6)
    components/TagInput.tsx                  tag chips with autocomplete (new)          (Task 6)
    pages/ProjectDashboardPage.tsx           ?tab= and the Scripts tab                  (Task 5)
    pages/ProjectsPage.tsx                   imports useDebounced                       (Task 5)
    pages/ScriptsTab.tsx                     list, search, row actions (new)            (Task 5)
    pages/NewScriptPage.tsx                  create and import (new)                    (Task 6)
    pages/ScriptPage.tsx                     view, edit, conflict handling (new)        (Task 6)
    pages/ScriptVersionsPage.tsx             history, compare, restore (new)            (Task 7)
  web/e2e/
    helpers.ts                               + USER, API helpers, setEditorText         (Tasks 5–6)
    scripts-tab.spec.ts                      (new)                                      (Task 5)
    script-editor.spec.ts                    (new)                                      (Task 6)
    script-versions.spec.ts                  (new)                                      (Task 7)
PlaywrightExtension/
  utils/platform-client.js                   + saveScript                               (Task 8)
  utils/code-extract.js                      extractCode, sectionAfter, looksLikeCode   (Task 8)
  tests/platform-client.test.mjs             + saveScript tests                         (Task 8)
  tests/code-extract.test.mjs                (new)                                      (Task 8)
  sidepanel.html                             + three buttons, one dialog                (Task 8)
  sidepanel.js                               + setupSaveToProject                       (Task 8)
CLAUDE.md                                    + one Extension bullet                     (Task 9)
```

Task order: 1 → 2 → 3 → 4 (server), then 5 → 6 → 7 (web), then 8 (extension), then 9. Tasks 5–8 need the API from Tasks 1–4.

---

### Task 1: Create and read scripts

**Files:**
- Create: `PlaywrightPlatform/server/src/repositories/script-repository.ts`, `PlaywrightPlatform/server/src/repositories/tag-repository.ts`, `PlaywrightPlatform/server/src/schemas/scripts.ts`, `PlaywrightPlatform/server/src/services/script-service.ts`, `PlaywrightPlatform/server/src/routes/scripts.ts`, `PlaywrightPlatform/server/test/script-helpers.ts`
- Modify: `PlaywrightPlatform/server/src/types.ts`, `PlaywrightPlatform/server/src/repositories/index.ts`, `PlaywrightPlatform/server/src/plugins/auth.ts`, `PlaywrightPlatform/server/src/plugins/error-handler.ts`, `PlaywrightPlatform/server/src/app.ts`
- Test: `PlaywrightPlatform/server/test/scripts.test.ts`

**Interfaces:**
- Consumes: `Db`, `isUniqueViolation`, `AppError`, `notFound`, `AuditService.record(entry, repo)`, `Transact`, `Repos`, `ProjectRepository.findLiveById(id)`, `Actor`, `signedIn`, `actorOf`, `idParams`, `cleanText`, `parse`, `shape`
- Produces:
  - Types in `types.ts`: `ScriptLanguage`, `ScriptType`, `ScriptStatus`, `ScriptLifecycleState`, `ScriptVersionSource`, `ScriptSummary`, `Script extends ScriptSummary { testScenario; content }`, `ScriptVersionSummary`, `ScriptVersion extends ScriptVersionSummary { content }`
  - `writers` guard in `plugins/auth.ts` (ADMIN and USER)
  - `Repos.scripts: ScriptRepository`, `Repos.tags: TagRepository`
  - `ScriptRepository.findLive(id): Promise<Script | null>`, `.create(input: NewScript): Promise<number>`, `.insertVersion(input: NewScriptVersion): Promise<void>`; `isScriptNameClash(err): boolean`
  - `TagRepository.setForScript(scriptId, names): Promise<void>`
  - `ScriptService.get(id): Promise<Script>`, `.create(actor, projectId, input: CreateScriptInput): Promise<Script>`; module helpers `projectNotActive()`, `nameTaken(name)`, `found(script)`; private `record(actor, action, id, details, repo)`
  - In `schemas/scripts.ts`, module-level consts later tasks reuse: `id`, `versionNumber`, `name`, `description`, `testScenario`, `changeSummary`, `content`, `tags`, `scriptListItemDto`; exports `projectScriptsParams`, `createScriptBody`, `scriptResponse`, `toScriptListItemDto`, `toScriptDto`
  - Routes: `POST /api/projects/:projectId/scripts` (201) → `{ script }`; `GET /api/scripts/:id` → `{ script }`
  - Test helpers in `test/script-helpers.ts`: `SAMPLE`, `newProject(ctx, headers, name?)`, `postScript(ctx, headers, projectId, payload?)`, `newScript(ctx, headers, projectId, payload?)`, `breakAudit(db)`, `repairAudit(db)`

- [ ] **Step 1: Write the test helpers**

`PlaywrightPlatform/server/test/script-helpers.ts`:

```ts
import type { Db } from '../src/db';
import type { TestContext } from './helpers';

type Headers = Record<string, string>;

/** A small but realistic script body. */
export const SAMPLE = `import { test, expect } from '@playwright/test';

test('login', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle(/Login/);
});
`;

export interface ScriptJson {
  id: number;
  projectId: number;
  name: string;
  version: number;
  content: string;
  tags: string[];
  [key: string]: unknown;
}

/** Creates a project through the API. `headers` must belong to an ADMIN. */
export async function newProject(ctx: TestContext, headers: Headers, name = 'Shop'): Promise<number> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name } });
  if (res.statusCode !== 201) throw new Error(`project create failed: ${res.statusCode} ${res.body}`);
  return res.json().project.id;
}

/** POSTs a script with sensible defaults; `payload` overrides or adds fields. Returns the raw response. */
export function postScript(
  ctx: TestContext,
  headers: Headers,
  projectId: number,
  payload: Record<string, unknown> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/scripts`,
    headers,
    payload: { name: 'Login Test', content: SAMPLE, ...payload },
  });
}

/** Like postScript, but throws unless the script was created, and returns it. */
export async function newScript(
  ctx: TestContext,
  headers: Headers,
  projectId: number,
  payload: Record<string, unknown> = {},
): Promise<ScriptJson> {
  const res = await postScript(ctx, headers, projectId, payload);
  if (res.statusCode !== 201) throw new Error(`script create failed: ${res.statusCode} ${res.body}`);
  return res.json().script;
}

/** Makes every audit insert fail, to prove that a change and its audit row commit together. */
export function breakAudit(db: Db) {
  return db.raw(`
    create or replace function test_fail_audit() returns trigger as $$
    begin raise exception 'audit store unavailable'; end; $$ language plpgsql;
    create trigger test_fail_audit before insert on audit_logs
      for each row execute function test_fail_audit();
  `);
}

export function repairAudit(db: Db) {
  return db.raw(`
    drop trigger if exists test_fail_audit on audit_logs;
    drop function if exists test_fail_audit();
  `);
}
```

- [ ] **Step 2: Write the failing tests**

`PlaywrightPlatform/server/test/scripts.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';
import { SAMPLE, breakAudit, newProject, newScript, postScript, repairAudit } from './script-helpers';

describe('scripts: create and read', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;
  let projectId: number;

  beforeAll(async () => {
    // Script tests send more requests per minute than the default limit allows.
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await repairAudit(ctx.db);
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN', displayName: 'Ada Admin' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    projectId = await newProject(ctx, asAdmin);
  });
  afterEach(() => repairAudit(ctx.db));

  const get = (id: number | string, headers = asAdmin) =>
    ctx.app.inject({ method: 'GET', url: `/api/scripts/${id}`, headers });
  const setProject = (payload: object) =>
    ctx.app.inject({ method: 'PUT', url: `/api/projects/${projectId}`, headers: asAdmin, payload });

  it('creates the script and its first version', async () => {
    const res = await postScript(ctx, asAdmin, projectId, {
      description: 'Signs in',
      testScenario: 'Open login, sign in, land on the dashboard',
      tags: ['smoke'],
    });
    expect(res.statusCode).toBe(201);
    const script = res.json().script;
    expect(script).toMatchObject({
      projectId,
      name: 'Login Test',
      description: 'Signs in',
      testScenario: 'Open login, sign in, land on the dashboard',
      content: SAMPLE,
      language: 'TypeScript',
      framework: 'Playwright',
      scriptType: 'E2E',
      version: 1,
      status: 'ACTIVE',
      lifecycleState: 'SAVED',
      tags: ['smoke'],
      updatedBy: 'Ada Admin',
    });
    expect(script.id).toBeGreaterThan(0);
    expect(new Date(script.createdAt).getTime()).not.toBeNaN();
    expect(new Date(script.updatedAt).getTime()).not.toBeNaN();

    const row = await ctx.db('test_scripts').where({ id: script.id }).first();
    expect(row).toMatchObject({ created_by: admin.id, updated_by: admin.id, version: 1, script_content: SAMPLE });
    const versions = await ctx.db('test_script_versions').where({ script_id: script.id });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      script_content: SAMPLE,
      source: 'MANUAL',
      change_summary: '',
      created_by: admin.id,
    });
  });

  it('applies defaults and trims text fields', async () => {
    const res = await postScript(ctx, asAdmin, projectId, { name: '  Checkout  ', description: '  spaced  ' });
    expect(res.statusCode).toBe(201);
    expect(res.json().script).toMatchObject({
      name: 'Checkout',
      description: 'spaced',
      testScenario: '',
      tags: [],
      language: 'TypeScript',
      scriptType: 'E2E',
    });
  });

  it('records language, type, source, and change summary', async () => {
    const res = await postScript(ctx, asAdmin, projectId, {
      language: 'JavaScript',
      scriptType: 'API',
      source: 'GENERATED',
      changeSummary: 'From the generator',
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().script).toMatchObject({ language: 'JavaScript', scriptType: 'API' });
    const version = await ctx.db('test_script_versions').first();
    expect(version).toMatchObject({ source: 'GENERATED', change_summary: 'From the generator' });
  });

  it('accepts only the sources a client may claim', async () => {
    for (const source of ['MANUAL', 'GENERATED', 'RECORDED', 'IMPORTED']) {
      expect((await postScript(ctx, asAdmin, projectId, { name: `From ${source}`, source })).statusCode).toBe(201);
    }
    for (const source of ['RESTORED', 'HEALED', 'NOPE']) {
      expect((await postScript(ctx, asAdmin, projectId, { name: `From ${source}`, source })).statusCode).toBe(400);
    }
  });

  it('stores content with unix line endings whatever the client sent', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { content: 'one\r\ntwo\rthree\n' });
    expect(script.content).toBe('one\ntwo\nthree\n');
    const version = await ctx.db('test_script_versions').first();
    expect(version.script_content).toBe('one\ntwo\nthree\n');
  });

  it('rejects a name already used in the project, ignoring case, and allows it in another project', async () => {
    await newScript(ctx, asAdmin, projectId, { name: 'Login Test' });
    const clash = await postScript(ctx, asAdmin, projectId, { name: '  login test ' });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({
      code: 'SCRIPT_NAME_TAKEN',
      message: 'A script named "login test" already exists in this project.',
    });
    expect(await ctx.db('test_scripts')).toHaveLength(1);
    expect(await ctx.db('test_script_versions')).toHaveLength(1);

    const other = await newProject(ctx, asAdmin, 'Other');
    expect((await postScript(ctx, asAdmin, other, { name: 'Login Test' })).statusCode).toBe(201);
  });

  it('accepts every text field at its limit', async () => {
    const res = await postScript(ctx, asAdmin, projectId, {
      name: 'n'.repeat(200),
      description: 'd'.repeat(2000),
      testScenario: 's'.repeat(5000),
      changeSummary: 'c'.repeat(500),
    });
    expect(res.statusCode).toBe(201);
  });

  it.each([
    ['an empty name', { name: '' }],
    ['a whitespace-only name', { name: '   ' }],
    ['a 201-character name', { name: 'n'.repeat(201) }],
    ['a 2,001-character description', { description: 'd'.repeat(2001) }],
    ['a 5,001-character test scenario', { testScenario: 's'.repeat(5001) }],
    ['empty content', { content: '' }],
    ['missing content', { content: undefined }],
    ['a 501-character change summary', { changeSummary: 'c'.repeat(501) }],
    ['an unknown language', { language: 'Python' }],
    ['an unknown script type', { scriptType: 'UNIT' }],
    ['a null character in the name', { name: 'Bad\u0000Name' }],
    ['a null character in the description', { description: 'bad\u0000text' }],
    ['a null character in the test scenario', { testScenario: 'bad\u0000text' }],
    ['a null character in the content', { content: 'bad\u0000code' }],
    ['a name that is not a string', { name: 42 }],
  ])('rejects %s', async (_label, payload) => {
    const res = await postScript(ctx, asAdmin, projectId, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect(await ctx.db('test_scripts')).toHaveLength(0);
  });

  it('accepts 1,000,000 characters even when JSON escaping doubles the request size', async () => {
    // Every quote travels as \" on the wire, so this body is 2,000,000 bytes: above Fastify's
    // 1 MiB default and just under the 2 MB limit these routes raise it to.
    const res = await postScript(ctx, asAdmin, projectId, { content: '"'.repeat(1_000_000) });
    expect(res.statusCode).toBe(201);
    const row = await ctx.db('test_script_versions').first(ctx.db.raw('char_length(script_content) as size'));
    expect(row.size).toBe(1_000_000);
  });

  it('rejects 1,000,001 characters as a validation error', async () => {
    const res = await postScript(ctx, asAdmin, projectId, { content: 'x'.repeat(1_000_001) });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.details[0]).toEqual({
      path: 'content',
      message: 'Script content is too long (1,000,000 characters max).',
    });
  });

  it('answers 413 PAYLOAD_TOO_LARGE when the request body exceeds 2 MB', async () => {
    // 700,000 three-byte characters: inside the character limit, but a 2.1 MB body.
    const res = await postScript(ctx, asAdmin, projectId, { content: '語'.repeat(700_000) });
    expect(res.statusCode).toBe(413);
    expect(res.json().error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', message: 'The request is too large.' });
    expect(await ctx.db('test_scripts')).toHaveLength(0);
  });

  it('answers 404 for an unknown or deleted project and 409 for an archived one', async () => {
    const unknown = await postScript(ctx, asAdmin, 9999);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Project not found.');
    for (const bad of ['abc', '0', '1.5']) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${bad}/scripts`,
        headers: asAdmin,
        payload: { name: 'X', content: SAMPLE },
      });
      expect(res.statusCode).toBe(400);
    }

    await setProject({ status: 'ARCHIVED' });
    const archived = await postScript(ctx, asAdmin, projectId);
    expect(archived.statusCode).toBe(409);
    expect(archived.json().error.code).toBe('PROJECT_NOT_ACTIVE');

    await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect((await postScript(ctx, asAdmin, projectId)).statusCode).toBe(404);
    expect(await ctx.db('test_scripts')).toHaveLength(0);
  });

  it('creates tags on demand, reuses a tag in its first spelling, and drops duplicates', async () => {
    const first = await newScript(ctx, asAdmin, projectId, { name: 'A', tags: ['Smoke', ' checkout-flow ', 'smoke'] });
    expect(first.tags).toEqual(['checkout-flow', 'Smoke']);

    const second = await newScript(ctx, asAdmin, projectId, { name: 'B', tags: ['SMOKE', 'v1.2 @nightly_run'] });
    expect(second.tags).toEqual(['Smoke', 'v1.2 @nightly_run']);

    expect(await ctx.db('tags').orderBy('id').pluck('name')).toEqual(['checkout-flow', 'Smoke', 'v1.2 @nightly_run']);
    expect(await ctx.db('script_tags')).toHaveLength(4);
  });

  it('rejects invalid tags and allows exactly twenty', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => `tag-${i}`);
    const invalid: unknown[] = [
      ['bad/tag'],
      ['semi;colon'],
      ['x'.repeat(41)],
      [''],
      ['   '],
      [42],
      'not-a-list',
      [...twenty, 'one-too-many'],
    ];
    for (const tags of invalid) {
      const res = await postScript(ctx, asAdmin, projectId, { tags });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }

    // A repeated tag does not count twice: twenty distinct tags plus one repeat is still twenty.
    const ok = await postScript(ctx, asAdmin, projectId, { tags: [...twenty, 'TAG-0'] });
    expect(ok.statusCode).toBe(201);
    expect(ok.json().script.tags).toHaveLength(20);
  });

  it('survives the same new tags arriving in several requests at once', async () => {
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        postScript(ctx, asAdmin, projectId, {
          name: `Parallel ${i}`,
          tags: i % 2 === 0 ? ['alpha', 'Beta', 'gamma'] : ['GAMMA', 'beta', 'Alpha'],
        }),
      ),
    );
    expect(results.map((res) => res.statusCode)).toEqual([201, 201, 201, 201, 201, 201]);

    const stored: string[] = await ctx.db('tags').pluck('name');
    expect(stored.map((name) => name.toLowerCase()).sort()).toEqual(['alpha', 'beta', 'gamma']);
    for (const res of results) {
      const tags: string[] = res.json().script.tags;
      expect(tags.map((name) => name.toLowerCase())).toEqual(['alpha', 'beta', 'gamma']);
    }
  });

  it('gets a script with its content, tags, and last editor', async () => {
    const created = await newScript(ctx, asAdmin, projectId, { tags: ['smoke'] });
    const res = await get(created.id);
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({
      id: created.id,
      name: 'Login Test',
      content: SAMPLE,
      tags: ['smoke'],
      updatedBy: 'Ada Admin',
      version: 1,
    });
    expect(res.json().script).not.toHaveProperty('projectStatus');
  });

  it('answers 404 for an unknown or deleted script and 400 for a malformed id', async () => {
    const unknown = await get(9999);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Script not found.');

    const [gone] = await ctx
      .db('test_scripts')
      .insert({ project_id: projectId, name: 'Gone', script_content: '//', status: 'DELETED' })
      .returning('id');
    expect((await get(gone.id)).statusCode).toBe(404);

    for (const id of ['abc', '0', '1.5', '99999999999999999999']) {
      expect((await get(id)).statusCode).toBe(400);
    }
  });

  it('lets a USER create and a VIEWER only read', async () => {
    const user = await createUser(ctx.db, { role: 'USER', displayName: 'Uma User' });
    const viewer = await createUser(ctx.db, { role: 'VIEWER' });
    const asUser = (await loginExt(ctx.app, user.email, user.password)).headers;
    const asViewer = (await loginExt(ctx.app, viewer.email, viewer.password)).headers;

    const created = await postScript(ctx, asUser, projectId, { name: 'By User' });
    expect(created.statusCode).toBe(201);
    expect(created.json().script.updatedBy).toBe('Uma User');

    const denied = await postScript(ctx, asViewer, projectId, { name: 'By Viewer' });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().error.code).toBe('FORBIDDEN');

    for (const headers of [asUser, asViewer]) {
      expect((await get(created.json().script.id, headers)).statusCode).toBe(200);
    }
  });

  it('requires a session', async () => {
    const calls = [
      ctx.app.inject({
        method: 'POST',
        url: `/api/projects/${projectId}/scripts`,
        payload: { name: 'X', content: SAMPLE },
      }),
      ctx.app.inject({ method: 'GET', url: '/api/scripts/1' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('enforces CSRF on a cookie-authenticated create', async () => {
    const web = await loginWeb(ctx.app, admin.email, admin.password);
    const url = `/api/projects/${projectId}/scripts`;
    const without = await ctx.app.inject({
      method: 'POST',
      url,
      cookies: web.cookies,
      payload: { name: 'No Token', content: SAMPLE },
    });
    expect(without.statusCode).toBe(403);
    expect(without.json().error.code).toBe('CSRF_INVALID');

    const withToken = await ctx.app.inject({
      method: 'POST',
      url,
      cookies: web.cookies,
      headers: web.headers,
      payload: { name: 'With Token', content: SAMPLE },
    });
    expect(withToken.statusCode).toBe(201);
  });

  it('audits creation without storing the content', async () => {
    const marker = 'UNIQUE-CONTENT-MARKER-91f3';
    const script = await newScript(ctx, asAdmin, projectId, {
      name: 'Audited',
      content: `// ${marker}\n`,
      source: 'RECORDED',
    });

    const rows = await ctx.db('audit_logs').where({ resource: 'script' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'script.create',
      result: 'SUCCESS',
      resource_id: String(script.id),
      user_id: admin.id,
      user_email: admin.email,
    });
    expect(rows[0].details).toEqual({ projectId, name: 'Audited', source: 'RECORDED', version: 1 });
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it('rolls creation back when the audit row cannot be written', async () => {
    await breakAudit(ctx.db);
    const res = await postScript(ctx, asAdmin, projectId, { name: 'Ghost', tags: ['ghost-tag'] });
    expect(res.statusCode).toBe(500);
    for (const table of ['test_scripts', 'test_script_versions', 'script_tags', 'tags']) {
      expect(await ctx.db(table)).toHaveLength(0);
    }

    await repairAudit(ctx.db);
    expect((await postScript(ctx, asAdmin, projectId, { name: 'Ghost' })).statusCode).toBe(201);
  });

  it('counts created scripts in the project overview and the project list', async () => {
    await newScript(ctx, asAdmin, projectId, { name: 'One' });
    await newScript(ctx, asAdmin, projectId, { name: 'Two' });

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect(detail.json().overview).toMatchObject({
      totalScripts: 2,
      passedScripts: 0,
      failedScripts: 0,
      notExecuted: 2,
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/api/projects', headers: asAdmin });
    expect(list.json().items[0].scriptCount).toBe(2);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test -w server -- test/scripts.test.ts`
Expected: FAIL. Every test fails because the routes do not exist yet; typical messages are `expected 404 to be 201` and `script create failed: 404 {"error":{"code":"NOT_FOUND"…`.

- [ ] **Step 4: Add the script types**

Append to `PlaywrightPlatform/server/src/types.ts`:

```ts
export type ScriptLanguage = 'TypeScript' | 'JavaScript';
export type ScriptType = 'E2E' | 'API' | 'COMPONENT';
export type ScriptStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';
export type ScriptLifecycleState =
  | 'DRAFT'
  | 'GENERATED'
  | 'SAVED'
  | 'VALIDATED'
  | 'READY'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'HEALING';
export type ScriptVersionSource = 'MANUAL' | 'GENERATED' | 'RECORDED' | 'IMPORTED' | 'HEALED' | 'RESTORED';

/** A script as lists show it: everything except the two large text fields. */
export interface ScriptSummary {
  id: number;
  projectId: number;
  /** Status of the owning project. Writes are refused unless it is ACTIVE. */
  projectStatus: ProjectStatus;
  name: string;
  description: string;
  language: ScriptLanguage;
  framework: string;
  scriptType: ScriptType;
  version: number;
  status: ScriptStatus;
  lifecycleState: ScriptLifecycleState;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  /** Display name of the last editor. */
  updatedBy: string | null;
}

export interface Script extends ScriptSummary {
  testScenario: string;
  content: string;
}

export interface ScriptVersionSummary {
  version: number;
  source: ScriptVersionSource;
  changeSummary: string;
  /** Display name of the author. */
  createdBy: string | null;
  createdAt: Date;
  /** Content length in characters. */
  size: number;
}

export interface ScriptVersion extends ScriptVersionSummary {
  content: string;
}
```

- [ ] **Step 5: Add the request and response schemas**

`PlaywrightPlatform/server/src/schemas/scripts.ts`:

```ts
import { z } from 'zod';
import type { Script, ScriptSummary } from '../types';
import { cleanText } from './common';

const MAX_TAGS = 20;

const id = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
// The column is a 32-bit integer; anything larger would be a database error instead of "not found".
const versionNumber = z.coerce.number().int().min(1).max(2_147_483_647);

const name = cleanText(
  z.string().trim().min(1, 'Script name is required.').max(200, 'Script name is too long (200 max).'),
);
const description = cleanText(z.string().trim().max(2000, 'Description is too long (2000 max).'));
const testScenario = cleanText(z.string().trim().max(5000, 'Test scenario is too long (5000 max).'));
const changeSummary = cleanText(z.string().trim().max(500, 'Change summary is too long (500 max).'));

// Stored with \n line endings, so the same text always compares equal whatever produced it.
const content = cleanText(
  z
    .string()
    .min(1, 'Script content is required.')
    .max(1_000_000, 'Script content is too long (1,000,000 characters max).'),
).transform((text) => text.replace(/\r\n?/g, '\n'));

const tag = z
  .string()
  .trim()
  .min(1, 'A tag cannot be empty.')
  .max(40, 'A tag is too long (40 max).')
  .regex(/^[\p{L}\p{N} _.@-]+$/u, 'A tag may contain letters, digits, spaces, and - _ . @ only.');

// Repeats that differ only by case collapse to the first spelling, and only then is the count checked.
const tags = z
  .array(tag)
  .max(100, 'Too many tags.')
  .transform((list) => {
    const seen = new Set<string>();
    return list.filter((value) => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  })
  .refine((list) => list.length <= MAX_TAGS, { message: 'A script can have at most 20 tags.' });

const language = z.enum(['TypeScript', 'JavaScript']);
const scriptType = z.enum(['E2E', 'API', 'COMPONENT']);
const scriptStatus = z.enum(['ACTIVE', 'ARCHIVED', 'DELETED']);
const lifecycleState = z.enum([
  'DRAFT',
  'GENERATED',
  'SAVED',
  'VALIDATED',
  'READY',
  'RUNNING',
  'PASSED',
  'FAILED',
  'HEALING',
]);

export const projectScriptsParams = z.object({ projectId: id });

export const createScriptBody = z.object({
  name,
  description: description.default(''),
  testScenario: testScenario.default(''),
  content,
  language: language.default('TypeScript'),
  scriptType: scriptType.default('E2E'),
  tags: tags.default([]),
  // RESTORED and HEALED are written only by the server.
  source: z.enum(['MANUAL', 'GENERATED', 'RECORDED', 'IMPORTED']).default('MANUAL'),
  changeSummary: changeSummary.default(''),
});

const scriptListItemDto = z.object({
  id: z.number(),
  projectId: z.number(),
  name: z.string(),
  description: z.string(),
  language,
  framework: z.string(),
  scriptType,
  version: z.number(),
  status: scriptStatus,
  lifecycleState,
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: z.string().nullable(),
});

const scriptDto = scriptListItemDto.extend({ testScenario: z.string(), content: z.string() });

export const scriptResponse = z.object({ script: scriptDto });

export function toScriptListItemDto(s: ScriptSummary): z.infer<typeof scriptListItemDto> {
  return {
    id: s.id,
    projectId: s.projectId,
    name: s.name,
    description: s.description,
    language: s.language,
    framework: s.framework,
    scriptType: s.scriptType,
    version: s.version,
    status: s.status,
    lifecycleState: s.lifecycleState,
    tags: s.tags,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    updatedBy: s.updatedBy,
  };
}

export function toScriptDto(s: Script): z.infer<typeof scriptDto> {
  return { ...toScriptListItemDto(s), testScenario: s.testScenario, content: s.content };
}
```

`versionNumber` is not used until Task 4; it is declared here because it belongs with `id`.

- [ ] **Step 6: Add the repositories**

`PlaywrightPlatform/server/src/repositories/script-repository.ts`:

```ts
import type { Knex } from 'knex';
import { isUniqueViolation, type Db } from '../db';
import type {
  ProjectStatus,
  Script,
  ScriptLanguage,
  ScriptLifecycleState,
  ScriptStatus,
  ScriptSummary,
  ScriptType,
  ScriptVersionSource,
} from '../types';

interface SummaryRow {
  id: number;
  project_id: number;
  project_status: ProjectStatus;
  name: string;
  description: string;
  language: ScriptLanguage;
  framework: string;
  script_type: ScriptType;
  version: number;
  status: ScriptStatus;
  lifecycle_state: ScriptLifecycleState;
  tags: string[];
  created_at: Date;
  updated_at: Date;
  updated_by_name: string | null;
}

interface ScriptRow extends SummaryRow {
  test_scenario: string;
  script_content: string;
}

const SUMMARY_COLUMNS = [
  's.id',
  's.project_id',
  's.name',
  's.description',
  's.language',
  's.framework',
  's.script_type',
  's.version',
  's.status',
  's.lifecycle_state',
  's.created_at',
  's.updated_at',
  'p.status as project_status',
  'u.display_name as updated_by_name',
];

// Tag names in a fixed order. A subquery, not a join, keeps one row per script so paging stays correct.
const TAGS_COLUMN = `(select coalesce(array_agg(t.name order by lower(t.name) collate "C"), '{}')
  from script_tags st join tags t on t.id = st.tag_id where st.script_id = s.id) as tags`;

function toSummary(row: SummaryRow): ScriptSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    projectStatus: row.project_status,
    name: row.name,
    description: row.description,
    language: row.language,
    framework: row.framework,
    scriptType: row.script_type,
    version: row.version,
    status: row.status,
    lifecycleState: row.lifecycle_state,
    tags: row.tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by_name,
  };
}

function toScript(row: ScriptRow): Script {
  return { ...toSummary(row), testScenario: row.test_scenario, content: row.script_content };
}

/** True when a write failed because another live script in the project already has that name. */
export function isScriptNameClash(err: unknown): boolean {
  return isUniqueViolation(err) && (err as { constraint?: string }).constraint === 'test_scripts_live_name_uq';
}

export interface NewScript {
  projectId: number;
  name: string;
  description: string;
  testScenario: string;
  content: string;
  language: ScriptLanguage;
  scriptType: ScriptType;
  createdBy: number;
}

export interface NewScriptVersion {
  scriptId: number;
  version: number;
  content: string;
  changeSummary: string;
  source: ScriptVersionSource;
  createdBy: number;
}

export class ScriptRepository {
  constructor(private readonly db: Db) {}

  /** Scripts joined to their project (never a deleted one) and to their last editor. */
  private scripts(): Knex.QueryBuilder {
    return this.db('test_scripts as s')
      .join('projects as p', 'p.id', 's.project_id')
      .leftJoin('users as u', 'u.id', 's.updated_by')
      .whereNot('p.status', 'DELETED');
  }

  /** One script with its content. "Live" means neither it nor its project is deleted. */
  async findLive(id: number): Promise<Script | null> {
    const row: ScriptRow | undefined = await this.scripts()
      .where('s.id', id)
      .whereNot('s.status', 'DELETED')
      .select(...SUMMARY_COLUMNS, 's.test_scenario', 's.script_content', this.db.raw(TAGS_COLUMN))
      .first();
    return row ? toScript(row) : null;
  }

  /** Inserts the script at version 1 and returns its id. The caller inserts the version row. */
  async create(input: NewScript): Promise<number> {
    const [row] = await this.db('test_scripts')
      .insert({
        project_id: input.projectId,
        name: input.name,
        description: input.description,
        test_scenario: input.testScenario,
        script_content: input.content,
        language: input.language,
        script_type: input.scriptType,
        version: 1,
        lifecycle_state: 'SAVED',
        created_by: input.createdBy,
        updated_by: input.createdBy,
      })
      .returning('id');
    return row.id;
  }

  async insertVersion(input: NewScriptVersion): Promise<void> {
    await this.db('test_script_versions').insert({
      script_id: input.scriptId,
      version: input.version,
      script_content: input.content,
      change_summary: input.changeSummary,
      source: input.source,
      created_by: input.createdBy,
    });
  }
}
```

`PlaywrightPlatform/server/src/repositories/tag-repository.ts`:

```ts
import type { Db } from '../db';

export class TagRepository {
  constructor(private readonly db: Db) {}

  /**
   * Makes `names` the script's tags. Unknown names become new tag rows; a name that
   * already exists in another capitalisation keeps the stored spelling.
   */
  async setForScript(scriptId: number, names: string[]): Promise<void> {
    await this.db('script_tags').where({ script_id: scriptId }).del();
    if (names.length === 0) return;

    // Sorted, so that two transactions creating the same tags take the index locks in the
    // same order and cannot deadlock.
    const sorted = [...names].sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    });
    await this.db.raw(
      `insert into tags (name) values ${sorted.map(() => '(?)').join(', ')} on conflict (lower(name)) do nothing`,
      sorted,
    );
    await this.db.raw(
      `insert into script_tags (script_id, tag_id)
       select ?, t.id from tags t where lower(t.name) in (select lower(n) from unnest(?::text[]) as n)`,
      [scriptId, sorted],
    );
  }
}
```

Replace `PlaywrightPlatform/server/src/repositories/index.ts` with:

```ts
import type { Db } from '../db';
import { AuditRepository } from './audit-repository';
import { ProjectRepository } from './project-repository';
import { ScriptRepository } from './script-repository';
import { SessionRepository } from './session-repository';
import { TagRepository } from './tag-repository';
import { UserRepository } from './user-repository';

export interface Repos {
  users: UserRepository;
  sessions: SessionRepository;
  audit: AuditRepository;
  projects: ProjectRepository;
  scripts: ScriptRepository;
  tags: TagRepository;
}

export function createRepos(db: Db): Repos {
  return {
    users: new UserRepository(db),
    sessions: new SessionRepository(db),
    audit: new AuditRepository(db),
    projects: new ProjectRepository(db),
    scripts: new ScriptRepository(db),
    tags: new TagRepository(db),
  };
}

/**
 * Runs `work` in one database transaction with repositories bound to it.
 * Everything commits together or not at all, so a mutation can never be
 * left without its audit row (or the reverse).
 */
export type Transact = <T>(work: (repos: Repos) => Promise<T>) => Promise<T>;

export function createTransact(db: Db): Transact {
  return (work) => db.transaction((trx) => work(createRepos(trx)));
}
```

- [ ] **Step 7: Add the service**

`PlaywrightPlatform/server/src/services/script-service.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { AppError, notFound } from '../errors';
import type { Transact } from '../repositories';
import type { AuditRepository } from '../repositories/audit-repository';
import type { ProjectRepository } from '../repositories/project-repository';
import { isScriptNameClash, type ScriptRepository } from '../repositories/script-repository';
import type { TagRepository } from '../repositories/tag-repository';
import type { Actor, Script, ScriptLanguage, ScriptType } from '../types';
import type { AuditService } from './audit-service';

export interface CreateScriptInput {
  name: string;
  description: string;
  testScenario: string;
  content: string;
  language: ScriptLanguage;
  scriptType: ScriptType;
  tags: string[];
  source: 'MANUAL' | 'GENERATED' | 'RECORDED' | 'IMPORTED';
  changeSummary: string;
}

function projectNotActive(): AppError {
  return new AppError(409, 'PROJECT_NOT_ACTIVE', 'This project is archived. Restore it to change its scripts.');
}

function nameTaken(name: string): AppError {
  return new AppError(409, 'SCRIPT_NAME_TAKEN', `A script named "${name}" already exists in this project.`);
}

/** For a row this transaction has just written or locked: it must still be there. */
function found(script: Script | null): Script {
  if (!script) throw new Error('Script disappeared inside its own transaction.');
  return script;
}

export class ScriptService {
  constructor(
    private readonly scripts: ScriptRepository,
    private readonly projects: ProjectRepository,
    private readonly tagRepo: TagRepository,
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly log: FastifyBaseLogger,
  ) {}

  async get(id: number): Promise<Script> {
    const script = await this.scripts.findLive(id);
    if (!script) throw notFound('Script');
    return script;
  }

  async create(actor: Actor, projectId: number, input: CreateScriptInput): Promise<Script> {
    let script: Script;
    try {
      script = await this.transact(async (r) => {
        const project = await r.projects.findLiveById(projectId);
        if (!project) throw notFound('Project');
        if (project.status !== 'ACTIVE') throw projectNotActive();

        const id = await r.scripts.create({
          projectId,
          name: input.name,
          description: input.description,
          testScenario: input.testScenario,
          content: input.content,
          language: input.language,
          scriptType: input.scriptType,
          createdBy: actor.userId,
        });
        await r.scripts.insertVersion({
          scriptId: id,
          version: 1,
          content: input.content,
          changeSummary: input.changeSummary,
          source: input.source,
          createdBy: actor.userId,
        });
        await r.tags.setForScript(id, input.tags);
        await this.record(
          actor,
          'script.create',
          id,
          { projectId, name: input.name, source: input.source, version: 1 },
          r.audit,
        );
        return found(await r.scripts.findLive(id));
      });
    } catch (err) {
      if (isScriptNameClash(err)) throw nameTaken(input.name);
      throw err;
    }
    this.log.info(`[SCRIPT] Created script ${script.id} in project ${projectId}`);
    return script;
  }

  /** Writes the audit row inside the caller's transaction. Never pass script content in `details`. */
  private record(
    actor: Actor,
    action: string,
    id: number,
    details: Record<string, unknown>,
    repo: AuditRepository,
  ): Promise<void> {
    return this.audit.record(
      {
        userId: actor.userId,
        userEmail: actor.email,
        action,
        resource: 'script',
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

`projects` and `tagRepo` are not read yet; Task 2 uses both.

- [ ] **Step 8: Add the guard, the 413 mapping, the routes, and the wiring**

In `PlaywrightPlatform/server/src/plugins/auth.ts`, add directly below the `adminOnly` line:

```ts
/** `preHandler` for the roles that may change scripts: ADMIN and USER. */
export const writers = [requireAuth, requireCsrf, requireRole('ADMIN', 'USER')];
```

In `PlaywrightPlatform/server/src/plugins/error-handler.ts`, add directly below the `if (status === 429) { … }` block:

```ts
    if (status === 413) {
      return reply.status(413).send(body('PAYLOAD_TOO_LARGE', 'The request is too large.'));
    }
```

`PlaywrightPlatform/server/src/routes/scripts.ts`:

```ts
import type { FastifyInstance } from 'fastify';
import { parse, shape } from '../http';
import { actorOf, signedIn, writers } from '../plugins/auth';
import { idParams } from '../schemas/common';
import { createScriptBody, projectScriptsParams, scriptResponse, toScriptDto } from '../schemas/scripts';
import type { ScriptService } from '../services/script-service';

// A script holds up to 1,000,000 characters, which can exceed Fastify's 1 MiB default once encoded.
const SCRIPT_BODY_LIMIT = 2 * 1024 * 1024;

export interface ScriptRouteDeps {
  scripts: ScriptService;
}

export async function scriptRoutes(app: FastifyInstance, deps: ScriptRouteDeps): Promise<void> {
  app.post(
    '/projects/:projectId/scripts',
    { preHandler: writers, bodyLimit: SCRIPT_BODY_LIMIT },
    async (req, reply) => {
      const { projectId } = parse(projectScriptsParams, req.params);
      const body = parse(createScriptBody, req.body);
      const script = await deps.scripts.create(actorOf(req), projectId, body);
      return reply.status(201).send(shape(scriptResponse, { script: toScriptDto(script) }));
    },
  );

  app.get('/scripts/:id', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    return shape(scriptResponse, { script: toScriptDto(await deps.scripts.get(id)) });
  });
}
```

In `PlaywrightPlatform/server/src/app.ts` add two imports, keeping each group alphabetical:

```ts
import { scriptRoutes } from './routes/scripts';
import { ScriptService } from './services/script-service';
```

Directly below `const projectService = new ProjectService(…);` add:

```ts
  const scriptService = new ScriptService(repos.scripts, repos.projects, repos.tags, audit, transact, app.log);
```

Directly below `await api.register(projectRoutes, { projects: projectService });` add:

```ts
      await api.register(scriptRoutes, { scripts: scriptService });
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run test -w server -- test/scripts.test.ts`
Expected: PASS, every test in the file.

Run: `npm test`
Expected: PASS, every file (the 92 existing tests plus the new file), 0 failed.

Run: `npm run typecheck -w server`
Expected: no output, exit code 0.

- [ ] **Step 10: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): create and read scripts with versions, tags, and audit"
```

---

### Task 2: List, search, tag filter, paging, and tag names

**Files:**
- Create: `PlaywrightPlatform/server/src/repositories/sql.ts`
- Modify: `PlaywrightPlatform/server/src/repositories/project-repository.ts`, `PlaywrightPlatform/server/src/repositories/script-repository.ts`, `PlaywrightPlatform/server/src/repositories/tag-repository.ts`, `PlaywrightPlatform/server/src/schemas/scripts.ts`, `PlaywrightPlatform/server/src/services/script-service.ts`, `PlaywrightPlatform/server/src/routes/scripts.ts`
- Test: `PlaywrightPlatform/server/test/script-list.test.ts`

**Interfaces:**
- Consumes (Task 1): `ScriptRepository` with its private `scripts()` builder, `SUMMARY_COLUMNS`, `TAGS_COLUMN`, `toSummary`; `TagRepository`; `ScriptService` with `projects` and `tagRepo`; schema consts `id`, `scriptListItemDto`, `toScriptListItemDto`; test helpers `newProject`, `newScript`
- Produces:
  - `escapeLike(text): string` in `repositories/sql.ts`
  - `ScriptListQuery { search?: string; tag?: string; status: 'ACTIVE' | 'DELETED'; page: number; pageSize: number }`
  - `ScriptRepository.list(projectId, query): Promise<{ items: ScriptSummary[]; total: number }>`
  - `TagRepository.list(search: string | undefined, limit: number): Promise<string[]>`
  - `ScriptService.list(projectId, query)` (404 when the project is unknown or deleted), `ScriptService.tags(search?)`
  - Schemas: `listScriptsQuery`, `listTagsQuery`, `scriptListResponse`, `tagListResponse`
  - Routes: `GET /api/projects/:projectId/scripts` → `{ items, total, page, pageSize }`; `GET /api/tags` → `{ items: string[] }`

- [ ] **Step 1: Write the failing tests**

`PlaywrightPlatform/server/test/script-list.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, makeApp, resetDb, type TestContext } from './helpers';
import { newProject, newScript } from './script-helpers';

describe('scripts: list, search, and tags', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;
  let projectId: number;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN', displayName: 'Ada Admin' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    projectId = await newProject(ctx, asAdmin);
  });

  const list = (query = '', headers = asAdmin, project: number | string = projectId) =>
    ctx.app.inject({ method: 'GET', url: `/api/projects/${project}/scripts${query}`, headers });
  const tagList = (query = '', headers: Record<string, string> | undefined = asAdmin) =>
    ctx.app.inject({ method: 'GET', url: `/api/tags${query}`, headers });
  const names = (res: { json(): { items: { name: string }[] } }) => res.json().items.map((s) => s.name);
  const create = (payload: Record<string, unknown>) => newScript(ctx, asAdmin, projectId, payload);
  const loginAs = async (role: 'USER' | 'VIEWER') => {
    const user = await createUser(ctx.db, { role });
    return (await loginExt(ctx.app, user.email, user.password)).headers;
  };

  it('lists the most recently updated script first, without the large text fields', async () => {
    await create({ name: 'Alpha', description: 'first', testScenario: 'steps', tags: ['smoke'] });
    await create({ name: 'Beta' });

    const res = await list();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ total: 2, page: 1, pageSize: 25 });
    expect(names(res)).toEqual(['Beta', 'Alpha']);
    const alpha = res.json().items[1];
    expect(alpha).toMatchObject({
      projectId,
      name: 'Alpha',
      description: 'first',
      language: 'TypeScript',
      framework: 'Playwright',
      scriptType: 'E2E',
      version: 1,
      status: 'ACTIVE',
      lifecycleState: 'SAVED',
      tags: ['smoke'],
      updatedBy: 'Ada Admin',
    });
    expect(alpha).not.toHaveProperty('content');
    expect(alpha).not.toHaveProperty('testScenario');

    // Order follows the last update, not creation.
    await ctx.db('test_scripts').where({ name: 'Alpha' }).update({ updated_at: new Date(Date.now() + 60_000) });
    expect(names(await list())).toEqual(['Alpha', 'Beta']);
  });

  it('returns only the scripts of the requested project', async () => {
    await create({ name: 'Mine' });
    const other = await newProject(ctx, asAdmin, 'Other');
    await newScript(ctx, asAdmin, other, { name: 'Theirs' });

    expect(names(await list())).toEqual(['Mine']);
    expect(names(await list('', asAdmin, other))).toEqual(['Theirs']);
  });

  it('searches name, description, test scenario, and tag names, ignoring case, but not content', async () => {
    await create({ name: 'Login Flow' });
    await create({ name: 'A', description: 'covers LOGIN errors' });
    await create({ name: 'B', testScenario: 'the user tries to login twice' });
    await create({ name: 'C', tags: ['login-suite'] });
    await create({ name: 'Unrelated', content: '// login appears only in the code\n' });

    expect(names(await list('?search=login')).sort()).toEqual(['A', 'B', 'C', 'Login Flow']);
    expect(names(await list('?search=%20LOGIN%20')).sort()).toEqual(['A', 'B', 'C', 'Login Flow']);
    expect(names(await list('?search=nothing-like-this'))).toEqual([]);
  });

  it('treats %, _, and backslash in a search as literal characters', async () => {
    await create({ name: '100% Coverage' });
    await create({ name: 'snake_case' });
    await create({ name: 'Plain' });

    expect(names(await list('?search=%25'))).toEqual(['100% Coverage']);
    expect(names(await list('?search=_'))).toEqual(['snake_case']);
    expect(names(await list('?search=%5C'))).toEqual([]);
  });

  it('filters by one exact tag, ignoring case', async () => {
    await create({ name: 'Tagged', tags: ['Smoke'] });
    await create({ name: 'Near miss', tags: ['smoke-test'] });
    await create({ name: 'Untagged' });

    expect(names(await list('?tag=smoke'))).toEqual(['Tagged']);
    expect(names(await list('?tag=SMOKE'))).toEqual(['Tagged']);
    expect(names(await list('?tag=smo'))).toEqual([]);
    expect(names(await list('?tag=%25'))).toEqual([]);
  });

  it('combines search and tag filter', async () => {
    await create({ name: 'Login smoke', tags: ['smoke'] });
    await create({ name: 'Login regression', tags: ['regression'] });
    await create({ name: 'Checkout smoke', tags: ['smoke'] });

    expect(names(await list('?search=login&tag=smoke'))).toEqual(['Login smoke']);
  });

  it('paginates and validates paging input', async () => {
    for (const name of ['One', 'Two', 'Three']) await create({ name });

    const page2 = await list('?page=2&pageSize=2');
    expect(page2.json()).toMatchObject({ total: 3, page: 2, pageSize: 2 });
    expect(names(page2)).toEqual(['One']);
    expect(names(await list('?page=9'))).toEqual([]);
    expect((await list('?pageSize=100')).statusCode).toBe(200);

    const invalid = [
      '?page=0',
      '?pageSize=0',
      '?pageSize=101',
      '?page=abc',
      '?page=400000000000000000',
      '?status=ARCHIVED',
      '?status=NOPE',
      '?search=%00',
      '?tag=%00',
    ];
    for (const query of invalid) {
      const res = await list(query);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('shows deleted scripts only to an ADMIN who asks for them', async () => {
    await create({ name: 'Live' });
    await ctx.db('test_scripts').insert({ project_id: projectId, name: 'Gone', script_content: '//', status: 'DELETED' });

    expect(names(await list())).toEqual(['Live']);
    expect(names(await list('?status=DELETED'))).toEqual(['Gone']);

    for (const role of ['USER', 'VIEWER'] as const) {
      const headers = await loginAs(role);
      expect((await list('', headers)).statusCode).toBe(200);
      const denied = await list('?status=DELETED', headers);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('FORBIDDEN');
    }
  });

  it('answers 404 for an unknown or deleted project and still lists an archived one', async () => {
    await create({ name: 'Kept' });
    expect((await list('', asAdmin, 9999)).statusCode).toBe(404);
    for (const bad of ['abc', '0', '1.5']) expect((await list('', asAdmin, bad)).statusCode).toBe(400);

    const setStatus = (status: string) =>
      ctx.app.inject({ method: 'PUT', url: `/api/projects/${projectId}`, headers: asAdmin, payload: { status } });
    await setStatus('ARCHIVED');
    expect(names(await list())).toEqual(['Kept']);

    await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect((await list()).statusCode).toBe(404);
  });

  it('requires a session to list scripts or tags', async () => {
    const noSession = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}/scripts` });
    expect(noSession.statusCode).toBe(401);
    expect((await tagList('', undefined)).statusCode).toBe(401);
  });

  it('lists tag names alphabetically, filtered by a literal search, at most fifty', async () => {
    await create({ name: 'A', tags: ['smoke', 'Regression', 'checkout', '100.5'] });
    expect((await tagList()).json()).toEqual({ items: ['100.5', 'checkout', 'Regression', 'smoke'] });
    expect((await tagList('?search=REG')).json().items).toEqual(['Regression']);
    expect((await tagList('?search=%25')).json().items).toEqual([]);
    expect((await tagList('?search=_')).json().items).toEqual([]);
    for (const role of ['USER', 'VIEWER'] as const) {
      expect((await tagList('', await loginAs(role))).statusCode).toBe(200);
    }
    expect((await tagList(`?search=${'x'.repeat(41)}`)).statusCode).toBe(400);

    await ctx.db('tags').insert(Array.from({ length: 60 }, (_, i) => ({ name: `bulk-${String(i).padStart(2, '0')}` })));
    const capped = (await tagList()).json().items;
    expect(capped).toHaveLength(50);
    expect(capped[0]).toBe('100.5');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w server -- test/script-list.test.ts`
Expected: FAIL. Every test fails with `expected 404 to be 200` (or an error reading `items` of a 404 body), because neither route exists.

- [ ] **Step 3: Share the LIKE-escaping helper**

`PlaywrightPlatform/server/src/repositories/sql.ts`:

```ts
/** Escapes LIKE wildcards so user text matches literally. Pairs with `escape '\'` in the query. */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, '\\$&');
}
```

In `PlaywrightPlatform/server/src/repositories/project-repository.ts`, delete the local `escapeLike` function together with its comment (the four lines starting at `/** Escapes LIKE wildcards`), and add this import below the two existing imports:

```ts
import { escapeLike } from './sql';
```

- [ ] **Step 4: Add the list queries**

In `PlaywrightPlatform/server/src/repositories/script-repository.ts`, add this import below the existing imports:

```ts
import { escapeLike } from './sql';
```

Add this interface above `export class ScriptRepository`:

```ts
export interface ScriptListQuery {
  search?: string;
  tag?: string;
  status: 'ACTIVE' | 'DELETED';
  page: number;
  pageSize: number;
}
```

Add this method to `ScriptRepository`, directly above `findLive`:

```ts
  /** One page of a project's scripts, most recently updated first. Never selects script content. */
  async list(projectId: number, query: ScriptListQuery): Promise<{ items: ScriptSummary[]; total: number }> {
    const filtered = this.scripts().where('s.project_id', projectId).where('s.status', query.status);
    if (query.search) {
      const pattern = `%${escapeLike(query.search)}%`;
      filtered.whereRaw(
        `(s.name ilike ? escape '\\' or s.description ilike ? escape '\\' or s.test_scenario ilike ? escape '\\'
          or exists (select 1 from script_tags st join tags t on t.id = st.tag_id
                     where st.script_id = s.id and t.name ilike ? escape '\\'))`,
        [pattern, pattern, pattern, pattern],
      );
    }
    if (query.tag) {
      filtered.whereRaw(
        `exists (select 1 from script_tags st join tags t on t.id = st.tag_id
                 where st.script_id = s.id and lower(t.name) = lower(?))`,
        [query.tag],
      );
    }

    const totalRow = await filtered.clone().count('* as n').first();
    const rows: SummaryRow[] = await filtered
      .clone()
      .select(...SUMMARY_COLUMNS, this.db.raw(TAGS_COLUMN))
      .orderBy('s.updated_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return { total: Number(totalRow?.n ?? 0), items: rows.map(toSummary) };
  }
```

In `PlaywrightPlatform/server/src/repositories/tag-repository.ts`, add this import below the existing import:

```ts
import { escapeLike } from './sql';
```

Add this method to `TagRepository`, after `setForScript`:

```ts
  /** Tag names in alphabetical order, optionally only those containing `search`. */
  async list(search: string | undefined, limit: number): Promise<string[]> {
    const query = this.db('tags').orderByRaw('lower(name) collate "C"').limit(limit);
    if (search) query.whereRaw("name ilike ? escape '\\'", [`%${escapeLike(search)}%`]);
    return query.pluck('name');
  }
```

- [ ] **Step 5: Add the schemas**

Append to `PlaywrightPlatform/server/src/schemas/scripts.ts`:

```ts
export const listScriptsQuery = z.object({
  search: cleanText(z.string().trim().max(200)).optional(),
  tag: cleanText(z.string().trim().max(40)).optional(),
  // ARCHIVED is not a state scripts can reach in this release.
  status: z.enum(['ACTIVE', 'DELETED']).default('ACTIVE'),
  page: z.coerce.number().int().min(1).max(100_000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const listTagsQuery = z.object({ search: cleanText(z.string().trim().max(40)).optional() });

export const scriptListResponse = z.object({
  items: z.array(scriptListItemDto),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});

export const tagListResponse = z.object({ items: z.array(z.string()) });
```

- [ ] **Step 6: Add the service methods**

In `PlaywrightPlatform/server/src/services/script-service.ts`, change two imports to:

```ts
import { isScriptNameClash, type ScriptListQuery, type ScriptRepository } from '../repositories/script-repository';
import type { Actor, Script, ScriptLanguage, ScriptSummary, ScriptType } from '../types';
```

Add these methods to `ScriptService`, directly above `get`:

```ts
  async list(projectId: number, query: ScriptListQuery): Promise<{ items: ScriptSummary[]; total: number }> {
    if (!(await this.projects.findLiveById(projectId))) throw notFound('Project');
    return this.scripts.list(projectId, query);
  }

  /** Existing tag names for autocomplete. */
  tags(search?: string): Promise<string[]> {
    return this.tagRepo.list(search, 50);
  }
```

- [ ] **Step 7: Add the routes**

In `PlaywrightPlatform/server/src/routes/scripts.ts`, add this import below the `fastify` import:

```ts
import { AppError } from '../errors';
```

Replace the import from `'../schemas/scripts'` with:

```ts
import {
  createScriptBody,
  listScriptsQuery,
  listTagsQuery,
  projectScriptsParams,
  scriptListResponse,
  scriptResponse,
  tagListResponse,
  toScriptDto,
  toScriptListItemDto,
} from '../schemas/scripts';
```

Add these two routes inside `scriptRoutes`, as its first statements:

```ts
  app.get('/projects/:projectId/scripts', { preHandler: signedIn }, async (req) => {
    const { projectId } = parse(projectScriptsParams, req.params);
    const query = parse(listScriptsQuery, req.query);
    if (query.status === 'DELETED' && req.auth?.user.role !== 'ADMIN') {
      throw new AppError(403, 'FORBIDDEN', 'Only administrators can list deleted scripts.');
    }
    const { items, total } = await deps.scripts.list(projectId, query);
    return shape(scriptListResponse, {
      items: items.map(toScriptListItemDto),
      total,
      page: query.page,
      pageSize: query.pageSize,
    });
  });

  app.get('/tags', { preHandler: signedIn }, async (req) => {
    const { search } = parse(listTagsQuery, req.query);
    return shape(tagListResponse, { items: await deps.scripts.tags(search) });
  });
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npm run test -w server -- test/script-list.test.ts`
Expected: PASS, every test in the file.

Run: `npm test`
Expected: PASS, every file, 0 failed. `projects.test.ts` still passes: its search tests now go through the shared `escapeLike`.

Run: `npm run typecheck -w server`
Expected: no output, exit code 0.

- [ ] **Step 9: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): list, search, and tag-filter scripts"
```

---

### Task 3: Update and delete scripts

**Files:**
- Modify: `PlaywrightPlatform/server/src/repositories/script-repository.ts`, `PlaywrightPlatform/server/src/schemas/scripts.ts`, `PlaywrightPlatform/server/src/services/script-service.ts`, `PlaywrightPlatform/server/src/routes/scripts.ts`
- Test: `PlaywrightPlatform/server/test/script-update.test.ts`

**Interfaces:**
- Consumes (Tasks 1–2): `ScriptRepository.findLive`, `.insertVersion`; `TagRepository.setForScript`; `ScriptService` with `record`, `projectNotActive()`, `nameTaken()`, `found()`; schema consts `name`, `description`, `testScenario`, `changeSummary`, `content`, `tags`; `writers`; `SCRIPT_BODY_LIMIT`; test helpers
- Produces:
  - `ScriptChanges { name?; description?; testScenario?; newVersion?: { content: string; version: number } }`
  - `ScriptRepository.lock(id): Promise<boolean>`, `.update(id, changes: ScriptChanges, updatedBy: number): Promise<void>`, `.softDelete(id, deletedBy: number): Promise<boolean>`
  - `UpdateScriptInput { name?; description?; testScenario?; tags?: string[]; content?: string; changeSummary?: string; baseVersion?: number }`
  - `ScriptService.update(actor, id, input): Promise<Script>`, `.remove(actor, id): Promise<void>`
  - Schema: `updateScriptBody`
  - Routes: `PUT /api/scripts/:id` → `{ script }`; `DELETE /api/scripts/:id` → 204
  - Error codes: 409 `VERSION_CONFLICT` with `details: { currentVersion: number, updatedBy: string | null }`

- [ ] **Step 1: Write the failing tests**

`PlaywrightPlatform/server/test/script-update.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';
import { SAMPLE, breakAudit, newProject, newScript, postScript, repairAudit } from './script-helpers';

const NEXT = `${SAMPLE}\n// second version\n`;

describe('scripts: update and delete', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;
  let projectId: number;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await repairAudit(ctx.db);
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN', displayName: 'Ada Admin' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    projectId = await newProject(ctx, asAdmin);
  });
  afterEach(() => repairAudit(ctx.db));

  const put = (id: number, payload: unknown, headers = asAdmin) =>
    ctx.app.inject({ method: 'PUT', url: `/api/scripts/${id}`, headers, payload: payload as object });
  const del = (id: number, headers = asAdmin) =>
    ctx.app.inject({ method: 'DELETE', url: `/api/scripts/${id}`, headers });
  const get = (id: number, headers = asAdmin) =>
    ctx.app.inject({ method: 'GET', url: `/api/scripts/${id}`, headers });
  const versionsOf = (id: number) => ctx.db('test_script_versions').where({ script_id: id }).orderBy('version');
  const auditFor = (action: string) => ctx.db('audit_logs').where({ action }).orderBy('id');
  const setProject = (payload: object) =>
    ctx.app.inject({ method: 'PUT', url: `/api/projects/${projectId}`, headers: asAdmin, payload });
  const loginAs = async (role: 'USER' | 'VIEWER', displayName?: string) => {
    const user = await createUser(ctx.db, { role, displayName });
    return (await loginExt(ctx.app, user.email, user.password)).headers;
  };

  it('changes metadata without creating a version', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { tags: ['smoke'] });
    await ctx.db('test_scripts').where({ id: script.id }).update({ lifecycle_state: 'PASSED' });
    const asEditor = await loginAs('USER', 'Uma User');

    const res = await put(
      script.id,
      { name: '  Login v2 ', description: 'new', testScenario: 'steps', tags: ['regression'] },
      asEditor,
    );
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({
      name: 'Login v2',
      description: 'new',
      testScenario: 'steps',
      tags: ['regression'],
      version: 1,
      content: SAMPLE,
      lifecycleState: 'PASSED',
      updatedBy: 'Uma User',
    });
    expect(await versionsOf(script.id)).toHaveLength(1);

    const audit = await auditFor('script.update');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toEqual({ changed: ['name', 'description', 'testScenario', 'tags'] });
    expect(await auditFor('script.version')).toHaveLength(0);
  });

  it('creates a new version when the content changes', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await ctx.db('test_scripts').where({ id: script.id }).update({ lifecycle_state: 'PASSED' });

    const res = await put(script.id, { content: NEXT, baseVersion: 1, changeSummary: 'Add assertion' });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({ version: 2, content: NEXT, lifecycleState: 'SAVED' });

    const versions = await versionsOf(script.id);
    expect(versions.map((v) => [v.version, v.source, v.change_summary, v.script_content])).toEqual([
      [1, 'MANUAL', '', SAMPLE],
      [2, 'MANUAL', 'Add assertion', NEXT],
    ]);
    expect(versions[1].created_by).toBe(admin.id);

    const audit = await auditFor('script.version');
    expect(audit).toHaveLength(1);
    expect(audit[0].details).toEqual({ version: 2, changed: ['content'] });
    expect(await auditFor('script.update')).toHaveLength(0);
  });

  it('records metadata and content changed together as one new version', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: NEXT, baseVersion: 1, tags: ['smoke'] });
    expect(res.json().script).toMatchObject({ version: 2, tags: ['smoke'] });
    expect((await auditFor('script.version'))[0].details).toEqual({ version: 2, changed: ['tags', 'content'] });
  });

  it('creates nothing when the content is unchanged', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: SAMPLE, baseVersion: 1, changeSummary: 'nothing really' });
    expect(res.statusCode).toBe(200);
    expect(res.json().script.version).toBe(1);
    expect(await versionsOf(script.id)).toHaveLength(1);
    expect(await auditFor('script.version')).toHaveLength(0);
    expect(await auditFor('script.update')).toHaveLength(0);
  });

  it('treats the same text with Windows line endings as unchanged', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: SAMPLE.replace(/\n/g, '\r\n'), baseVersion: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({ version: 1, content: SAMPLE });
    expect(await versionsOf(script.id)).toHaveLength(1);
  });

  it('updates metadata but not the version when the content sent is unchanged', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: SAMPLE, baseVersion: 1, description: 'changed' });
    expect(res.json().script).toMatchObject({ version: 1, description: 'changed' });
    expect((await auditFor('script.update'))[0].details).toEqual({ changed: ['description'] });
  });

  it('refuses content based on a stale version and says who saved the current one', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const asEditor = await loginAs('USER', 'Uma User');
    expect((await put(script.id, { content: NEXT, baseVersion: 1 })).statusCode).toBe(200);

    const stale = await put(script.id, { content: '// mine\n', baseVersion: 1 }, asEditor);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toMatchObject({
      code: 'VERSION_CONFLICT',
      details: { currentVersion: 2, updatedBy: 'Ada Admin' },
    });
    // Even text identical to the current content is refused: the caller has not seen v2.
    expect((await put(script.id, { content: NEXT, baseVersion: 1 }, asEditor)).statusCode).toBe(409);

    expect((await get(script.id)).json().script).toMatchObject({ version: 2, content: NEXT });
    expect(await versionsOf(script.id)).toHaveLength(2);

    // Metadata needs no base version and still works.
    expect((await put(script.id, { description: 'still editable' }, asEditor)).statusCode).toBe(200);
  });

  it.each([
    ['an empty body', {}],
    ['only a change summary', { changeSummary: 'just this' }],
    ['only a base version', { baseVersion: 1 }],
    ['content without a base version', { content: '// x\n' }],
    ['a base version of zero', { content: '// x\n', baseVersion: 0 }],
    ['a base version sent as text', { content: '// x\n', baseVersion: '1' }],
    ['an empty name', { name: '' }],
    ['empty content', { content: '', baseVersion: 1 }],
    ['content over the limit', { content: 'x'.repeat(1_000_001), baseVersion: 1 }],
    ['an invalid tag', { tags: ['bad/tag'] }],
    ['a null character', { description: 'bad\u0000text' }],
  ])('rejects %s', async (_label, payload) => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION_ERROR');
    expect((await get(script.id)).json().script).toMatchObject({ name: 'Login Test', version: 1 });
  });

  it('names the missing field when content arrives without a base version', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: '// x\n' });
    expect(res.json().error.details).toContainEqual({
      path: 'baseVersion',
      message: 'baseVersion is required when content is sent.',
    });
  });

  it('accepts a 2 MB body on update', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const res = await put(script.id, { content: '"'.repeat(1_000_000), baseVersion: 1 });
    expect(res.statusCode).toBe(200);
    expect(res.json().script.version).toBe(2);
  });

  it('refuses a rename to a name another script uses, ignoring case', async () => {
    const alpha = await newScript(ctx, asAdmin, projectId, { name: 'Alpha' });
    await newScript(ctx, asAdmin, projectId, { name: 'Beta' });

    const clash = await put(alpha.id, { name: 'BETA', content: NEXT, baseVersion: 1 });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({
      code: 'SCRIPT_NAME_TAKEN',
      message: 'A script named "BETA" already exists in this project.',
    });
    // The whole change is undone, including the new version.
    expect((await get(alpha.id)).json().script).toMatchObject({ name: 'Alpha', version: 1 });
    expect(await versionsOf(alpha.id)).toHaveLength(1);

    expect((await put(alpha.id, { name: 'ALPHA' })).json().script.name).toBe('ALPHA');
  });

  it('replaces and clears tags', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { tags: ['smoke', 'auth'] });
    expect((await put(script.id, { tags: ['regression', 'AUTH'] })).json().script.tags).toEqual(['auth', 'regression']);
    expect((await put(script.id, { tags: [] })).json().script.tags).toEqual([]);
    expect(await ctx.db('script_tags').where({ script_id: script.id })).toHaveLength(0);
    expect(await ctx.db('tags')).toHaveLength(3); // tag rows are never deleted
  });

  it('lets exactly one of two simultaneous saves from the same base win', async () => {
    for (let round = 0; round < 5; round += 1) {
      const script = await newScript(ctx, asAdmin, projectId, { name: `Race ${round}` });
      const results = await Promise.all([
        put(script.id, { content: '// first\n', baseVersion: 1 }),
        put(script.id, { content: '// second\n', baseVersion: 1 }),
      ]);

      expect(results.map((res) => res.statusCode).sort()).toEqual([200, 409]);
      const winner = results.find((res) => res.statusCode === 200)!;
      const loser = results.find((res) => res.statusCode === 409)!;
      expect(loser.json().error.code).toBe('VERSION_CONFLICT');

      const versions = await versionsOf(script.id);
      expect(versions.map((v) => v.version)).toEqual([1, 2]);
      expect(versions[1].script_content).toBe(winner.json().script.content);
    }
  });

  it('refuses writes in an archived project and hides the scripts of a deleted one', async () => {
    const script = await newScript(ctx, asAdmin, projectId);

    await setProject({ status: 'ARCHIVED' });
    const refused = [
      await put(script.id, { name: 'X' }),
      await put(script.id, { content: NEXT, baseVersion: 1 }),
      await del(script.id),
    ];
    for (const res of refused) {
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROJECT_NOT_ACTIVE');
    }
    expect((await get(script.id)).statusCode).toBe(200);

    await ctx.app.inject({ method: 'DELETE', url: `/api/projects/${projectId}`, headers: asAdmin });
    for (const res of [await put(script.id, { name: 'X' }), await del(script.id), await get(script.id)]) {
      expect(res.statusCode).toBe(404);
    }
    const row = await ctx.db('test_scripts').where({ id: script.id }).first();
    expect(row).toMatchObject({ name: 'Login Test', status: 'ACTIVE', version: 1 });
  });

  it('soft-deletes: the row and history stay, the script disappears, the name is reusable', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { name: 'Doomed', tags: ['smoke'] });
    await put(script.id, { content: NEXT, baseVersion: 1 });

    const res = await del(script.id);
    expect(res.statusCode).toBe(204);

    const row = await ctx.db('test_scripts').where({ id: script.id }).first();
    expect(row).toMatchObject({ status: 'DELETED', deleted_by: admin.id });
    expect(row.deleted_at).toBeInstanceOf(Date);
    expect(await versionsOf(script.id)).toHaveLength(2);

    expect((await get(script.id)).statusCode).toBe(404);
    expect((await put(script.id, { name: 'X' })).statusCode).toBe(404);
    expect((await del(script.id)).statusCode).toBe(404);

    const listUrl = `/api/projects/${projectId}/scripts`;
    const live = await ctx.app.inject({ method: 'GET', url: listUrl, headers: asAdmin });
    expect(live.json().items).toEqual([]);
    const deleted = await ctx.app.inject({ method: 'GET', url: `${listUrl}?status=DELETED`, headers: asAdmin });
    expect(deleted.json().items.map((s: { name: string }) => s.name)).toEqual(['Doomed']);

    expect((await postScript(ctx, asAdmin, projectId, { name: 'Doomed' })).statusCode).toBe(201);

    const audit = await auditFor('script.delete');
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ resource_id: String(script.id), user_id: admin.id });
    expect(audit[0].details).toEqual({ name: 'Doomed', version: 2 });
  });

  it('lets a USER update and delete, and refuses a VIEWER', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const asViewer = await loginAs('VIEWER');
    for (const res of [await put(script.id, { name: 'Nope' }, asViewer), await del(script.id, asViewer)]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('FORBIDDEN');
    }

    const asUser = await loginAs('USER');
    expect((await put(script.id, { name: 'By User' }, asUser)).statusCode).toBe(200);
    expect((await del(script.id, asUser)).statusCode).toBe(204);
  });

  it('requires a session', async () => {
    const calls = [
      ctx.app.inject({ method: 'PUT', url: '/api/scripts/1', payload: { name: 'X' } }),
      ctx.app.inject({ method: 'DELETE', url: '/api/scripts/1' }),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('enforces CSRF on cookie-authenticated update and delete', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    const web = await loginWeb(ctx.app, admin.email, admin.password);
    const url = `/api/scripts/${script.id}`;

    const putWithout = await ctx.app.inject({ method: 'PUT', url, cookies: web.cookies, payload: { name: 'No Token' } });
    const delWithout = await ctx.app.inject({ method: 'DELETE', url, cookies: web.cookies });
    for (const res of [putWithout, delWithout]) {
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('CSRF_INVALID');
    }

    const putWith = await ctx.app.inject({
      method: 'PUT',
      url,
      cookies: web.cookies,
      headers: web.headers,
      payload: { name: 'With Token' },
    });
    expect(putWith.statusCode).toBe(200);
    const delWith = await ctx.app.inject({ method: 'DELETE', url, cookies: web.cookies, headers: web.headers });
    expect(delWith.statusCode).toBe(204);
  });

  it('rolls update and delete back when the audit row cannot be written', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await breakAudit(ctx.db);

    expect((await put(script.id, { content: NEXT, baseVersion: 1, tags: ['x'] })).statusCode).toBe(500);
    expect((await put(script.id, { name: 'Renamed' })).statusCode).toBe(500);
    expect((await del(script.id)).statusCode).toBe(500);

    await repairAudit(ctx.db);
    expect((await get(script.id)).json().script).toMatchObject({
      name: 'Login Test',
      version: 1,
      content: SAMPLE,
      status: 'ACTIVE',
      tags: [],
    });
    expect(await versionsOf(script.id)).toHaveLength(1);
  });

  it('drops a deleted script from the project overview', async () => {
    const keep = await newScript(ctx, asAdmin, projectId, { name: 'Keep' });
    const drop = await newScript(ctx, asAdmin, projectId, { name: 'Drop' });
    await del(drop.id);

    const detail = await ctx.app.inject({ method: 'GET', url: `/api/projects/${projectId}`, headers: asAdmin });
    expect(detail.json().overview).toMatchObject({ totalScripts: 1, notExecuted: 1 });
    expect((await get(keep.id)).statusCode).toBe(200);
  });

  it('never writes script content into an audit row', async () => {
    const first = 'CONTENT-MARKER-ONE-7c21';
    const second = 'CONTENT-MARKER-TWO-88ab';
    const script = await newScript(ctx, asAdmin, projectId, { content: `// ${first}\n` });
    await put(script.id, { content: `// ${second}\n`, baseVersion: 1, changeSummary: 'swap' });
    await put(script.id, { name: 'Renamed' });
    await del(script.id);

    const rows = await ctx.db('audit_logs').where({ resource: 'script' }).orderBy('id');
    expect(rows.map((r: { action: string }) => r.action)).toEqual([
      'script.create',
      'script.version',
      'script.update',
      'script.delete',
    ]);
    const stored = JSON.stringify(rows);
    expect(stored).not.toContain(first);
    expect(stored).not.toContain(second);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w server -- test/script-update.test.ts`
Expected: FAIL. `PUT` and `DELETE` on `/api/scripts/:id` answer 404, so the tests report `expected 404 to be 200`, `expected 404 to be 204`, and similar.

- [ ] **Step 3: Add the repository methods**

In `PlaywrightPlatform/server/src/repositories/script-repository.ts`, add this interface above `export class ScriptRepository`:

```ts
export interface ScriptChanges {
  name?: string;
  description?: string;
  testScenario?: string;
  /** New content together with its version number. */
  newVersion?: { content: string; version: number };
}
```

Add these methods to `ScriptRepository`, as its last members:

```ts
  /**
   * Locks the script row until the transaction ends and reports whether it exists.
   * Call it first in any transaction that reads the version and then writes: a
   * concurrent writer waits here and then sees the first one's result.
   */
  async lock(id: number): Promise<boolean> {
    const row = await this.db('test_scripts').where({ id }).whereNot('status', 'DELETED').forUpdate().first('id');
    return Boolean(row);
  }

  async update(id: number, changes: ScriptChanges, updatedBy: number): Promise<void> {
    const columns: Record<string, unknown> = { updated_at: this.db.fn.now(), updated_by: updatedBy };
    if (changes.name !== undefined) columns.name = changes.name;
    if (changes.description !== undefined) columns.description = changes.description;
    if (changes.testScenario !== undefined) columns.test_scenario = changes.testScenario;
    if (changes.newVersion) {
      columns.script_content = changes.newVersion.content;
      columns.version = changes.newVersion.version;
      columns.lifecycle_state = 'SAVED';
    }
    await this.db('test_scripts').where({ id }).update(columns);
  }

  async softDelete(id: number, deletedBy: number): Promise<boolean> {
    const count = await this.db('test_scripts')
      .where({ id })
      .whereNot('status', 'DELETED')
      .update({
        status: 'DELETED',
        deleted_at: this.db.fn.now(),
        deleted_by: deletedBy,
        updated_at: this.db.fn.now(),
      });
    return count > 0;
  }
```

- [ ] **Step 4: Add the schema**

Append to `PlaywrightPlatform/server/src/schemas/scripts.ts`:

```ts
const CHANGEABLE = ['name', 'description', 'testScenario', 'tags', 'content'] as const;

export const updateScriptBody = z
  .object({
    name: name.optional(),
    description: description.optional(),
    testScenario: testScenario.optional(),
    tags: tags.optional(),
    content: content.optional(),
    changeSummary: changeSummary.optional(),
    baseVersion: z.number().int().min(1).max(2_147_483_647).optional(),
  })
  .refine((body) => CHANGEABLE.some((key) => body[key] !== undefined), {
    message: 'Provide at least one field to change.',
  })
  .refine((body) => body.content === undefined || body.baseVersion !== undefined, {
    message: 'baseVersion is required when content is sent.',
    path: ['baseVersion'],
  });
```

- [ ] **Step 5: Add the service methods**

In `PlaywrightPlatform/server/src/services/script-service.ts`, add below the `CreateScriptInput` interface:

```ts
export interface UpdateScriptInput {
  name?: string;
  description?: string;
  testScenario?: string;
  tags?: string[];
  content?: string;
  changeSummary?: string;
  /** The version the caller's content was based on. Required with `content`. */
  baseVersion?: number;
}

const METADATA_FIELDS = ['name', 'description', 'testScenario', 'tags'] as const;
```

Add these methods to `ScriptService`, directly above the private `record` method:

```ts
  async update(actor: Actor, id: number, input: UpdateScriptInput): Promise<Script> {
    let saved: { script: Script; note: string | null };
    try {
      saved = await this.transact(async (r) => {
        if (!(await r.scripts.lock(id))) throw notFound('Script');
        const current = await r.scripts.findLive(id);
        if (!current) throw notFound('Script'); // its project is deleted
        if (current.projectStatus !== 'ACTIVE') throw projectNotActive();

        if (input.content !== undefined && input.baseVersion !== current.version) {
          throw new AppError(
            409,
            'VERSION_CONFLICT',
            `This script is now at v${current.version}. Your changes were based on v${input.baseVersion}.`,
            { currentVersion: current.version, updatedBy: current.updatedBy },
          );
        }

        const next =
          input.content !== undefined && input.content !== current.content
            ? { content: input.content, version: current.version + 1 }
            : null;
        const changed: string[] = METADATA_FIELDS.filter((field) => input[field] !== undefined);
        if (!next && changed.length === 0) return { script: current, note: null };

        await r.scripts.update(
          id,
          {
            name: input.name,
            description: input.description,
            testScenario: input.testScenario,
            newVersion: next ?? undefined,
          },
          actor.userId,
        );
        if (next) {
          await r.scripts.insertVersion({
            scriptId: id,
            version: next.version,
            content: next.content,
            changeSummary: input.changeSummary ?? '',
            source: 'MANUAL',
            createdBy: actor.userId,
          });
        }
        if (input.tags !== undefined) await r.tags.setForScript(id, input.tags);
        await this.record(
          actor,
          next ? 'script.version' : 'script.update',
          id,
          next ? { version: next.version, changed: [...changed, 'content'] } : { changed },
          r.audit,
        );
        return {
          script: found(await r.scripts.findLive(id)),
          note: next ? `Saved script ${id} as v${next.version}` : `Updated script ${id}`,
        };
      });
    } catch (err) {
      if (isScriptNameClash(err)) throw nameTaken(input.name ?? '');
      throw err;
    }
    if (saved.note) this.log.info(`[SCRIPT] ${saved.note}`);
    return saved.script;
  }

  async remove(actor: Actor, id: number): Promise<void> {
    await this.transact(async (r) => {
      const script = await r.scripts.findLive(id);
      if (!script) throw notFound('Script');
      if (script.projectStatus !== 'ACTIVE') throw projectNotActive();
      if (!(await r.scripts.softDelete(id, actor.userId))) throw notFound('Script');
      await this.record(actor, 'script.delete', id, { name: script.name, version: script.version }, r.audit);
    });
    this.log.info(`[SCRIPT] Deleted script ${id}`);
  }
```

- [ ] **Step 6: Add the routes**

In `PlaywrightPlatform/server/src/routes/scripts.ts`, add `updateScriptBody` to the import from `'../schemas/scripts'` (keep the list alphabetical), then add these routes inside `scriptRoutes`, as its last statements:

```ts
  app.put('/scripts/:id', { preHandler: writers, bodyLimit: SCRIPT_BODY_LIMIT }, async (req) => {
    const { id } = parse(idParams, req.params);
    const body = parse(updateScriptBody, req.body);
    return shape(scriptResponse, { script: toScriptDto(await deps.scripts.update(actorOf(req), id, body)) });
  });

  app.delete('/scripts/:id', { preHandler: writers }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    await deps.scripts.remove(actorOf(req), id);
    return reply.status(204).send();
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test -w server -- test/script-update.test.ts`
Expected: PASS, every test in the file.

Run: `npm test`
Expected: PASS, every file, 0 failed.

Run: `npm run typecheck -w server`
Expected: no output, exit code 0.

- [ ] **Step 8: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): update scripts with versioning and conflict detection, soft delete"
```

---

### Task 4: Version history, restore, duplicate, and download

**Files:**
- Modify: `PlaywrightPlatform/server/src/repositories/script-repository.ts`, `PlaywrightPlatform/server/src/schemas/scripts.ts`, `PlaywrightPlatform/server/src/services/script-service.ts`, `PlaywrightPlatform/server/src/routes/scripts.ts`
- Test: `PlaywrightPlatform/server/test/script-versions.test.ts`

**Interfaces:**
- Consumes (Tasks 1–3): `ScriptRepository.findLive`, `.create`, `.insertVersion`, `.lock`, `.update`; `TagRepository.setForScript`; `ScriptService.get`, `record`, `projectNotActive()`, `nameTaken()`, `found()`; schema consts `id`, `versionNumber`, `name`; `writers`, `signedIn`; test helpers
- Produces:
  - `ScriptRepository.listVersions(scriptId): Promise<ScriptVersionSummary[]>` (newest first, no content), `.findVersion(scriptId, version): Promise<ScriptVersion | null>`
  - `ScriptService.versions(id)`, `.version(id, version)`, `.restore(actor, id, version): Promise<Script>`, `.duplicate(actor, id, name?): Promise<Script>`, `.download(id, version?): Promise<{ fileName: string; content: string }>`
  - Schemas: `scriptVersionParams`, `duplicateScriptBody`, `downloadQuery`, `versionListResponse`, `versionResponse`, `toVersionItemDto`, `toVersionDto`
  - Routes: `GET /api/scripts/:id/versions` → `{ items }`; `GET /api/scripts/:id/versions/:version` → `{ version }`; `POST /api/scripts/:id/versions/:version/restore` → `{ script }`; `POST /api/scripts/:id/duplicate` (201) → `{ script }`; `GET /api/scripts/:id/download[?version=n]` → the file
  - Error codes: 409 `ALREADY_CURRENT`; 404 with message `Version not found.`

- [ ] **Step 1: Write the failing tests**

`PlaywrightPlatform/server/test/script-versions.test.ts`:

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { User } from '../src/types';
import { closeApp, createUser, loginExt, loginWeb, makeApp, resetDb, type TestContext } from './helpers';
import { SAMPLE, breakAudit, newProject, newScript, postScript, repairAudit } from './script-helpers';

const V2 = `${SAMPLE}\n// second version\n`;

describe('scripts: versions, restore, duplicate, and download', () => {
  let ctx: TestContext;
  let admin: User & { password: string };
  let asAdmin: Record<string, string>;
  let projectId: number;

  beforeAll(async () => {
    ctx = await makeApp({ RATE_LIMIT_MAX: '100000' });
  });
  afterAll(() => closeApp(ctx));
  beforeEach(async () => {
    await repairAudit(ctx.db);
    await resetDb(ctx.db);
    admin = await createUser(ctx.db, { role: 'ADMIN', displayName: 'Ada Admin' });
    asAdmin = (await loginExt(ctx.app, admin.email, admin.password)).headers;
    projectId = await newProject(ctx, asAdmin);
  });
  afterEach(() => repairAudit(ctx.db));

  /** Pass `{}` as headers for a call without a session. */
  const call = (
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    headers: Record<string, string> = asAdmin,
    payload?: object,
  ) => ctx.app.inject({ method, url: `/api${url}`, headers, payload });
  const save = (id: number, content: string, baseVersion: number, changeSummary = '') =>
    call('PUT', `/scripts/${id}`, asAdmin, { content, baseVersion, changeSummary });
  const versionRows = (id: number) => ctx.db('test_script_versions').where({ script_id: id }).orderBy('version');
  const loginAs = async (role: 'USER' | 'VIEWER') => {
    const user = await createUser(ctx.db, { role });
    return (await loginExt(ctx.app, user.email, user.password)).headers;
  };

  it('lists versions newest first without their content', async () => {
    const script = await newScript(ctx, asAdmin, projectId, { source: 'RECORDED', changeSummary: 'From the recorder' });
    await save(script.id, V2, 1, 'Add assertion');

    const res = await call('GET', `/scripts/${script.id}/versions`);
    expect(res.statusCode).toBe(200);
    expect(res.json().items).toMatchObject([
      { version: 2, source: 'MANUAL', changeSummary: 'Add assertion', createdBy: 'Ada Admin', size: V2.length },
      { version: 1, source: 'RECORDED', changeSummary: 'From the recorder', createdBy: 'Ada Admin', size: SAMPLE.length },
    ]);
    expect(res.json().items[0]).not.toHaveProperty('content');
    expect(new Date(res.json().items[0].createdAt).getTime()).not.toBeNaN();

    expect((await call('GET', '/scripts/9999/versions')).statusCode).toBe(404);
  });

  it('fetches one version with its content', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    const one = await call('GET', `/scripts/${script.id}/versions/1`);
    expect(one.statusCode).toBe(200);
    expect(one.json().version).toMatchObject({ version: 1, content: SAMPLE, source: 'MANUAL', size: SAMPLE.length });

    const missing = await call('GET', `/scripts/${script.id}/versions/9`);
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error.message).toBe('Version not found.');
    expect((await call('GET', '/scripts/9999/versions/1')).json().error.message).toBe('Script not found.');
    for (const bad of ['0', 'abc', '1.5', '99999999999']) {
      expect((await call('GET', `/scripts/${script.id}/versions/${bad}`)).statusCode).toBe(400);
    }
  });

  it('restores an old version as a new one and leaves history untouched', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    await ctx.db('test_scripts').where({ id: script.id }).update({ lifecycle_state: 'PASSED' });

    const res = await call('POST', `/scripts/${script.id}/versions/1/restore`);
    expect(res.statusCode).toBe(200);
    expect(res.json().script).toMatchObject({ version: 3, content: SAMPLE, lifecycleState: 'SAVED' });

    const rows = await versionRows(script.id);
    expect(rows.map((r) => [r.version, r.source, r.change_summary, r.script_content])).toEqual([
      [1, 'MANUAL', '', SAMPLE],
      [2, 'MANUAL', '', V2],
      [3, 'RESTORED', 'Restored from v1', SAMPLE],
    ]);
  });

  it('refuses to restore the latest version, an unknown version, or anything in an archived project', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    const latest = await call('POST', `/scripts/${script.id}/versions/2/restore`);
    expect(latest.statusCode).toBe(409);
    expect(latest.json().error).toMatchObject({ code: 'ALREADY_CURRENT', message: 'v2 is already the latest version.' });

    const unknown = await call('POST', `/scripts/${script.id}/versions/7/restore`);
    expect(unknown.statusCode).toBe(404);
    expect(unknown.json().error.message).toBe('Version not found.');
    expect((await call('POST', `/scripts/${script.id}/versions/abc/restore`)).statusCode).toBe(400);

    await call('PUT', `/projects/${projectId}`, asAdmin, { status: 'ARCHIVED' });
    for (const url of [`/scripts/${script.id}/versions/1/restore`, `/scripts/${script.id}/duplicate`]) {
      const res = await call('POST', url);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROJECT_NOT_ACTIVE');
    }
    expect(await versionRows(script.id)).toHaveLength(2);
    expect(await ctx.db('test_scripts')).toHaveLength(1);
  });

  it('duplicates content, metadata, and tags into an independent script', async () => {
    const original = await newScript(ctx, asAdmin, projectId, {
      description: 'Signs in',
      testScenario: 'steps',
      language: 'JavaScript',
      scriptType: 'API',
      tags: ['smoke', 'auth'],
    });
    await save(original.id, V2, 1);

    const res = await call('POST', `/scripts/${original.id}/duplicate`);
    expect(res.statusCode).toBe(201);
    const copy = res.json().script;
    expect(copy).toMatchObject({
      projectId,
      name: 'Login Test (copy)',
      description: 'Signs in',
      testScenario: 'steps',
      language: 'JavaScript',
      scriptType: 'API',
      tags: ['auth', 'smoke'],
      content: V2,
      version: 1,
      lifecycleState: 'SAVED',
    });
    expect(copy.id).not.toBe(original.id);

    const history = await call('GET', `/scripts/${copy.id}/versions`);
    expect(history.json().items).toMatchObject([
      { version: 1, source: 'MANUAL', changeSummary: 'Duplicated from Login Test v2' },
    ]);

    // Changing the copy leaves the original alone.
    await save(copy.id, '// changed copy\n', 1);
    expect((await call('GET', `/scripts/${original.id}`)).json().script).toMatchObject({ version: 2, content: V2 });
    expect(await versionRows(original.id)).toHaveLength(2);
  });

  it('accepts a name for the copy and refuses one that is taken', async () => {
    const original = await newScript(ctx, asAdmin, projectId);

    const named = await call('POST', `/scripts/${original.id}/duplicate`, asAdmin, { name: '  Second Copy ' });
    expect(named.json().script.name).toBe('Second Copy');
    expect((await call('POST', `/scripts/${original.id}/duplicate`)).statusCode).toBe(201);

    const clash = await call('POST', `/scripts/${original.id}/duplicate`);
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error).toMatchObject({
      code: 'SCRIPT_NAME_TAKEN',
      message: 'A script named "Login Test (copy)" already exists in this project.',
    });
    expect((await call('POST', `/scripts/${original.id}/duplicate`, asAdmin, { name: '' })).statusCode).toBe(400);
    expect((await call('POST', '/scripts/9999/duplicate')).statusCode).toBe(404);
    expect(await ctx.db('test_scripts')).toHaveLength(3);
  });

  it('shortens a long name so the default copy name still fits', async () => {
    const original = await newScript(ctx, asAdmin, projectId, { name: 'N'.repeat(200) });
    const copy = (await call('POST', `/scripts/${original.id}/duplicate`)).json().script;
    expect(copy.name).toHaveLength(200);
    expect(copy.name.endsWith(' (copy)')).toBe(true);
  });

  it('downloads the latest content as a file', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    const res = await call('GET', `/scripts/${script.id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('attachment; filename="login-test.spec.ts"');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.body).toBe(V2);

    const js = await newScript(ctx, asAdmin, projectId, { name: 'Plain JS', language: 'JavaScript' });
    const jsRes = await call('GET', `/scripts/${js.id}/download`);
    expect(jsRes.headers['content-disposition']).toBe('attachment; filename="plain-js.spec.js"');
  });

  it('downloads one chosen version', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);

    expect((await call('GET', `/scripts/${script.id}/download?version=1`)).body).toBe(SAMPLE);
    expect((await call('GET', `/scripts/${script.id}/download?version=2`)).body).toBe(V2);
    expect((await call('GET', `/scripts/${script.id}/download?version=9`)).statusCode).toBe(404);
    expect((await call('GET', `/scripts/${script.id}/download?version=abc`)).statusCode).toBe(400);
    expect((await call('GET', '/scripts/9999/download')).statusCode).toBe(404);
  });

  it.each([
    ['../../etc/passwd', 'etc-passwd.spec.ts'],
    ['a"; filename="evil.exe', 'a-filename-evil-exe.spec.ts'],
    ['line\r\nSet-Cookie: x=1', 'line-set-cookie-x-1.spec.ts'],
    ['Ünïcödé Tést', 'unicode-test.spec.ts'],
    ['日本語', 'script.spec.ts'],
    ['x'.repeat(200), `${'x'.repeat(80)}.spec.ts`],
  ])('builds a safe file name from the script name %j', async (name, expected) => {
    const script = await newScript(ctx, asAdmin, projectId, { name });
    const res = await call('GET', `/scripts/${script.id}/download`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe(`attachment; filename="${expected}"`);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('lets a VIEWER read history and download, and only writers restore or duplicate', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    const asViewer = await loginAs('VIEWER');
    const asUser = await loginAs('USER');

    const reads = [
      `/scripts/${script.id}/versions`,
      `/scripts/${script.id}/versions/1`,
      `/scripts/${script.id}/download`,
    ];
    for (const headers of [asViewer, asUser]) {
      for (const url of reads) expect((await call('GET', url, headers)).statusCode).toBe(200);
    }

    const writes = [`/scripts/${script.id}/versions/1/restore`, `/scripts/${script.id}/duplicate`];
    for (const url of writes) {
      const denied = await call('POST', url, asViewer);
      expect(denied.statusCode).toBe(403);
      expect(denied.json().error.code).toBe('FORBIDDEN');
    }
    expect((await call('POST', writes[0], asUser)).statusCode).toBe(200);
    expect((await call('POST', writes[1], asUser)).statusCode).toBe(201);
  });

  it('requires a session', async () => {
    const calls = [
      call('GET', '/scripts/1/versions', {}),
      call('GET', '/scripts/1/versions/1', {}),
      call('POST', '/scripts/1/versions/1/restore', {}),
      call('POST', '/scripts/1/duplicate', {}),
      call('GET', '/scripts/1/download', {}),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(401);
  });

  it('enforces CSRF on cookie-authenticated restore and duplicate', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    const web = await loginWeb(ctx.app, admin.email, admin.password);
    const restoreUrl = `/api/scripts/${script.id}/versions/1/restore`;
    const duplicateUrl = `/api/scripts/${script.id}/duplicate`;

    for (const url of [restoreUrl, duplicateUrl]) {
      const without = await ctx.app.inject({ method: 'POST', url, cookies: web.cookies });
      expect(without.statusCode).toBe(403);
      expect(without.json().error.code).toBe('CSRF_INVALID');
    }
    const restored = await ctx.app.inject({ method: 'POST', url: restoreUrl, cookies: web.cookies, headers: web.headers });
    expect(restored.statusCode).toBe(200);
    const copied = await ctx.app.inject({ method: 'POST', url: duplicateUrl, cookies: web.cookies, headers: web.headers });
    expect(copied.statusCode).toBe(201);

    // Reads need no token.
    const read = await ctx.app.inject({ method: 'GET', url: `/api/scripts/${script.id}/download`, cookies: web.cookies });
    expect(read.statusCode).toBe(200);
  });

  it('audits restore and duplicate without the content', async () => {
    const marker = 'CONTENT-MARKER-RESTORE-5d10';
    const script = await newScript(ctx, asAdmin, projectId, { content: `// ${marker}\n` });
    await save(script.id, V2, 1);
    await call('POST', `/scripts/${script.id}/versions/1/restore`);
    const copy = (await call('POST', `/scripts/${script.id}/duplicate`)).json().script;

    const rows = await ctx
      .db('audit_logs')
      .whereIn('action', ['script.restore', 'script.duplicate'])
      .orderBy('id');
    expect(rows.map((r: { action: string; resource_id: string }) => [r.action, r.resource_id])).toEqual([
      ['script.restore', String(script.id)],
      ['script.duplicate', String(copy.id)],
    ]);
    expect(rows[0].details).toEqual({ fromVersion: 1, version: 3 });
    expect(rows[1].details).toEqual({ fromScriptId: script.id, fromVersion: 3, name: 'Login Test (copy)' });
    expect(JSON.stringify(rows)).not.toContain(marker);
  });

  it('rolls restore and duplicate back when the audit row cannot be written', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    await breakAudit(ctx.db);

    expect((await call('POST', `/scripts/${script.id}/versions/1/restore`)).statusCode).toBe(500);
    expect((await call('POST', `/scripts/${script.id}/duplicate`)).statusCode).toBe(500);

    await repairAudit(ctx.db);
    expect(await versionRows(script.id)).toHaveLength(2);
    expect(await ctx.db('test_scripts')).toHaveLength(1);
    expect((await call('GET', `/scripts/${script.id}`)).json().script).toMatchObject({ version: 2, content: V2 });
  });

  it('answers 404 on every script route once the project is deleted', async () => {
    const script = await newScript(ctx, asAdmin, projectId);
    await save(script.id, V2, 1);
    expect((await call('DELETE', `/projects/${projectId}`)).statusCode).toBe(204);

    const calls = [
      call('GET', `/projects/${projectId}/scripts`),
      postScript(ctx, asAdmin, projectId, { name: 'New' }),
      call('GET', `/scripts/${script.id}`),
      call('PUT', `/scripts/${script.id}`, asAdmin, { name: 'X' }),
      call('DELETE', `/scripts/${script.id}`),
      call('POST', `/scripts/${script.id}/duplicate`),
      call('GET', `/scripts/${script.id}/versions`),
      call('GET', `/scripts/${script.id}/versions/1`),
      call('POST', `/scripts/${script.id}/versions/1/restore`),
      call('GET', `/scripts/${script.id}/download`),
    ];
    for (const res of await Promise.all(calls)) expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w server -- test/script-versions.test.ts`
Expected: FAIL. The five new routes answer 404, so tests report `expected 404 to be 200`, `expected 404 to be 201`, and `expected 404 to be 401`. One test passes already, for the wrong reason: "answers 404 on every script route once the project is deleted" sees 404 from the five routes only because they are missing. It becomes a real check once Step 6 adds them.

- [ ] **Step 3: Add the repository methods**

In `PlaywrightPlatform/server/src/repositories/script-repository.ts`, add `ScriptVersion` and `ScriptVersionSummary` to the type import from `'../types'` (keep the list alphabetical), then add below the `ScriptRow` interface:

```ts
interface VersionRow {
  version: number;
  source: ScriptVersionSource;
  change_summary: string;
  created_by_name: string | null;
  created_at: Date;
  size: number;
}
```

Add below the `TAGS_COLUMN` constant:

```ts
const VERSION_COLUMNS = [
  'v.version',
  'v.source',
  'v.change_summary',
  'v.created_at',
  'u.display_name as created_by_name',
];

// Measured in the database, so listing versions never loads their content.
const SIZE_COLUMN = 'char_length(v.script_content) as size';
```

Add below the `toScript` function:

```ts
function toVersionSummary(row: VersionRow): ScriptVersionSummary {
  return {
    version: row.version,
    source: row.source,
    changeSummary: row.change_summary,
    createdBy: row.created_by_name,
    createdAt: row.created_at,
    size: row.size,
  };
}
```

Add these methods to `ScriptRepository`, as its last members:

```ts
  /** A script's versions joined to their authors. */
  private versions(scriptId: number): Knex.QueryBuilder {
    return this.db('test_script_versions as v')
      .leftJoin('users as u', 'u.id', 'v.created_by')
      .where('v.script_id', scriptId);
  }

  /** Newest first, without content. */
  async listVersions(scriptId: number): Promise<ScriptVersionSummary[]> {
    const rows: VersionRow[] = await this.versions(scriptId)
      .select(...VERSION_COLUMNS, this.db.raw(SIZE_COLUMN))
      .orderBy('v.version', 'desc');
    return rows.map(toVersionSummary);
  }

  async findVersion(scriptId: number, version: number): Promise<ScriptVersion | null> {
    const row: (VersionRow & { script_content: string }) | undefined = await this.versions(scriptId)
      .where('v.version', version)
      .select(...VERSION_COLUMNS, 'v.script_content', this.db.raw(SIZE_COLUMN))
      .first();
    return row ? { ...toVersionSummary(row), content: row.script_content } : null;
  }
```

- [ ] **Step 4: Add the schemas**

Append to `PlaywrightPlatform/server/src/schemas/scripts.ts` (the `import` line goes with the other imports at the top):

```ts
import type { ScriptVersion, ScriptVersionSummary } from '../types';

export const scriptVersionParams = z.object({ id, version: versionNumber });
export const duplicateScriptBody = z.object({ name: name.optional() });
export const downloadQuery = z.object({ version: versionNumber.optional() });

const versionItemDto = z.object({
  version: z.number(),
  source: z.enum(['MANUAL', 'GENERATED', 'RECORDED', 'IMPORTED', 'HEALED', 'RESTORED']),
  changeSummary: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  size: z.number(),
});

const versionDto = versionItemDto.extend({ content: z.string() });

export const versionListResponse = z.object({ items: z.array(versionItemDto) });
export const versionResponse = z.object({ version: versionDto });

export function toVersionItemDto(v: ScriptVersionSummary): z.infer<typeof versionItemDto> {
  return {
    version: v.version,
    source: v.source,
    changeSummary: v.changeSummary,
    createdBy: v.createdBy,
    createdAt: v.createdAt.toISOString(),
    size: v.size,
  };
}

export function toVersionDto(v: ScriptVersion): z.infer<typeof versionDto> {
  return { ...toVersionItemDto(v), content: v.content };
}
```

- [ ] **Step 5: Add the service methods**

In `PlaywrightPlatform/server/src/services/script-service.ts`, change the type import from `'../types'` to:

```ts
import type {
  Actor,
  Script,
  ScriptLanguage,
  ScriptSummary,
  ScriptType,
  ScriptVersion,
  ScriptVersionSummary,
} from '../types';
```

Add below the `METADATA_FIELDS` constant:

```ts
const COPY_SUFFIX = ' (copy)';
const MAX_NAME_LENGTH = 200;

/**
 * "Login Test" in TypeScript becomes "login-test.spec.ts". Only a-z, 0-9, and hyphens
 * survive, so the result is always safe inside a Content-Disposition header.
 */
function downloadFileName(name: string, language: ScriptLanguage): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '') // the accents NFKD split off their letters
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 80)
    .replace(/-+$/, '');
  return `${base || 'script'}.spec.${language === 'JavaScript' ? 'js' : 'ts'}`;
}
```

Add these methods to `ScriptService`, directly above the private `record` method:

```ts
  async versions(id: number): Promise<ScriptVersionSummary[]> {
    await this.get(id);
    return this.scripts.listVersions(id);
  }

  async version(id: number, version: number): Promise<ScriptVersion> {
    await this.get(id);
    const row = await this.scripts.findVersion(id, version);
    if (!row) throw notFound('Version');
    return row;
  }

  /** History is never rewritten: restoring writes the old content as a new version. */
  async restore(actor: Actor, id: number, version: number): Promise<Script> {
    const script = await this.transact(async (r) => {
      if (!(await r.scripts.lock(id))) throw notFound('Script');
      const current = await r.scripts.findLive(id);
      if (!current) throw notFound('Script'); // its project is deleted
      if (current.projectStatus !== 'ACTIVE') throw projectNotActive();
      if (version === current.version) {
        throw new AppError(409, 'ALREADY_CURRENT', `v${version} is already the latest version.`);
      }
      const old = await r.scripts.findVersion(id, version);
      if (!old) throw notFound('Version');

      const next = current.version + 1;
      await r.scripts.update(id, { newVersion: { content: old.content, version: next } }, actor.userId);
      await r.scripts.insertVersion({
        scriptId: id,
        version: next,
        content: old.content,
        changeSummary: `Restored from v${version}`,
        source: 'RESTORED',
        createdBy: actor.userId,
      });
      await this.record(actor, 'script.restore', id, { fromVersion: version, version: next }, r.audit);
      return found(await r.scripts.findLive(id));
    });
    this.log.info(`[SCRIPT] Restored script ${id} from v${version} as v${script.version}`);
    return script;
  }

  /** A new script in the same project with the latest content and its own history. */
  async duplicate(actor: Actor, id: number, name?: string): Promise<Script> {
    let copyName = name ?? '';
    let copy: Script;
    try {
      copy = await this.transact(async (r) => {
        const source = await r.scripts.findLive(id);
        if (!source) throw notFound('Script');
        if (source.projectStatus !== 'ACTIVE') throw projectNotActive();
        copyName = name ?? `${source.name.slice(0, MAX_NAME_LENGTH - COPY_SUFFIX.length)}${COPY_SUFFIX}`;

        const copyId = await r.scripts.create({
          projectId: source.projectId,
          name: copyName,
          description: source.description,
          testScenario: source.testScenario,
          content: source.content,
          language: source.language,
          scriptType: source.scriptType,
          createdBy: actor.userId,
        });
        await r.scripts.insertVersion({
          scriptId: copyId,
          version: 1,
          content: source.content,
          changeSummary: `Duplicated from ${source.name} v${source.version}`,
          source: 'MANUAL',
          createdBy: actor.userId,
        });
        await r.tags.setForScript(copyId, source.tags);
        await this.record(
          actor,
          'script.duplicate',
          copyId,
          { fromScriptId: id, fromVersion: source.version, name: copyName },
          r.audit,
        );
        return found(await r.scripts.findLive(copyId));
      });
    } catch (err) {
      if (isScriptNameClash(err)) throw nameTaken(copyName);
      throw err;
    }
    this.log.info(`[SCRIPT] Duplicated script ${id} as script ${copy.id}`);
    return copy;
  }

  /** The file to hand to the browser: the latest content, or one version's. */
  async download(id: number, version?: number): Promise<{ fileName: string; content: string }> {
    const script = await this.get(id);
    const fileName = downloadFileName(script.name, script.language);
    if (version === undefined || version === script.version) return { fileName, content: script.content };
    const old = await this.scripts.findVersion(id, version);
    if (!old) throw notFound('Version');
    return { fileName, content: old.content };
  }
```

- [ ] **Step 6: Add the routes**

In `PlaywrightPlatform/server/src/routes/scripts.ts`, replace the import from `'../schemas/scripts'` with:

```ts
import {
  createScriptBody,
  downloadQuery,
  duplicateScriptBody,
  listScriptsQuery,
  listTagsQuery,
  projectScriptsParams,
  scriptListResponse,
  scriptResponse,
  scriptVersionParams,
  tagListResponse,
  toScriptDto,
  toScriptListItemDto,
  toVersionDto,
  toVersionItemDto,
  updateScriptBody,
  versionListResponse,
  versionResponse,
} from '../schemas/scripts';
```

Add these routes inside `scriptRoutes`, as its last statements:

```ts
  app.post('/scripts/:id/duplicate', { preHandler: writers }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    // The body is optional: a request without one asks for the default name.
    const { name } = parse(duplicateScriptBody, req.body ?? {});
    const script = await deps.scripts.duplicate(actorOf(req), id, name);
    return reply.status(201).send(shape(scriptResponse, { script: toScriptDto(script) }));
  });

  app.get('/scripts/:id/versions', { preHandler: signedIn }, async (req) => {
    const { id } = parse(idParams, req.params);
    const items = await deps.scripts.versions(id);
    return shape(versionListResponse, { items: items.map(toVersionItemDto) });
  });

  app.get('/scripts/:id/versions/:version', { preHandler: signedIn }, async (req) => {
    const { id, version } = parse(scriptVersionParams, req.params);
    return shape(versionResponse, { version: toVersionDto(await deps.scripts.version(id, version)) });
  });

  app.post('/scripts/:id/versions/:version/restore', { preHandler: writers }, async (req) => {
    const { id, version } = parse(scriptVersionParams, req.params);
    return shape(scriptResponse, { script: toScriptDto(await deps.scripts.restore(actorOf(req), id, version)) });
  });

  // The one response that is not JSON, so it is not passed through shape().
  app.get('/scripts/:id/download', { preHandler: signedIn }, async (req, reply) => {
    const { id } = parse(idParams, req.params);
    const { version } = parse(downloadQuery, req.query);
    const file = await deps.scripts.download(id, version);
    return reply
      .type('text/plain; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="${file.fileName}"`)
      .send(file.content);
  });
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test -w server -- test/script-versions.test.ts`
Expected: PASS, every test in the file.

Run: `npm test`
Expected: PASS, every file, 0 failed.

Run: `npm run typecheck -w server`
Expected: no output, exit code 0.

Check the layering rules (run from the repo root):

```bash
grep -rn "repositories\|from 'knex'" PlaywrightPlatform/server/src/routes && echo "FAIL: routes reach the database layer" || echo "routes clean"
grep -rn "FastifyRequest\|FastifyReply" PlaywrightPlatform/server/src/services && echo "FAIL: services know HTTP" || echo "services clean"
```

Expected: `routes clean` and `services clean`.

- [ ] **Step 8: Commit**

```bash
git add PlaywrightPlatform/server
git commit -m "feat(platform): script version history, restore, duplicate, and download"
```

---

### Task 5: Web API client and the Scripts tab

**Files:**
- Create: `PlaywrightPlatform/web/src/api/scripts.ts`, `PlaywrightPlatform/web/src/download.ts`, `PlaywrightPlatform/web/src/importFile.ts`, `PlaywrightPlatform/web/src/hooks/useDebounced.ts`, `PlaywrightPlatform/web/src/pages/ScriptsTab.tsx`
- Modify: `PlaywrightPlatform/web/src/api/types.ts`, `PlaywrightPlatform/web/src/api/client.ts`, `PlaywrightPlatform/web/src/pages/ProjectDashboardPage.tsx`, `PlaywrightPlatform/web/src/pages/ProjectsPage.tsx`, `PlaywrightPlatform/web/src/styles.css`, `PlaywrightPlatform/web/e2e/helpers.ts`, `PlaywrightPlatform/server/src/scripts/e2e-serve.ts`
- Test: `PlaywrightPlatform/web/e2e/scripts-tab.spec.ts`

**Interfaces:**
- Consumes: the eleven routes from Tasks 1–4; `api`, `ApiError`, `useLoad`, `useAuth`, `Modal`, `ConfirmDialog`, `StatusBadge`
- Produces:
  - Types in `api/types.ts`: `ScriptLanguage`, `ScriptType`, `ScriptSource`, `ScriptListItem`, `Script`, `ScriptVersionItem`, `ScriptVersion`
  - `apiDownload(path): Promise<{ fileName: string; text: string }>` in `api/client.ts`
  - `scriptsApi` in `api/scripts.ts` with `list(projectId, { search, tag, page })`, `get(id)`, `create(projectId, input: NewScript)`, `update(id, patch: ScriptPatch)`, `remove(id)`, `duplicate(id, name)`, `versions(id)`, `version(id, version)`, `restore(id, version)`, `download(id, version?)`, `tags(search)`; also `SCRIPTS_PAGE_SIZE`, `ScriptList`, `NewScript`, `ScriptPatch`, `VersionConflict`
  - `saveTextFile(fileName, text): void` in `download.ts`
  - `readScriptFile(file: File): Promise<ImportedScript>` and `ImportedScript { name; content; language }` in `importFile.ts`. The Scripts tab passes it to the new-script page as router state `{ imported: ImportedScript }`.
  - `useDebounced<T>(value: T, ms: number): T` in `hooks/useDebounced.ts`
  - `ScriptsTab({ project })`; links it renders: `/projects/:projectId/scripts/new`, `/scripts/:id`, `/scripts/:id?edit=1`, `/scripts/:id/versions` (the pages arrive in Tasks 6–7)
  - The dashboard tab is in the address: `/projects/:id?tab=scripts`
  - CSS classes: `.chip`, `.pager`, `.table-scroll`, `a.btn`
  - E2E helpers: `USER`, `apiHeaders`, `apiCreateProject`, `apiCreateScript`, `apiSaveContent`, `scriptRow`

- [ ] **Step 1: Add an E2E account that may write scripts, and API helpers for test setup**

In `PlaywrightPlatform/server/src/scripts/e2e-serve.ts`, add this row to `E2E_USERS` between the admin and the viewer:

```ts
  { email: 'user@e2e.test', displayName: 'E2E User', password: 'User-e2e-pass1', role: 'USER' },
```

In the same file, add one line to the `loadConfig({ … })` call, below `LOGIN_RATE_LIMIT_MAX: '1000',`:

```ts
    RATE_LIMIT_MAX: '100000',
```

Replace `PlaywrightPlatform/web/e2e/helpers.ts` with:

```ts
import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

export interface Credentials {
  email: string;
  password: string;
}

// Must match E2E_USERS in server/src/scripts/e2e-serve.ts.
export const ADMIN: Credentials = { email: 'admin@e2e.test', password: 'Admin-e2e-pass1' };
export const USER: Credentials = { email: 'user@e2e.test', password: 'User-e2e-pass1' };
export const VIEWER: Credentials = { email: 'viewer@e2e.test', password: 'Viewer-e2e-pass1' };

export async function signIn(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}

type Headers = Record<string, string>;

// One API token per account for the whole run: the test database lives exactly as long as the run.
const tokens = new Map<string, Headers>();

/** Signs in through the API, as the extension does, and returns the request headers to use. */
export async function apiHeaders(request: APIRequestContext, creds: Credentials): Promise<Headers> {
  const cached = tokens.get(creds.email);
  if (cached) return cached;
  const res = await request.post('/api/auth/login', {
    data: { email: creds.email, password: creds.password, client: 'extension' },
  });
  expect(res.ok(), `API sign-in as ${creds.email}`).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await res.json()).token}` };
  tokens.set(creds.email, headers);
  return headers;
}

/** Creates a project as the administrator and returns its id. */
export async function apiCreateProject(request: APIRequestContext, name: string): Promise<number> {
  const res = await request.post('/api/projects', { headers: await apiHeaders(request, ADMIN), data: { name } });
  expect(res.ok(), `API create project ${name}`).toBeTruthy();
  return (await res.json()).project.id;
}

export interface NewScript {
  name: string;
  content: string;
  description?: string;
  tags?: string[];
}

/** Creates a script as `creds` and returns its id. */
export async function apiCreateScript(
  request: APIRequestContext,
  creds: Credentials,
  projectId: number,
  script: NewScript,
): Promise<number> {
  const res = await request.post(`/api/projects/${projectId}/scripts`, {
    headers: await apiHeaders(request, creds),
    data: script,
  });
  expect(res.ok(), `API create script ${script.name}`).toBeTruthy();
  return (await res.json()).script.id;
}

/** Saves new content as `creds`, which creates the next version. */
export async function apiSaveContent(
  request: APIRequestContext,
  creds: Credentials,
  scriptId: number,
  content: string,
  baseVersion: number,
  changeSummary = '',
): Promise<void> {
  const res = await request.put(`/api/scripts/${scriptId}`, {
    headers: await apiHeaders(request, creds),
    data: { content, baseVersion, changeSummary },
  });
  expect(res.ok(), `API save script ${scriptId}`).toBeTruthy();
}

/** The table row of the script with exactly this name. */
export function scriptRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
}
```

- [ ] **Step 2: Write the failing browser tests**

`PlaywrightPlatform/web/e2e/scripts-tab.spec.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN,
  USER,
  VIEWER,
  apiCreateProject,
  apiCreateScript,
  apiHeaders,
  scriptRow,
  signIn,
} from './helpers';

const CHECKOUT = "// checkout\ntest('checkout', async () => {});\n";

function totalScripts(page: Page) {
  return page.locator('.card', { hasText: 'Total Scripts' }).locator('.stat-value');
}

test('scripts are listed, found by search and tag, duplicated, downloaded, and deleted', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Tab ${Date.now()}`);
  await apiCreateScript(request, USER, projectId, {
    name: 'Login Test',
    content: '// login\n',
    description: 'Signs in',
    tags: ['smoke'],
  });
  await apiCreateScript(request, USER, projectId, { name: 'Checkout Flow', content: CHECKOUT, tags: ['regression'] });

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}`);
  await expect(totalScripts(page)).toHaveText('2');

  await page.getByRole('tab', { name: 'Scripts' }).click();
  await expect(page).toHaveURL(/\?tab=scripts$/);
  const login = scriptRow(page, 'Login Test');
  const checkout = scriptRow(page, 'Checkout Flow');
  await expect(login).toContainText('v1');
  await expect(login).toContainText('SAVED');
  await expect(login).toContainText('smoke');
  await expect(login).toContainText('E2E User');
  await expect(login.getByRole('button', { name: 'Run' })).toBeDisabled();
  await expect(login.getByRole('button', { name: 'Heal' })).toBeDisabled();

  // The tab is part of the address, so it survives a reload.
  await page.reload();
  await expect(login).toBeVisible();

  // Search matches a description and a tag name.
  const search = page.getByPlaceholder('Search scripts...');
  await search.fill('signs in');
  await expect(checkout).toHaveCount(0);
  await expect(login).toBeVisible();
  await search.fill('regression');
  await expect(login).toHaveCount(0);
  await expect(checkout).toBeVisible();
  await search.fill('');

  // The tag filter matches one tag; clicking a tag in a row sets the same filter.
  const tagFilter = page.getByLabel('Tag', { exact: true });
  await tagFilter.selectOption('smoke');
  await expect(checkout).toHaveCount(0);
  await expect(login).toBeVisible();
  await tagFilter.selectOption('');
  await checkout.getByRole('button', { name: 'regression' }).click();
  await expect(tagFilter).toHaveValue('regression');
  await expect(login).toHaveCount(0);
  await tagFilter.selectOption('');

  // Duplicate offers the default name, and reports a taken name inside the dialog.
  const dialog = page.getByRole('dialog');
  await login.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dialog.getByLabel('Name')).toHaveValue('Login Test (copy)');
  await dialog.getByRole('button', { name: 'Duplicate' }).click();
  await expect(scriptRow(page, 'Login Test (copy)')).toBeVisible();
  await login.getByRole('button', { name: 'Duplicate' }).click();
  await dialog.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists in this project');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Download hands over the exact content under a safe file name.
  const downloading = page.waitForEvent('download');
  await checkout.getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('checkout-flow.spec.ts');
  expect(await readFile(await download.path(), 'utf8')).toBe(CHECKOUT);

  // Delete asks first.
  await checkout.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toContainText('This will remove the script from the project.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(checkout).toBeVisible();
  await checkout.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(checkout).toHaveCount(0);

  // The overview counts what is left: the original and its copy.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(totalScripts(page)).toHaveText('2');
});

test('paging walks through a list longer than one page', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Paging ${Date.now()}`);
  for (let n = 1; n <= 27; n += 1) {
    await apiCreateScript(request, USER, projectId, { name: `Script ${String(n).padStart(2, '0')}`, content: '// x\n' });
  }

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await expect(page.getByText('1–25 of 27')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(26); // the header row and 25 scripts
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('26–27 of 27')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(scriptRow(page, 'Script 01')).toBeVisible(); // the least recently updated comes last
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('1–25 of 27')).toBeVisible();
});

test('a viewer sees scripts but no way to change them', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Viewer ${Date.now()}`);
  await apiCreateScript(request, USER, projectId, { name: 'Visible', content: '// x\n' });

  await signIn(page, VIEWER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  const row = scriptRow(page, 'Visible');
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: 'View' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Version History' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Download' })).toBeVisible();

  for (const name of ['New Script', 'Edit']) {
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  for (const name of ['Import', 'Record', 'Generate', 'Duplicate', 'Delete']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('an archived project shows its scripts read-only, even to a writer', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Archived ${Date.now()}`);
  await apiCreateScript(request, USER, projectId, { name: 'Frozen', content: '// x\n' });
  const archived = await request.put(`/api/projects/${projectId}`, {
    headers: await apiHeaders(request, ADMIN),
    data: { status: 'ARCHIVED' },
  });
  expect(archived.ok()).toBeTruthy();

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await expect(scriptRow(page, 'Frozen')).toBeVisible();
  await expect(page.getByText('This project is archived, so its scripts cannot be changed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New Script' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('Record and Generate explain the extension, and an empty project says it is empty', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Hints ${Date.now()}`);
  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await expect(page.getByText('No scripts yet.')).toBeVisible();

  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(dialog).toContainText('Recorder');
  await expect(dialog).toContainText('Save to Project');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog).toContainText('Generator');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:e2e -w web -- scripts-tab.spec.ts`
Expected: FAIL, all five. The Scripts tab still shows "Scripts is not available yet.", so the first test stops at `toHaveURL(/\?tab=scripts$/)` and the others at their first row or text assertion.

- [ ] **Step 4: Add the script types and the API module**

Append to `PlaywrightPlatform/web/src/api/types.ts`:

```ts
export type ScriptLanguage = 'TypeScript' | 'JavaScript';
export type ScriptType = 'E2E' | 'API' | 'COMPONENT';
export type ScriptSource = 'MANUAL' | 'GENERATED' | 'RECORDED' | 'IMPORTED' | 'HEALED' | 'RESTORED';

export interface ScriptListItem {
  id: number;
  projectId: number;
  name: string;
  description: string;
  language: ScriptLanguage;
  framework: string;
  scriptType: ScriptType;
  version: number;
  status: 'ACTIVE' | 'ARCHIVED' | 'DELETED';
  lifecycleState: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface Script extends ScriptListItem {
  testScenario: string;
  content: string;
}

export interface ScriptVersionItem {
  version: number;
  source: ScriptSource;
  changeSummary: string;
  createdBy: string | null;
  createdAt: string;
  size: number;
}

export interface ScriptVersion extends ScriptVersionItem {
  content: string;
}
```

Replace `PlaywrightPlatform/web/src/api/client.ts` with:

```ts
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Kept in memory only. It is re-issued by /auth/me after a reload.
let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when a request other than the auth probes comes back 401 (session ended). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

/** Sends the request and returns the response, or throws an ApiError for anything but success. */
async function send(path: string, options: ApiOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check that it is running and try again.', null);
  }

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const data = await res.json().catch(() => null);
    const err = data?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with status ${res.status}.`,
      err?.details ?? null,
    );
  }
  return res;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const res = await send(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => null)) as T;
}

/** Fetches a file response and returns its text together with the file name the server chose. */
export async function apiDownload(path: string): Promise<{ fileName: string; text: string }> {
  const res = await send(path, {});
  const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
  return { fileName: match?.[1] ?? 'script.spec.ts', text: await res.text() };
}

/** Message suitable for showing to the user. A validation error shows its first specific problem. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
    const first = (err.details as { message?: unknown }[])[0]?.message;
    if (typeof first === 'string') return first;
  }
  return err instanceof Error ? err.message : 'Unexpected error.';
}
```

`PlaywrightPlatform/web/src/api/scripts.ts`:

```ts
import { api, apiDownload } from './client';
import type { Script, ScriptLanguage, ScriptListItem, ScriptType, ScriptVersion, ScriptVersionItem } from './types';

export const SCRIPTS_PAGE_SIZE = 25;

export interface ScriptList {
  items: ScriptListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NewScript {
  name: string;
  description: string;
  testScenario: string;
  content: string;
  language: ScriptLanguage;
  scriptType: ScriptType;
  tags: string[];
  source: 'MANUAL' | 'IMPORTED';
}

export interface ScriptPatch {
  name?: string;
  description?: string;
  testScenario?: string;
  tags?: string[];
  content?: string;
  changeSummary?: string;
  /** The version the content was based on. Required whenever `content` is sent. */
  baseVersion?: number;
}

/** `details` of the VERSION_CONFLICT error. */
export interface VersionConflict {
  currentVersion: number;
  updatedBy: string | null;
}

export const scriptsApi = {
  list(projectId: number, params: { search: string; tag: string; page: number }) {
    const query = new URLSearchParams({ page: String(params.page), pageSize: String(SCRIPTS_PAGE_SIZE) });
    if (params.search.trim()) query.set('search', params.search.trim());
    if (params.tag) query.set('tag', params.tag);
    return api<ScriptList>(`/projects/${projectId}/scripts?${query.toString()}`);
  },
  get: (id: number) => api<{ script: Script }>(`/scripts/${id}`),
  create: (projectId: number, input: NewScript) =>
    api<{ script: Script }>(`/projects/${projectId}/scripts`, { method: 'POST', body: input }),
  update: (id: number, patch: ScriptPatch) =>
    api<{ script: Script }>(`/scripts/${id}`, { method: 'PUT', body: patch }),
  remove: (id: number) => api<void>(`/scripts/${id}`, { method: 'DELETE' }),
  duplicate: (id: number, name: string) =>
    api<{ script: Script }>(`/scripts/${id}/duplicate`, { method: 'POST', body: { name } }),
  versions: (id: number) => api<{ items: ScriptVersionItem[] }>(`/scripts/${id}/versions`),
  version: (id: number, version: number) => api<{ version: ScriptVersion }>(`/scripts/${id}/versions/${version}`),
  restore: (id: number, version: number) =>
    api<{ script: Script }>(`/scripts/${id}/versions/${version}/restore`, { method: 'POST' }),
  download: (id: number, version?: number) =>
    apiDownload(`/scripts/${id}/download${version === undefined ? '' : `?version=${version}`}`),
  tags(search: string) {
    const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    return api<{ items: string[] }>(`/tags${query}`);
  },
};
```

`PlaywrightPlatform/web/src/download.ts`:

```ts
/** Hands `text` to the browser as a file download named `fileName`. */
export function saveTextFile(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Released a moment later: some browsers start the download after this function returns.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
```

`PlaywrightPlatform/web/src/importFile.ts`:

```ts
import type { ScriptLanguage } from './api/types';

export interface ImportedScript {
  name: string;
  content: string;
  language: ScriptLanguage;
}

const MAX_BYTES = 1024 * 1024;

const LANGUAGE_BY_EXTENSION: Record<string, ScriptLanguage | undefined> = {
  ts: 'TypeScript',
  js: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
};

/**
 * Reads a script file the user chose. Throws an Error whose message can be shown to the
 * user when the file is not a .ts, .js, .mjs, or .cjs file of at most 1 MB.
 */
export async function readScriptFile(file: File): Promise<ImportedScript> {
  const dot = file.name.lastIndexOf('.');
  const language = dot > 0 ? LANGUAGE_BY_EXTENSION[file.name.slice(dot + 1).toLowerCase()] : undefined;
  if (!language) throw new Error('Choose a .ts, .js, .mjs, or .cjs file.');
  if (file.size > MAX_BYTES) throw new Error('That file is larger than 1 MB.');
  if (file.size === 0) throw new Error('That file is empty.');

  // The server stores \n line endings; converting here keeps the editor from showing a change.
  const content = (await file.text()).replace(/\r\n?/g, '\n');
  // "login.spec.ts" becomes "login".
  const name = file.name.replace(/(\.(spec|test))?\.[^.]+$/i, '').slice(0, 200) || 'Imported script';
  return { name, content, language };
}
```

- [ ] **Step 5: Move the debounce hook where two pages can use it**

`PlaywrightPlatform/web/src/hooks/useDebounced.ts`:

```ts
import { useEffect, useState } from 'react';

/** Returns `value` once it has stopped changing for `ms` milliseconds. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}
```

In `PlaywrightPlatform/web/src/pages/ProjectsPage.tsx`: delete the local `useDebounced` function (the eight lines from `function useDebounced<T>` to its closing brace); change the first import to `import { useState, type FormEvent } from 'react';`; and add this import above the `useLoad` import:

```ts
import { useDebounced } from '../hooks/useDebounced';
```

- [ ] **Step 6: Build the Scripts tab**

`PlaywrightPlatform/web/src/pages/ScriptsTab.tsx`:

```tsx
import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { SCRIPTS_PAGE_SIZE, scriptsApi } from '../api/scripts';
import type { Project, ScriptListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { saveTextFile } from '../download';
import { useDebounced } from '../hooks/useDebounced';
import { useLoad } from '../hooks/useLoad';
import { readScriptFile } from '../importFile';

type Dialog =
  | { kind: 'duplicate'; script: ScriptListItem }
  | { kind: 'delete'; script: ScriptListItem }
  | { kind: 'hint'; action: 'Record' | 'Generate' };

// The agents live in the extension; these buttons only say how to get a script from there to here.
const HINTS = {
  Record:
    'Recording happens in the Playwright AI Studio extension. Open its side panel, record your steps in the Recorder, then choose "Save to Project" and pick this project. The script then appears in this list.',
  Generate:
    'Generation happens in the Playwright AI Studio extension. Open its side panel, produce the test in the Generator or the Orchestrator, then choose "Save to Project" and pick this project. The script then appears in this list.',
};

const COPY_SUFFIX = ' (copy)';

export function ScriptsTab({ project }: { project: Project }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search, 250);

  const archived = project.status !== 'ACTIVE';
  // The API refuses writes from a VIEWER and in an archived project, so the controls are not offered.
  const canWrite = user?.role !== 'VIEWER' && !archived;

  const scripts = useLoad(
    () => scriptsApi.list(project.id, { search: debouncedSearch, tag, page }),
    [project.id, debouncedSearch, tag, page],
  );
  const tags = useLoad(() => scriptsApi.tags(''), [project.id]);
  const data = scripts.data;

  // Deleting the last script on a page leaves that page empty: step back to one that exists.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(page - 1);
  }, [data, page]);

  const tagOptions = [...new Set([...(tags.data?.items ?? []), ...(tag ? [tag] : [])])];
  const first = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? first + data.items.length - 1 : 0;

  const refresh = () => {
    scripts.reload();
    tags.reload();
  };
  const close = () => setDialog(null);
  const closeAndRefresh = () => {
    close();
    refresh();
  };
  const pickTag = (name: string) => {
    setTag(name);
    setPage(1);
  };

  async function onImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // so the same file can be chosen again
    if (!file) return;
    try {
      const imported = await readScriptFile(file);
      navigate(`/projects/${project.id}/scripts/new`, { state: { imported } });
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  async function download(script: ScriptListItem) {
    try {
      const file = await scriptsApi.download(script.id);
      saveTextFile(file.fileName, file.text);
      setProblem(null);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  return (
    <>
      {archived && <p className="muted">This project is archived, so its scripts cannot be changed.</p>}

      {canWrite && (
        <div className="toolbar">
          <Link className="btn btn-primary" to={`/projects/${project.id}/scripts/new`}>New Script</Link>
          <button className="btn btn-secondary" onClick={() => fileInput.current?.click()}>Import</button>
          <input ref={fileInput} type="file" hidden accept=".ts,.js,.mjs,.cjs" aria-label="Import script file"
            onChange={(e) => void onImport(e)} />
          <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'hint', action: 'Record' })}>Record</button>
          <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'hint', action: 'Generate' })}>Generate</button>
        </div>
      )}

      <div className="toolbar">
        <input type="search" placeholder="Search scripts..." aria-label="Search scripts" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <label htmlFor="tag-filter">Tag</label>
        <select id="tag-filter" value={tag} onChange={(e) => pickTag(e.target.value)}>
          <option value="">All tags</option>
          {tagOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button className="btn btn-secondary" onClick={refresh}>Refresh</button>
      </div>

      {problem && <p className="error" role="alert">{problem}</p>}
      {scripts.error && <p className="error" role="alert">{scripts.error}</p>}
      {scripts.loading && !data && <p className="muted">Loading scripts…</p>}
      {data && data.items.length === 0 && (
        <p className="muted center">{debouncedSearch || tag ? 'No scripts match.' : 'No scripts yet.'}</p>
      )}

      {data && data.items.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Script</th>
                <th>Version</th>
                <th>State</th>
                <th>Tags</th>
                <th>Last Updated</th>
                <th>Updated By</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((script) => (
                <tr key={script.id}>
                  <td>
                    <Link to={`/scripts/${script.id}`}>{script.name}</Link>
                    {script.description && <div className="muted">{script.description}</div>}
                  </td>
                  <td>v{script.version}</td>
                  <td><StatusBadge status={script.lifecycleState} /></td>
                  <td>
                    {script.tags.map((name) => (
                      <button key={name} className="chip" title={`Filter by ${name}`} onClick={() => pickTag(name)}>
                        {name}
                      </button>
                    ))}
                  </td>
                  <td className="muted">{new Date(script.updatedAt).toLocaleString()}</td>
                  <td className="muted">{script.updatedBy ?? '—'}</td>
                  <td className="actions">
                    <Link className="btn btn-secondary btn-sm" to={`/scripts/${script.id}`}>View</Link>
                    {canWrite && (
                      <Link className="btn btn-secondary btn-sm" to={`/scripts/${script.id}?edit=1`}>Edit</Link>
                    )}
                    {canWrite && (
                      <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'duplicate', script })}>
                        Duplicate
                      </button>
                    )}
                    <Link className="btn btn-secondary btn-sm" to={`/scripts/${script.id}/versions`}>Version History</Link>
                    <button className="btn btn-secondary btn-sm" onClick={() => void download(script)}>Download</button>
                    <button className="btn btn-secondary btn-sm" disabled title="Coming soon">Run</button>
                    <button className="btn btn-secondary btn-sm" disabled title="Coming soon">Heal</button>
                    {canWrite && (
                      <button className="btn btn-danger btn-sm" onClick={() => setDialog({ kind: 'delete', script })}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="pager">
          <span className="muted">{first}–{last} of {data.total}</span>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <button className="btn btn-secondary btn-sm" disabled={page * SCRIPTS_PAGE_SIZE >= data.total}
            onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}

      {dialog?.kind === 'duplicate' && (
        <DuplicateForm script={dialog.script} onCancel={close} onDone={closeAndRefresh} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Are you sure?"
          message="This will remove the script from the project."
          confirmLabel="Delete"
          danger
          onCancel={close}
          onConfirm={async () => {
            await scriptsApi.remove(dialog.script.id);
            closeAndRefresh();
          }}
        />
      )}
      {dialog?.kind === 'hint' && (
        <Modal title={`${dialog.action} in the extension`} onClose={close}>
          <p>{HINTS[dialog.action]}</p>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={close}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface DuplicateFormProps {
  script: ScriptListItem;
  onDone(): void;
  onCancel(): void;
}

function DuplicateForm({ script, onDone, onCancel }: DuplicateFormProps) {
  // The same default the server would choose, shown so it can be changed first.
  const [name, setName] = useState(`${script.name.slice(0, 200 - COPY_SUFFIX.length)}${COPY_SUFFIX}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await scriptsApi.duplicate(script.id, name);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Duplicate script" onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="duplicate-name">Name</label>
        <input id="duplicate-name" required maxLength={200} autoFocus value={name}
          onChange={(e) => setName(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>Duplicate</button>
        </div>
      </form>
    </Modal>
  );
}
```

Replace `PlaywrightPlatform/web/src/pages/ProjectDashboardPage.tsx` with:

```tsx
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { projectsApi } from '../api/projects';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';
import { ScriptsTab } from './ScriptsTab';

const TABS = ['Overview', 'Scripts', 'Executions', 'CI/CD', 'Reports', 'Skills', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** 'CI/CD' becomes 'ci-cd'. The slug is what the address shows as ?tab=. */
function slug(tab: Tab): string {
  return tab.toLowerCase().replace(/[^a-z]+/g, '-');
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

export function ProjectDashboardPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((name) => slug(name) === params.get('tab')) ?? 'Overview';
  const { data, error, loading, reload } = useLoad(() => projectsApi.get(id), [id]);

  function open(name: Tab) {
    // Replaced, not pushed: Back then leaves the project instead of walking through its tabs.
    setParams(name === 'Overview' ? {} : { tab: slug(name) }, { replace: true });
    if (name === 'Overview') reload(); // the counters may have changed on another tab
  }

  if (error) {
    return (
      <>
        <p className="error" role="alert">{error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  // While a different project is loading, the previous one must not be shown under the new address.
  if (!data || (loading && data.project.id !== id)) return <p className="muted">Loading project…</p>;

  const { project, overview } = data;
  const stats: [string, string | number][] = [
    ['Total Scripts', overview.totalScripts],
    ['Passed Tests', overview.passedScripts],
    ['Failed Tests', overview.failedScripts],
    ['Not Executed', overview.notExecuted],
    ['Last Execution', formatWhen(overview.lastExecutionAt)],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} role="tab" className="tab" aria-selected={tab === name} onClick={() => open(name)}>
            {name}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="stats">
          {stats.map(([label, value]) => (
            <div className="card" key={label}>
              <div className="stat-value">{value}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
      )}
      {tab === 'Scripts' && <ScriptsTab project={project} />}
      {tab !== 'Overview' && tab !== 'Scripts' && <p className="muted center">{tab} is not available yet.</p>}
    </>
  );
}
```

Append to `PlaywrightPlatform/web/src/styles.css`:

```css

a.btn { display: inline-block; text-decoration: none; }
a.btn:hover { text-decoration: none; }
.table-scroll { overflow-x: auto; }
.chip { display: inline-block; background: var(--bg3); color: var(--text); border: 1px solid var(--border); border-radius: 999px; padding: 1px 8px; font: inherit; font-size: 11px; margin: 0 4px 2px 0; }
button.chip { cursor: pointer; }
button.chip:hover { border-color: var(--accent); color: var(--accent); }
.pager { display: flex; align-items: center; justify-content: flex-end; gap: 8px; margin-top: 12px; }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npm run test:e2e -w web -- scripts-tab.spec.ts`
Expected: PASS, 5 passed.

Run: `npm run test:e2e`
Expected: PASS, every spec file (the 10 existing tests plus these 5), 0 failed.

Run: `npm run typecheck`
Expected: no output from either workspace, exit code 0.

Check that only the API folder calls `fetch` (run from the repo root):

```bash
grep -rn "fetch(" PlaywrightPlatform/web/src --include=*.ts --include=*.tsx | grep -v "src/api/" && echo "FAIL: fetch outside api/" || echo "web clean"
```

Expected: `web clean`.

- [ ] **Step 8: Commit**

```bash
git add PlaywrightPlatform/web PlaywrightPlatform/server/src/scripts/e2e-serve.ts
git commit -m "feat(platform): add the Scripts tab with search, tag filter, paging, and row actions"
```

---

### Task 6: Editor, New Script page, and Script page

**Files:**
- Create: `PlaywrightPlatform/web/src/components/CodeEditor.tsx`, `PlaywrightPlatform/web/src/components/CodeDiff.tsx`, `PlaywrightPlatform/web/src/components/TagInput.tsx`, `PlaywrightPlatform/web/src/hooks/useUnsavedGuard.tsx`, `PlaywrightPlatform/web/src/pages/NewScriptPage.tsx`, `PlaywrightPlatform/web/src/pages/ScriptPage.tsx`
- Modify: `PlaywrightPlatform/web/package.json` (through `npm install`), `PlaywrightPlatform/web/src/main.tsx`, `PlaywrightPlatform/web/src/App.tsx`, `PlaywrightPlatform/web/src/styles.css`, `PlaywrightPlatform/web/e2e/helpers.ts`
- Test: `PlaywrightPlatform/web/e2e/script-editor.spec.ts`

**Interfaces:**
- Consumes (Task 5): `scriptsApi`, `ScriptPatch`, `VersionConflict`, `ApiError`, `errorMessage`, `saveTextFile`, `ImportedScript` (router state `{ imported }`), `useDebounced`, `useLoad`, `useAuth`, `ConfirmDialog`, `StatusBadge`, E2E helpers
- Produces:
  - `CodeEditor({ label, value, language, readOnly?, onChange? })`. `label` becomes the accessible name of the text area, so tests find it with `getByRole('textbox', { name: label })`.
  - `CodeDiff({ left, right, leftLabel, rightLabel, language })`, read-only, side by side
  - `TagInput({ id, tags, onChange })`
  - `useUnsavedGuard(dirty): { dialog: ReactNode; allowLeave(): void }`
  - Pages `NewScriptPage` at `/projects/:projectId/scripts/new` and `ScriptPage` at `/scripts/:id` (`?edit=1` for edit mode); a `lazyPage(node)` helper in `App.tsx`
  - CSS classes: `.code-editor`, `.code-diff`, `.tag-input`, `.chip-remove`, `.field-label`, `.field-row`, `.pre-wrap`, `.notice`, `.notice-warn`
  - E2E helper `setEditorText(page, text)`

- [ ] **Step 1: Install CodeMirror**

Run (from `PlaywrightPlatform/`):

```bash
npm install -w web codemirror@^6.0.2 @codemirror/lang-javascript@^6.2.5 @codemirror/merge@^6.12.2 @codemirror/theme-one-dark@^6.1.3 @codemirror/state@^6 @codemirror/view@^6
```

Expected: the command finishes without errors and `web/package.json` lists all six packages under `dependencies`. If npm prints "in filter set, but no workspace folder present" and the file is unchanged, run the same command once more; that is a known npm quirk in this workspace.

- [ ] **Step 2: Add the editor test helper and write the failing browser tests**

Append to `PlaywrightPlatform/web/e2e/helpers.ts`:

```ts
/** Replaces the whole text of the script editor, the way select-all followed by a paste does. */
export async function setEditorText(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Script content' }).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}
```

`PlaywrightPlatform/web/e2e/script-editor.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import {
  ADMIN,
  USER,
  VIEWER,
  apiCreateProject,
  apiCreateScript,
  apiHeaders,
  apiSaveContent,
  scriptRow,
  setEditorText,
  signIn,
} from './helpers';

const V1 = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('first-version-marker', async ({ page }) => {",
  "  await page.goto('/login');",
  '});',
  '',
].join('\n');
const V2 = V1.replace('first-version-marker', 'second-version-marker');

test('a user creates a script, saves a second version, and is asked before losing changes', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Editor ${Date.now()}`);
  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await page.getByRole('link', { name: 'New Script' }).click();
  await expect(page.getByRole('heading', { name: 'New Script', level: 1 })).toBeVisible();

  // An empty script is refused before anything is sent.
  await page.getByLabel('Script Name').fill('Login Test');
  await page.getByRole('button', { name: 'Create Script' }).click();
  await expect(page.getByRole('alert')).toHaveText('Add the script content before saving.');

  await page.getByLabel('Description').fill('Signs in');
  await page.getByLabel('Tags', { exact: true }).fill('smoke');
  await page.getByLabel('Tags', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Remove tag smoke' })).toBeVisible();
  await setEditorText(page, V1);
  await page.getByRole('button', { name: 'Create Script' }).click();

  // The new script opens read-only.
  await expect(page.getByRole('heading', { name: 'Login Test', level: 1 })).toBeVisible();
  await expect(page.getByText('v1 ·')).toBeVisible();
  await expect(page.getByText('smoke', { exact: true })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('first-version-marker');
  await expect(editor).toHaveAttribute('contenteditable', 'false');

  // Edit mode: Save is offered only once something has changed.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\?edit=1$/);
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await setEditorText(page, V2);
  await page.getByLabel('Change summary (optional)').fill('Rename the test');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Saved as v2.');
  await expect(page.getByText('v2 ·')).toBeVisible();
  await expect(editor).toContainText('second-version-marker');
  await expect(save).toBeDisabled();

  // A metadata change saves without creating a version.
  await page.getByLabel('Description').fill('Signs in and out');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(page.getByText('v2 ·')).toBeVisible();

  // Leaving with unsaved text asks first.
  await setEditorText(page, '// throwaway-marker\n');
  await page.getByRole('link', { name: 'Back to scripts' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Discard unsaved changes?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toContainText('throwaway-marker');
  await page.getByRole('link', { name: 'Back to scripts' }).click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(scriptRow(page, 'Login Test')).toContainText('v2');
});

test('an imported file fills the new-script form and is stored as IMPORTED', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Import ${Date.now()}`);
  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  const picker = page.getByLabel('Import script file');

  await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByRole('alert')).toHaveText('Choose a .ts, .js, .mjs, or .cjs file.');
  await picker.setInputFiles({ name: 'empty.ts', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  await expect(page.getByRole('alert')).toHaveText('That file is empty.');

  // Windows line endings, as a file saved on Windows has.
  await picker.setInputFiles({
    name: 'checkout.spec.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from("// imported-marker\r\ntest('checkout', async () => {});\r\n"),
  });
  await expect(page.getByRole('heading', { name: 'Import Script', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Script Name')).toHaveValue('checkout');
  await expect(page.getByLabel('Language')).toHaveValue('JavaScript');
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('imported-marker');
  await page.getByRole('button', { name: 'Create Script' }).click();
  await expect(page.getByRole('heading', { name: 'checkout', level: 1 })).toBeVisible();

  // Opening it for editing shows no unsaved change: the line endings were normalised.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  const scriptId = Number(/\/scripts\/(\d+)/.exec(page.url())?.[1]);
  const versions = await request.get(`/api/scripts/${scriptId}/versions`, {
    headers: await apiHeaders(request, USER),
  });
  expect((await versions.json()).items).toMatchObject([{ version: 1, source: 'IMPORTED' }]);
});

test('a viewer sees a script read-only with no way to change it', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `ReadOnly ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Visible', content: V1, tags: ['smoke'] });

  await signIn(page, VIEWER);
  await page.goto(`/scripts/${scriptId}?edit=1`); // asking for edit mode changes nothing for a viewer
  await expect(page.getByRole('heading', { name: 'Visible', level: 1 })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('first-version-marker');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(page.getByLabel('Script Name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();

  // The new-script page sends a viewer back to the list.
  await page.goto(`/projects/${projectId}/scripts/new`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=scripts$`));
});

test('a save that collides with a newer version keeps the text and can reload the latest', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Conflict ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Shared', content: V1 });

  await signIn(page, USER);
  await page.goto(`/scripts/${scriptId}?edit=1`);
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('first-version-marker');
  await setEditorText(page, '// my-marker\n');

  await apiSaveContent(request, ADMIN, scriptId, '// their-marker\n', 1);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('E2E Admin saved v2 while you were editing.');
  await expect(editor).toContainText('my-marker');

  await page.getByRole('button', { name: 'Reload latest' }).click();
  await expect(editor).toContainText('their-marker');
  await expect(page.getByText('v2 ·')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('after a conflict from another browser, the two texts can be compared and mine kept', async ({ page, browser, request }) => {
  const projectId = await apiCreateProject(request, `Compare ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Shared', content: V1 });

  await signIn(page, USER);
  await page.goto(`/scripts/${scriptId}?edit=1`);
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('first-version-marker');
  await setEditorText(page, '// my-marker\n');

  // Someone else saves first, in a separate browser session.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, ADMIN);
  await other.goto(`/scripts/${scriptId}?edit=1`);
  await expect(other.getByRole('textbox', { name: 'Script content' })).toContainText('first-version-marker');
  await setEditorText(other, '// their-marker\n');
  await other.getByRole('button', { name: 'Save' }).click();
  await expect(other.getByRole('status')).toHaveText('Saved as v2.');
  await otherContext.close();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('E2E Admin saved v2 while you were editing.');
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('my-marker');

  await page.getByRole('button', { name: 'Compare with latest' }).click();
  await expect(page.getByRole('textbox', { name: 'Latest version' })).toContainText('their-marker');
  await expect(page.getByRole('textbox', { name: 'Your text' })).toContainText('my-marker');

  await page.getByRole('button', { name: 'Keep my text' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as v3.');
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('my-marker');
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:e2e -w web -- script-editor.spec.ts`
Expected: FAIL, all five. `/projects/:id/scripts/new` and `/scripts/:id` are unknown routes that redirect to the project list, so the tests time out waiting for the "New Script" heading or for the script's heading.

- [ ] **Step 4: Switch to a data router and add the unsaved-changes guard**

Replace `PlaywrightPlatform/web/src/main.tsx` with:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { AuthProvider } from './auth/AuthContext';
import './styles.css';

// A data router with one catch-all route: App keeps its <Routes> tree, and pages can
// use useBlocker to ask before unsaved changes are lost.
const router = createBrowserRouter([
  {
    path: '*',
    element: (
      <AuthProvider>
        <App />
      </AuthProvider>
    ),
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
```

`PlaywrightPlatform/web/src/hooks/useUnsavedGuard.tsx`:

```tsx
import { useEffect, useRef, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';

export interface UnsavedGuard {
  /** Render this somewhere in the page: it is the confirmation dialog, or null. */
  dialog: ReactNode;
  /** Call right before navigating away on purpose, for example after a successful save. */
  allowLeave(): void;
}

/**
 * While `dirty` is true, asks before the user leaves the page through a link or the
 * Back button, and lets the browser warn on reload and on closing the tab.
 * Changing only the query string (for example ?edit=1) is not leaving.
 */
export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const leaving = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ''; // older browsers show the prompt only when this is set
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const dialog =
    blocker.state === 'blocked' ? (
      <ConfirmDialog
        title="Discard unsaved changes?"
        message="You have changes that are not saved. Leave this page and lose them?"
        confirmLabel="Discard changes"
        danger
        onCancel={() => blocker.reset?.()}
        onConfirm={async () => blocker.proceed?.()}
      />
    ) : null;

  return {
    dialog,
    allowLeave: () => {
      leaving.current = true;
    },
  };
}
```

- [ ] **Step 5: Add the two CodeMirror wrappers and the tag input**

`PlaywrightPlatform/web/src/components/CodeEditor.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { javascript } from '@codemirror/lang-javascript';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type { ScriptLanguage } from '../api/types';

interface Props {
  /** Accessible name of the text area. */
  label: string;
  value: string;
  language: ScriptLanguage;
  readOnly?: boolean;
  onChange?(value: string): void;
}

const syntax = (language: ScriptLanguage): Extension => javascript({ typescript: language === 'TypeScript' });
const access = (readOnly: boolean): Extension => [
  EditorState.readOnly.of(readOnly),
  EditorView.editable.of(!readOnly),
];

/** A code editor. Pages use this component and never touch CodeMirror themselves. */
export function CodeEditor({ label, value, language, readOnly = false, onChange }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const compartments = useRef({ syntax: new Compartment(), access: new Compartment() });
  // The change listener is installed once, so it reaches the current callback through a ref.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  useEffect(() => {
    const editor = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          oneDark,
          compartments.current.syntax.of(syntax(language)),
          compartments.current.access.of(access(readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': label }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChangeRef.current?.(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    return () => {
      editor.destroy();
      view.current = null;
    };
    // Built once. Later changes to value, language, and readOnly are applied by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A value that did not come from typing (a load, a reload, a reset) replaces the document.
  useEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const current = editor.state.doc.toString();
    if (current !== value) editor.dispatch({ changes: { from: 0, to: current.length, insert: value } });
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.syntax.reconfigure(syntax(language)) });
  }, [language]);

  useEffect(() => {
    view.current?.dispatch({ effects: compartments.current.access.reconfigure(access(readOnly)) });
  }, [readOnly]);

  return <div className="code-editor" ref={host} />;
}
```

`PlaywrightPlatform/web/src/components/CodeDiff.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { javascript } from '@codemirror/lang-javascript';
import { MergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { oneDark } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { basicSetup } from 'codemirror';
import type { ScriptLanguage } from '../api/types';

interface Props {
  left: string;
  right: string;
  /** Accessible names of the two panes. */
  leftLabel: string;
  rightLabel: string;
  language: ScriptLanguage;
}

/** A read-only, side-by-side comparison of two texts with the differences highlighted. */
export function CodeDiff({ left, right, leftLabel, rightLabel, language }: Props) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const pane = (label: string): Extension => [
      basicSetup,
      oneDark,
      javascript({ typescript: language === 'TypeScript' }),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': label }),
    ];
    const merge = new MergeView({
      parent: host.current!,
      a: { doc: left, extensions: pane(leftLabel) },
      b: { doc: right, extensions: pane(rightLabel) },
      collapseUnchanged: { margin: 3, minSize: 6 },
    });
    return () => merge.destroy();
  }, [left, right, leftLabel, rightLabel, language]);

  return <div className="code-diff" ref={host} />;
}
```

`PlaywrightPlatform/web/src/components/TagInput.tsx`:

```tsx
import { useId, useState, type KeyboardEvent } from 'react';
import { scriptsApi } from '../api/scripts';
import { useDebounced } from '../hooks/useDebounced';
import { useLoad } from '../hooks/useLoad';

const MAX_TAGS = 20;
// The same rule the server enforces.
const TAG_PATTERN = /^[\p{L}\p{N} _.@-]{1,40}$/u;

interface Props {
  /** Id of the text box, so a <label htmlFor> can point at it. */
  id: string;
  tags: string[];
  onChange(tags: string[]): void;
}

/** Tags as removable chips plus a text box. Enter or a comma adds the typed tag; existing tags are suggested. */
export function TagInput({ id, tags, onChange }: Props) {
  const listId = useId();
  const [text, setText] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const debounced = useDebounced(text, 200);
  const suggestions = useLoad(() => scriptsApi.tags(debounced), [debounced]);

  function add() {
    const value = text.trim();
    if (!value) return;
    if (!TAG_PATTERN.test(value)) {
      setProblem('A tag is 1 to 40 letters, digits, spaces, or - _ . @');
      return;
    }
    if (tags.some((tag) => tag.toLowerCase() === value.toLowerCase())) {
      setText('');
      setProblem(null);
      return;
    }
    if (tags.length >= MAX_TAGS) {
      setProblem('A script can have at most 20 tags.');
      return;
    }
    onChange([...tags, value]);
    setText('');
    setProblem(null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault(); // Enter must not submit the surrounding form
      add();
    } else if (event.key === 'Backspace' && text === '' && tags.length > 0) {
      onChange(tags.slice(0, -1));
    }
  }

  return (
    <div className="tag-input">
      {tags.map((name) => (
        <span key={name} className="chip">
          {name}
          <button type="button" className="chip-remove" aria-label={`Remove tag ${name}`}
            onClick={() => onChange(tags.filter((tag) => tag !== name))}>
            ×
          </button>
        </span>
      ))}
      <input id={id} list={listId} value={text} placeholder="Add a tag" maxLength={40}
        onChange={(e) => setText(e.target.value)} onKeyDown={onKeyDown} onBlur={add} />
      <datalist id={listId}>
        {(suggestions.data?.items ?? [])
          .filter((name) => !tags.includes(name))
          .map((name) => <option key={name} value={name} />)}
      </datalist>
      {problem && <p className="error" role="alert">{problem}</p>}
    </div>
  );
}
```

- [ ] **Step 6: Add the New Script page**

`PlaywrightPlatform/web/src/pages/NewScriptPage.tsx`:

```tsx
import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { projectsApi } from '../api/projects';
import { scriptsApi } from '../api/scripts';
import type { ScriptLanguage, ScriptType } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CodeEditor } from '../components/CodeEditor';
import { TagInput } from '../components/TagInput';
import { useLoad } from '../hooks/useLoad';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import type { ImportedScript } from '../importFile';

export function NewScriptPage() {
  const projectId = Number(useParams().projectId);
  const { user } = useAuth();
  const navigate = useNavigate();
  // Set by the Import button on the Scripts tab.
  const imported = (useLocation().state as { imported?: ImportedScript } | null)?.imported;
  const project = useLoad(() => projectsApi.get(projectId), [projectId]);

  const [name, setName] = useState(imported?.name ?? '');
  const [description, setDescription] = useState('');
  const [testScenario, setTestScenario] = useState('');
  const [language, setLanguage] = useState<ScriptLanguage>(imported?.language ?? 'TypeScript');
  const [scriptType, setScriptType] = useState<ScriptType>('E2E');
  const [tags, setTags] = useState<string[]>([]);
  const [content, setContent] = useState(imported?.content ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isViewer = user?.role === 'VIEWER';
  const dirty = !isViewer && Boolean(name || description || testScenario || content || tags.length > 0);
  const guard = useUnsavedGuard(dirty);
  const back = `/projects/${projectId}?tab=scripts`;

  if (isViewer) return <Navigate to={back} replace />;
  if (project.error) {
    return (
      <>
        <p className="error" role="alert">{project.error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) {
      setError('Add the script content before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { script } = await scriptsApi.create(projectId, {
        name,
        description,
        testScenario,
        content,
        language,
        scriptType,
        tags,
        source: imported ? 'IMPORTED' : 'MANUAL',
      });
      guard.allowLeave();
      // Replaced, so Back from the new script does not return to this filled-in form.
      navigate(`/scripts/${script.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{imported ? 'Import Script' : 'New Script'}</h1>
          {project.data && <p className="muted">Project: {project.data.project.name}</p>}
        </div>
        <Link to={back}>Back to scripts</Link>
      </div>

      <form className="form" onSubmit={submit}>
        <label htmlFor="script-name">Script Name</label>
        <input id="script-name" required maxLength={200} autoFocus value={name}
          onChange={(e) => setName(e.target.value)} />

        <label htmlFor="script-description">Description</label>
        <textarea id="script-description" maxLength={2000} value={description}
          onChange={(e) => setDescription(e.target.value)} />

        <label htmlFor="script-scenario">Test Scenario</label>
        <textarea id="script-scenario" maxLength={5000} value={testScenario}
          onChange={(e) => setTestScenario(e.target.value)} />

        <div className="field-row">
          <div className="form">
            <label htmlFor="script-language">Language</label>
            <select id="script-language" value={language}
              onChange={(e) => setLanguage(e.target.value as ScriptLanguage)}>
              <option value="TypeScript">TypeScript</option>
              <option value="JavaScript">JavaScript</option>
            </select>
          </div>
          <div className="form">
            <label htmlFor="script-type">Type</label>
            <select id="script-type" value={scriptType} onChange={(e) => setScriptType(e.target.value as ScriptType)}>
              <option value="E2E">E2E</option>
              <option value="API">API</option>
              <option value="COMPONENT">Component</option>
            </select>
          </div>
        </div>

        <label htmlFor="script-tags">Tags</label>
        <TagInput id="script-tags" tags={tags} onChange={setTags} />

        <span className="field-label">Script</span>
        <CodeEditor label="Script content" value={content} language={language} onChange={setContent} />

        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <Link className="btn btn-secondary" to={back}>Cancel</Link>
          <button type="submit" className="btn btn-primary" disabled={busy}>Create Script</button>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}
```

- [ ] **Step 7: Add the Script page**

`PlaywrightPlatform/web/src/pages/ScriptPage.tsx`:

```tsx
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { scriptsApi, type ScriptPatch, type VersionConflict } from '../api/scripts';
import type { Script } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CodeDiff } from '../components/CodeDiff';
import { CodeEditor } from '../components/CodeEditor';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/StatusBadge';
import { TagInput } from '../components/TagInput';
import { saveTextFile } from '../download';
import { useLoad } from '../hooks/useLoad';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';

/** The fields a user can edit on this page. */
interface Draft {
  name: string;
  description: string;
  testScenario: string;
  tags: string[];
  content: string;
}

function draftOf(script: Script): Draft {
  return {
    name: script.name,
    description: script.description,
    testScenario: script.testScenario,
    tags: script.tags,
    content: script.content,
  };
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

export function ScriptPage() {
  const id = Number(useParams().id);
  const loaded = useLoad(() => scriptsApi.get(id), [id]);

  if (loaded.error) {
    return (
      <>
        <p className="error" role="alert">{loaded.error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  if (!loaded.data || loaded.data.script.id !== id) return <p className="muted">Loading script…</p>;
  // Keyed, so opening another script starts from a clean state.
  return <ScriptEditor key={id} initial={loaded.data.script} />;
}

function ScriptEditor({ initial }: { initial: Script }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  // `base` is the script as last saved or loaded; `draft` is what is on screen.
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [changeSummary, setChangeSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<VersionConflict | null>(null);
  const [latest, setLatest] = useState<Script | null>(null); // fetched for "Compare with latest"
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const canWrite = user?.role === 'ADMIN' || user?.role === 'USER';
  const editing = canWrite && params.get('edit') === '1';
  const changed = {
    name: draft.name !== base.name,
    description: draft.description !== base.description,
    testScenario: draft.testScenario !== base.testScenario,
    tags: !sameTags(draft.tags, base.tags),
    content: draft.content !== base.content,
  };
  const dirty = editing && Object.values(changed).some(Boolean);
  const guard = useUnsavedGuard(dirty);

  /** Shows `script` as the saved state and drops any edits. */
  function show(script: Script) {
    setBase(script);
    setDraft(draftOf(script));
    setChangeSummary('');
    setConflict(null);
    setLatest(null);
  }

  /** Runs a request with the busy flag set and reports a failure on the page. */
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await work();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        setConflict(err.details as VersionConflict);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      if (!draft.name.trim()) throw new Error('Script name is required.');
      if (!draft.content) throw new Error('Script content cannot be empty.');

      // Only what changed is sent; content always travels with the version it was based on.
      const patch: ScriptPatch = {};
      if (changed.name) patch.name = draft.name;
      if (changed.description) patch.description = draft.description;
      if (changed.testScenario) patch.testScenario = draft.testScenario;
      if (changed.tags) patch.tags = draft.tags;
      if (changed.content) {
        patch.content = draft.content;
        patch.baseVersion = base.version;
        if (changeSummary.trim()) patch.changeSummary = changeSummary.trim();
      }

      const { script } = await scriptsApi.update(base.id, patch);
      const message = script.version === base.version ? 'Saved.' : `Saved as v${script.version}.`;
      show(script);
      setStatus(message);
    });

  const reloadLatest = () =>
    run(async () => {
      show((await scriptsApi.get(base.id)).script);
    });

  const compareWithLatest = () =>
    run(async () => {
      setLatest((await scriptsApi.get(base.id)).script);
    });

  /** Keeps what the user changed, on top of the latest version, so the next Save succeeds. */
  function keepMine() {
    if (!latest) return;
    setDraft({
      name: changed.name ? draft.name : latest.name,
      description: changed.description ? draft.description : latest.description,
      testScenario: changed.testScenario ? draft.testScenario : latest.testScenario,
      tags: changed.tags ? draft.tags : latest.tags,
      content: draft.content,
    });
    setBase(latest);
    setConflict(null);
    setLatest(null);
    setStatus(`Your text is now based on v${latest.version}. Save to store it as v${latest.version + 1}.`);
  }

  const download = () =>
    run(async () => {
      const file = await scriptsApi.download(base.id);
      saveTextFile(file.fileName, file.text);
    });

  const startEditing = () => setParams({ edit: '1' }, { replace: true });
  const stopEditing = () => {
    show(base);
    setError(null);
    setStatus(null);
    setConfirmDiscard(false);
    setParams({}, { replace: true });
  };
  const cancel = () => (dirty ? setConfirmDiscard(true) : stopEditing());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{base.name}</h1>
          <p className="muted">
            v{base.version} · {base.language} · {base.scriptType} · updated {new Date(base.updatedAt).toLocaleString()}
            {base.updatedBy ? ` by ${base.updatedBy}` : ''}
          </p>
        </div>
        <StatusBadge status={base.lifecycleState} />
      </div>

      <div className="toolbar">
        <Link to={`/projects/${base.projectId}?tab=scripts`}>Back to scripts</Link>
        <Link className="btn btn-secondary" to={`/scripts/${base.id}/versions`}>Version History</Link>
        <button className="btn btn-secondary" onClick={() => void download()} disabled={busy}>Download</button>
        {canWrite && !editing && <button className="btn btn-primary" onClick={startEditing}>Edit</button>}
      </div>

      {conflict && (
        <div className="notice notice-warn" role="alert">
          <p>
            {conflict.updatedBy ?? 'Someone else'} saved v{conflict.currentVersion} while you were editing.
            Your text is still in the editor and has not been saved.
          </p>
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={() => void reloadLatest()} disabled={busy}>
              Reload latest
            </button>
            <button className="btn btn-secondary" onClick={() => void compareWithLatest()} disabled={busy}>
              Compare with latest
            </button>
          </div>
        </div>
      )}

      {latest && (
        <section className="notice" aria-label="Comparison with the latest version">
          <h2>Latest version (v{latest.version}) on the left, your text on the right</h2>
          <CodeDiff left={latest.content} right={draft.content} leftLabel="Latest version" rightLabel="Your text"
            language={base.language} />
          <div className="form-actions">
            <button className="btn btn-primary" onClick={keepMine}>Keep my text</button>
          </div>
        </section>
      )}

      {editing ? (
        <div className="form">
          <label htmlFor="script-name">Script Name</label>
          <input id="script-name" maxLength={200} value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="script-description">Description</label>
          <textarea id="script-description" maxLength={2000} value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <label htmlFor="script-scenario">Test Scenario</label>
          <textarea id="script-scenario" maxLength={5000} value={draft.testScenario}
            onChange={(e) => setDraft({ ...draft, testScenario: e.target.value })} />
          <label htmlFor="script-tags">Tags</label>
          <TagInput id="script-tags" tags={draft.tags} onChange={(tags) => setDraft((d) => ({ ...d, tags }))} />
        </div>
      ) : (
        <>
          {base.description && <p>{base.description}</p>}
          {base.testScenario && (
            <>
              <h2>Test Scenario</h2>
              <p className="pre-wrap">{base.testScenario}</p>
            </>
          )}
          {base.tags.length > 0 && (
            <p>
              {base.tags.map((name) => <span key={name} className="chip">{name}</span>)}
            </p>
          )}
        </>
      )}

      <span className="field-label">Script</span>
      <CodeEditor
        label="Script content"
        value={draft.content}
        language={base.language}
        readOnly={!editing}
        onChange={(content) => setDraft((d) => ({ ...d, content }))}
      />

      {error && <p className="error" role="alert">{error}</p>}
      {status && <p className="muted" role="status">{status}</p>}

      {editing && (
        <div className="form">
          <label htmlFor="change-summary">Change summary (optional)</label>
          <input id="change-summary" maxLength={500} value={changeSummary} placeholder="What changed in this version?"
            onChange={(e) => setChangeSummary(e.target.value)} />
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={cancel} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !dirty}>Save</button>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="Your edits to this script will be lost."
          confirmLabel="Discard changes"
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={async () => stopEditing()}
        />
      )}
      {guard.dialog}
    </>
  );
}
```

- [ ] **Step 8: Register the routes and add the styles**

Replace `PlaywrightPlatform/web/src/App.tsx` with:

```tsx
import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { ProjectDashboardPage } from './pages/ProjectDashboardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { UsersPage } from './pages/UsersPage';

// These pages pull in CodeMirror, so their code is fetched only when one of them is opened.
const NewScriptPage = lazy(() => import('./pages/NewScriptPage').then((m) => ({ default: m.NewScriptPage })));
const ScriptPage = lazy(() => import('./pages/ScriptPage').then((m) => ({ default: m.ScriptPage })));

/** Wraps a lazily loaded page so only the page area, not the whole shell, waits for its code. */
function lazyPage(page: ReactNode) {
  return <Suspense fallback={<p className="muted">Loading…</p>}>{page}</Suspense>;
}

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <AppShell />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDashboardPage />} />
        <Route path="/projects/:projectId/scripts/new" element={lazyPage(<NewScriptPage />)} />
        <Route path="/scripts/:id" element={lazyPage(<ScriptPage />)} />
        <Route path="/settings/users" element={<UsersPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}
```

Append to `PlaywrightPlatform/web/src/styles.css`:

```css

.field-label { color: var(--text2); font-size: 12px; margin-top: 6px; display: block; }
.field-row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.pre-wrap { white-space: pre-wrap; }
.tag-input { display: flex; flex-wrap: wrap; align-items: center; gap: 4px; }
.tag-input input { flex: 1; min-width: 140px; }
.tag-input .error { flex-basis: 100%; }
.chip-remove { background: none; border: none; color: var(--text2); cursor: pointer; padding: 0 0 0 6px; font: inherit; }
.chip-remove:hover { color: var(--danger); }
.code-editor, .code-diff { border: 1px solid var(--border); border-radius: var(--radius); margin: 6px 0 12px; }
.code-editor { overflow: hidden; }
.code-editor .cm-editor { height: 55vh; }
.code-diff { max-height: 60vh; overflow: auto; }
.cm-editor .cm-scroller { font-family: 'Cascadia Code', 'Fira Code', Consolas, monospace; font-size: 13px; }
.notice { border: 1px solid var(--border); border-radius: var(--radius); padding: 12px 16px; margin-bottom: 12px; }
.notice-warn { border-color: var(--warn); }
.notice p { margin: 0; }
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npm run test:e2e -w web -- script-editor.spec.ts`
Expected: PASS, 5 passed.

Run: `npm run test:e2e`
Expected: PASS, every spec file, 0 failed. The older specs prove that sign-in, redirects, and the session-expiry redirect still work under the data router.

Run: `npm run typecheck`
Expected: no output from either workspace, exit code 0.

Check that CodeMirror stays inside its two wrappers and out of the start-up bundle (run from the repo root):

```bash
grep -rln "codemirror" PlaywrightPlatform/web/src | grep -v "components/CodeEditor.tsx\|components/CodeDiff.tsx" && echo "FAIL: CodeMirror used outside its wrappers" || echo "codemirror contained"
(cd PlaywrightPlatform && npm run build -w web)
entry=$(grep -o 'assets/index-[^"]*\.js' PlaywrightPlatform/web/dist/index.html | head -1)
grep -c "cm-editor" "PlaywrightPlatform/web/dist/$entry"
```

Expected: `codemirror contained`; the build succeeds; the last command prints `0` (the file the page loads first contains no CodeMirror code).

- [ ] **Step 10: Commit**

```bash
git add PlaywrightPlatform/web PlaywrightPlatform/package-lock.json
git commit -m "feat(platform): add the script editor, new-script page, import, and conflict handling"
```

---

### Task 7: Version history page

**Files:**
- Create: `PlaywrightPlatform/web/src/pages/ScriptVersionsPage.tsx`
- Modify: `PlaywrightPlatform/web/src/App.tsx`
- Test: `PlaywrightPlatform/web/e2e/script-versions.spec.ts`

**Interfaces:**
- Consumes (Tasks 5–6): `scriptsApi.get`, `.versions`, `.version`, `.restore`, `.download`; `CodeDiff`; `ConfirmDialog`; `saveTextFile`; `useLoad`; `useAuth`; `lazyPage` in `App.tsx`; E2E helpers
- Produces: page `ScriptVersionsPage` at `/scripts/:id/versions`. The two comparison panes are named `Version <n>`, so tests find them with `getByRole('textbox', { name: 'Version 2' })`.

- [ ] **Step 1: Write the failing browser tests**

`PlaywrightPlatform/web/e2e/script-versions.spec.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { USER, VIEWER, apiCreateProject, apiCreateScript, apiSaveContent, signIn } from './helpers';

const V1 = "// first-version-marker\ntest('one', async () => {});\n";
const V2 = "// second-version-marker\ntest('one', async () => {});\n";

test('a user compares versions, downloads one, and restores the first', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `History ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Checkout', content: V1 });
  await apiSaveContent(request, USER, scriptId, V2, 1, 'Second take');

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await page.getByRole('link', { name: 'Version History' }).click();
  await expect(page.getByRole('heading', { name: 'Version History', level: 1 })).toBeVisible();
  await expect(page.getByText('Checkout · currently v2')).toBeVisible();

  // Newest first.
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(3); // the header row and two versions
  await expect(rows.nth(1)).toContainText('v2');
  await expect(rows.nth(1)).toContainText('Second take');
  await expect(rows.nth(1)).toContainText('E2E User');
  await expect(rows.nth(2)).toContainText('v1');
  await expect(rows.nth(2)).toContainText('MANUAL');

  // The default comparison is the latest version against the one before it.
  await expect(page.getByLabel('Older')).toHaveValue('1');
  await expect(page.getByLabel('Newer')).toHaveValue('2');
  await expect(page.getByRole('textbox', { name: 'Version 1' })).toContainText('first-version-marker');
  await expect(page.getByRole('textbox', { name: 'Version 2' })).toContainText('second-version-marker');

  // An old version downloads under a name that says which version it is.
  const downloading = page.waitForEvent('download');
  await rows.nth(2).getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('checkout.v1.spec.ts');
  expect(await readFile(await download.path(), 'utf8')).toBe(V1);

  // Only an older version can be restored, and only after confirming.
  await expect(rows.nth(1).getByRole('button', { name: 'Restore' })).toHaveCount(0);
  await rows.nth(2).getByRole('button', { name: 'Restore' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('This creates v3 with the content of v1.');
  await dialog.getByRole('button', { name: 'Restore' }).click();

  await expect(page.getByRole('status')).toHaveText('Restored v1 as v3.');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('v3');
  await expect(rows.nth(1)).toContainText('RESTORED');
  await expect(rows.nth(1)).toContainText('Restored from v1');
  await expect(page.getByLabel('Newer')).toHaveValue('3');
  await expect(page.getByRole('textbox', { name: 'Version 3' })).toContainText('first-version-marker');

  // Any two versions can be compared.
  await page.getByLabel('Older').selectOption('1');
  await expect(page.getByRole('textbox', { name: 'Version 1' })).toContainText('first-version-marker');

  // The script itself now shows the restored content.
  await page.getByRole('link', { name: 'Back to script' }).click();
  await expect(page.getByText('v3 ·')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('first-version-marker');
});

test('a viewer can read the history but cannot restore', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `ViewHistory ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Checkout', content: V1 });
  await apiSaveContent(request, USER, scriptId, V2, 1);

  await signIn(page, VIEWER);
  await page.goto(`/scripts/${scriptId}/versions`);
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('textbox', { name: 'Version 2' })).toContainText('second-version-marker');
  await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(2);
});

test('a script with one version says there is nothing to compare', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `OneVersion ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Fresh', content: V1 });

  await signIn(page, USER);
  await page.goto(`/scripts/${scriptId}/versions`);
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(page.getByText('This script has one version, so there is nothing to compare yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
});

test('an unknown script shows a clear message on its history page', async ({ page }) => {
  await signIn(page, USER);
  await page.goto('/scripts/99999999/versions');
  await expect(page.getByRole('alert')).toHaveText('Script not found.');
  await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test:e2e -w web -- script-versions.spec.ts`
Expected: FAIL, all four. `/scripts/:id/versions` is an unknown route that redirects to the project list, so each test times out waiting for the "Version History" heading, the rows, or the alert.

- [ ] **Step 3: Add the page**

`PlaywrightPlatform/web/src/pages/ScriptVersionsPage.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { scriptsApi } from '../api/scripts';
import { useAuth } from '../auth/AuthContext';
import { CodeDiff } from '../components/CodeDiff';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { saveTextFile } from '../download';
import { useLoad } from '../hooks/useLoad';

export function ScriptVersionsPage() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const canWrite = user?.role === 'ADMIN' || user?.role === 'USER';
  const script = useLoad(() => scriptsApi.get(id), [id]);
  const versions = useLoad(() => scriptsApi.versions(id), [id]);
  // The two versions being compared: `left` is shown as the older side.
  const [left, setLeft] = useState<number | null>(null);
  const [right, setRight] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Whenever the list is loaded or reloaded, compare the latest version with the one before it.
  useEffect(() => {
    const list = versions.data?.items;
    if (!list || list.length === 0) return;
    setRight(list[0].version);
    setLeft((list[1] ?? list[0]).version);
  }, [versions.data]);

  const pair = useLoad(async () => {
    if (left === null || right === null) return null;
    const [a, b] = await Promise.all([scriptsApi.version(id, left), scriptsApi.version(id, right)]);
    return { left: a.version, right: b.version };
  }, [id, left, right]);

  const error = script.error ?? versions.error;
  if (error) {
    return (
      <>
        <p className="error" role="alert">{error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  if (!script.data || !versions.data || script.data.script.id !== id) {
    return <p className="muted">Loading history…</p>;
  }

  const current = script.data.script;
  const items = versions.data.items;
  const latest = items[0]?.version ?? current.version;

  async function download(version: number) {
    try {
      const file = await scriptsApi.download(id, version);
      // "login.spec.ts" becomes "login.v1.spec.ts", so an old version is not mistaken for the latest.
      saveTextFile(file.fileName.replace('.spec.', `.v${version}.spec.`), file.text);
      setProblem(null);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Version History</h1>
          <p className="muted">{current.name} · currently v{current.version}</p>
        </div>
        <Link to={`/scripts/${id}`}>Back to script</Link>
      </div>

      {problem && <p className="error" role="alert">{problem}</p>}
      {status && <p className="muted" role="status">{status}</p>}

      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Source</th>
              <th>Summary</th>
              <th>Author</th>
              <th>Date</th>
              <th>Size</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((version) => (
              <tr key={version.version}>
                <td>
                  v{version.version} {version.version === latest && <span className="chip">latest</span>}
                </td>
                <td><span className="badge badge-neutral">{version.source}</span></td>
                <td>{version.changeSummary || <span className="muted">—</span>}</td>
                <td className="muted">{version.createdBy ?? '—'}</td>
                <td className="muted">{new Date(version.createdAt).toLocaleString()}</td>
                <td className="muted">{version.size.toLocaleString()} characters</td>
                <td className="actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => void download(version.version)}>
                    Download
                  </button>
                  {canWrite && version.version !== latest && (
                    <button className="btn btn-secondary btn-sm" onClick={() => setRestoring(version.version)}>
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 20 }}>Compare</h2>
      {items.length === 1 ? (
        <p className="muted">This script has one version, so there is nothing to compare yet.</p>
      ) : (
        <div className="toolbar">
          <label htmlFor="compare-left">Older</label>
          <select id="compare-left" value={left ?? ''} onChange={(e) => setLeft(Number(e.target.value))}>
            {items.map((version) => (
              <option key={version.version} value={version.version}>v{version.version}</option>
            ))}
          </select>
          <label htmlFor="compare-right">Newer</label>
          <select id="compare-right" value={right ?? ''} onChange={(e) => setRight(Number(e.target.value))}>
            {items.map((version) => (
              <option key={version.version} value={version.version}>v{version.version}</option>
            ))}
          </select>
        </div>
      )}
      {pair.error && <p className="error" role="alert">{pair.error}</p>}
      {pair.data && (
        <CodeDiff
          left={pair.data.left.content}
          right={pair.data.right.content}
          leftLabel={`Version ${pair.data.left.version}`}
          rightLabel={`Version ${pair.data.right.version}`}
          language={current.language}
        />
      )}

      {restoring !== null && (
        <ConfirmDialog
          title={`Restore v${restoring}?`}
          message={`This creates v${latest + 1} with the content of v${restoring}. No version is removed.`}
          confirmLabel="Restore"
          onCancel={() => setRestoring(null)}
          onConfirm={async () => {
            const { script: updated } = await scriptsApi.restore(id, restoring);
            setRestoring(null);
            setStatus(`Restored v${restoring} as v${updated.version}.`);
            versions.reload();
            script.reload();
          }}
        />
      )}
    </>
  );
}
```

- [ ] **Step 4: Register the route**

In `PlaywrightPlatform/web/src/App.tsx`, add below the `ScriptPage` constant:

```tsx
const ScriptVersionsPage = lazy(() =>
  import('./pages/ScriptVersionsPage').then((m) => ({ default: m.ScriptVersionsPage })),
);
```

Add below the `/scripts/:id` route:

```tsx
        <Route path="/scripts/:id/versions" element={lazyPage(<ScriptVersionsPage />)} />
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:e2e -w web -- script-versions.spec.ts`
Expected: PASS, 4 passed.

Run: `npm run test:e2e`
Expected: PASS, every spec file (24 tests: 10 from the foundation, 5 + 5 + 4 from this plan), 0 failed.

Run: `npm run typecheck`
Expected: no output from either workspace, exit code 0.

- [ ] **Step 6: Commit**

```bash
git add PlaywrightPlatform/web
git commit -m "feat(platform): add the version history page with comparison and restore"
```

---

### Task 8: Extension "Save to Project"

**Files:**
- Create: `PlaywrightExtension/utils/code-extract.js`, `PlaywrightExtension/tests/code-extract.test.mjs`
- Modify: `PlaywrightExtension/utils/platform-client.js`, `PlaywrightExtension/tests/platform-client.test.mjs`, `PlaywrightExtension/sidepanel.html`, `PlaywrightExtension/sidepanel.js`

**Interfaces:**
- Consumes: `POST /api/projects/:projectId/scripts` (Task 1); in `platform-client.js` the internal `request(baseUrl, path, { method, token, body })` and `signedIn()`; `PlatformClient.listProjects()`; `Storage.getPlatform()`; in `sidepanel.js` `showToast(msg)` and the existing element ids `gen-output`, `gen-language`, `rec-output`, `rec-edit-area`, `rec-language`, `rec-test-name`, `orch-output`, `orch-language`
- Produces:
  - `PlatformClient.saveScript(projectId: number, { name, description?, content, source, language }): Promise<script>`
  - `extractCode(text): string`, `sectionAfter(text, heading): string`, `looksLikeCode(text): boolean` in `utils/code-extract.js`
  - Buttons `#gen-save-project`, `#rec-save-project`, `#orch-save-project`; dialog `#save-project-overlay` with `#save-project-select`, `#save-project-name`, `#save-project-description`, `#save-project-status`, `#save-project-cancel`, `#save-project-confirm`
  - `setupSaveToProject()` in `sidepanel.js`, called from `init()`

The side panel cannot be driven by an automated test. The logic that can be wrong silently lives in the two helper modules and is unit-tested; the wiring is checked by hand in Task 9.

- [ ] **Step 1: Write the failing tests**

`PlaywrightExtension/tests/code-extract.test.mjs`:

```js
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { extractCode, looksLikeCode, sectionAfter } from '../utils/code-extract.js';

const FENCE = '`'.repeat(3);
const block = (language, body) => `${FENCE}${language}\n${body}\n${FENCE}`;

describe('extractCode', () => {
  it('returns text without fenced blocks unchanged', () => {
    const code = "import { test } from '@playwright/test';\n\ntest('a', async () => {});\n";
    assert.equal(extractCode(code), code);
  });

  it('returns the content of a single fenced block and drops the prose around it', () => {
    const text = `Here is your test:\n\n${block('typescript', "test('a', async () => {});")}\n\nRun it with npx playwright test.`;
    assert.equal(extractCode(text), "test('a', async () => {});");
  });

  it('joins several code blocks with a blank line between them', () => {
    const text = `${block('ts', 'const a = 1;')}\nand then\n${block('', 'const b = 2;')}`;
    assert.equal(extractCode(text), 'const a = 1;\n\nconst b = 2;');
  });

  it('skips blocks in other languages when a code block exists', () => {
    const text = [block('bash', 'npm install'), block('JavaScript', 'const a = 1;'), block('json', '{"a":1}')].join('\n');
    assert.equal(extractCode(text), 'const a = 1;');
  });

  it('falls back to every block when none is tagged as code', () => {
    const text = `${block('text', 'first')}\n${block('python', 'second')}`;
    assert.equal(extractCode(text), 'first\n\nsecond');
  });

  it('keeps blank lines and indentation inside a block', () => {
    const body = "test('a', async () => {\n\n  await page.goto('/');\n});";
    assert.equal(extractCode(block('ts', body)), body);
  });

  it('accepts extra words after the language and Windows line endings', () => {
    const text = `${FENCE}ts title="login.spec.ts"\r\nconst a = 1;\r\nconst b = 2;\r\n${FENCE}\r\n`;
    assert.equal(extractCode(text), 'const a = 1;\nconst b = 2;');
  });

  it('treats a fence that never closes as a block, as truncated model output has', () => {
    assert.equal(extractCode(`${FENCE}ts\nconst a = 1;\nconst b = 2;`), 'const a = 1;\nconst b = 2;');
  });

  it('handles empty and missing input', () => {
    assert.equal(extractCode(''), '');
    assert.equal(extractCode(null), '');
    assert.equal(extractCode(undefined), '');
  });
});

describe('sectionAfter', () => {
  it('returns the text after the heading, without leading blank lines', () => {
    const output = `## TEST PLAN\n\n1. Open login\n\n---\n\n## GENERATED CODE\n\n${block('ts', 'const a = 1;')}`;
    assert.equal(sectionAfter(output, '## GENERATED CODE'), block('ts', 'const a = 1;'));
  });

  it('returns the whole text when the heading is absent', () => {
    assert.equal(sectionAfter('Error: provider failed', '## GENERATED CODE'), 'Error: provider failed');
  });

  it('gives only the code when combined with extractCode, even if the plan has its own fenced block', () => {
    const output = `## TEST PLAN\n\n${block('text', 'plan notes')}\n\n---\n\n## GENERATED CODE\n\n${block('ts', 'const a = 1;')}`;
    assert.equal(extractCode(sectionAfter(output, '## GENERATED CODE')), 'const a = 1;');
  });

  it('handles missing input', () => {
    assert.equal(sectionAfter(null, '## GENERATED CODE'), '');
  });
});

describe('looksLikeCode', () => {
  it('refuses nothing, whitespace, and an error line', () => {
    for (const text of ['', '   \n ', null, undefined, 'Error: Failed to fetch', '  Error: provider said no']) {
      assert.equal(looksLikeCode(text), false);
    }
  });

  it('accepts code, including code that merely mentions an error', () => {
    assert.equal(looksLikeCode("test('a', async () => {});"), true);
    assert.equal(looksLikeCode("// shows Error: when the form is empty\ntest('a', async () => {});"), true);
  });
});
```

Append to `PlaywrightExtension/tests/platform-client.test.mjs`, inside the `describe('platform client', …)` block, directly above its closing `});`:

```js
  const SCRIPT = {
    name: 'Login Test',
    description: 'Signs in',
    content: "test('a', async () => {});",
    source: 'RECORDED',
    language: 'TypeScript',
  };

  it('saveScript posts the script with the bearer token and returns the created script', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(201, { script: { id: 9, name: 'Login Test', version: 1 } });

    const script = await client.saveScript(7, SCRIPT);

    assert.deepEqual(script, { id: 9, name: 'Login Test', version: 1 });
    assert.equal(calls[0].url, 'http://localhost:3000/api/projects/7/scripts');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(calls[0].init.headers.Authorization, 'Bearer tok-123');
    assert.deepEqual(JSON.parse(calls[0].init.body), SCRIPT);
  });

  it('saveScript sends an empty description when none is given', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () => json(201, { script: { id: 9 } });
    const { description, ...withoutDescription } = SCRIPT;
    await client.saveScript(7, withoutDescription);
    assert.equal(JSON.parse(calls[0].init.body).description, '');
  });

  it('saveScript surfaces the server message and status when the name is taken', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () =>
      json(409, {
        error: {
          code: 'SCRIPT_NAME_TAKEN',
          message: 'A script named "Login Test" already exists in this project.',
          details: null,
        },
      });
    await assert.rejects(client.saveScript(7, SCRIPT), (err) => {
      assert.equal(err.status, 409);
      assert.match(err.message, /already exists in this project/);
      return true;
    });
  });

  it('saveScript shows the specific validation problem, not the generic message', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    responder = () =>
      json(400, {
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed.',
          details: [{ path: 'content', message: 'Script content is too long (1,000,000 characters max).' }],
        },
      });
    await assert.rejects(client.saveScript(7, SCRIPT), /Script content is too long/);
  });

  it('saveScript requires a sign-in and sends nothing without one', async () => {
    await assert.rejects(client.saveScript(7, SCRIPT), /Sign in to the platform first/);
    assert.equal(calls.length, 0);
  });

  it('saveScript refuses a project id that is not a positive whole number', async () => {
    saved = { url: 'http://localhost:3000', token: 'tok-123', user: USER };
    for (const projectId of ['7/../../users', 0, -1, 1.5, NaN, undefined]) {
      await assert.rejects(client.saveScript(projectId, SCRIPT), /Choose a project/);
    }
    assert.equal(calls.length, 0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from the repo root): `node --test "PlaywrightExtension/tests/*.test.mjs"`
Expected: FAIL. `code-extract.test.mjs` fails to load with `Cannot find module …/utils/code-extract.js`, and the six new `saveScript` tests fail with `client.saveScript is not a function`. The 10 existing tests still pass.

- [ ] **Step 3: Add the code-extraction helpers**

`PlaywrightExtension/utils/code-extract.js`:

```js
// Turns the text shown in a side-panel output into plain code for "Save to Project".
// Pure functions: no DOM and no chrome.* APIs, so they run under `node --test`.

const FENCE = '`'.repeat(3);
const CODE_LANGUAGES = new Set(['', 'ts', 'typescript', 'js', 'javascript', 'tsx', 'jsx', 'mjs', 'cjs']);

/**
 * Model output often wraps code in fenced blocks with prose around them. If `text`
 * has fenced blocks, their contents are joined: the TypeScript, JavaScript, and
 * untagged ones when there are any, otherwise all of them. Text without fenced
 * blocks is returned unchanged.
 */
export function extractCode(text) {
  const source = String(text ?? '');
  const blocks = [];
  let open = null;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (open === null) {
      if (trimmed.startsWith(FENCE)) {
        // The first word after the fence is the language; anything after it is ignored.
        const language = trimmed.slice(FENCE.length).trim().split(/\s+/)[0].toLowerCase();
        open = { language, lines: [] };
      }
    } else if (trimmed === FENCE) {
      blocks.push(open);
      open = null;
    } else {
      open.lines.push(line);
    }
  }
  // A fence that never closes (truncated output) still counts as a block.
  if (open !== null && open.lines.length > 0) blocks.push(open);

  if (blocks.length === 0) return source;
  const code = blocks.filter((block) => CODE_LANGUAGES.has(block.language));
  return (code.length > 0 ? code : blocks).map((block) => block.lines.join('\n')).join('\n\n');
}

/** The text after the last occurrence of `heading`; all of `text` when the heading is absent. */
export function sectionAfter(text, heading) {
  const source = String(text ?? '');
  const at = source.lastIndexOf(heading);
  return at === -1 ? source : source.slice(at + heading.length).replace(/^\s+/, '');
}

/** False for what a panel shows instead of code: nothing at all, or an "Error: …" line. */
export function looksLikeCode(text) {
  const value = String(text ?? '').trim();
  return value !== '' && !value.startsWith('Error:');
}
```

- [ ] **Step 4: Add `saveScript` to the platform client**

In `PlaywrightExtension/utils/platform-client.js`, replace the `if (!res.ok) { … }` block inside `request` with:

```js
    if (!res.ok) {
      // A validation error lists its specific problems in `details`; the first one is more
      // useful than the generic message.
      const detail = Array.isArray(data?.error?.details) ? data.error.details[0]?.message : null;
      const err = new Error(detail || data?.error?.message || `Platform request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
```

Add this method to the returned object, after `listProjects`:

```js

    // Creates a script, with its first version, in a project. `source` is GENERATED or RECORDED;
    // `language` is TypeScript or JavaScript.
    async saveScript(projectId, { name, description = '', content, source, language }) {
      // The id goes into the URL path, so anything but a positive whole number is refused.
      if (!Number.isInteger(projectId) || projectId <= 0) throw new Error('Choose a project.');
      const platform = await signedIn();
      const { data } = await request(platform.url, `/projects/${projectId}/scripts`, {
        method: 'POST',
        token: platform.token,
        body: { name, description, content, source, language },
      });
      return data.script;
    },
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from the repo root): `node --test "PlaywrightExtension/tests/*.test.mjs"`
Expected: PASS, 0 failed (the 10 existing tests, 6 new `saveScript` tests, and 15 `code-extract` tests).

- [ ] **Step 6: Add the buttons and the dialog to the side panel**

In `PlaywrightExtension/sidepanel.html`, in the Generator panel, replace this line:

```html
              <div class="output-header-btns"><button class="btn btn-icon" id="gen-copy">📋 Copy</button></div>
```

with:

```html
              <div class="output-header-btns"><button class="btn btn-icon" id="gen-copy">📋 Copy</button><button class="btn btn-icon" id="gen-save-project">💾 Save to Project</button></div>
```

In the Recorder panel, add one line directly below `<button class="btn btn-icon" id="rec-copy">📋 Copy</button>`:

```html
                <button class="btn btn-icon" id="rec-save-project">💾 Save to Project</button>
```

In the Orchestrator panel, replace this line:

```html
              <div class="output-header-btns"><button class="btn btn-icon" id="orch-copy">📋 Copy All</button></div>
```

with:

```html
              <div class="output-header-btns"><button class="btn btn-icon" id="orch-copy">📋 Copy All</button><button class="btn btn-icon" id="orch-save-project">💾 Save to Project</button></div>
```

Add the dialog directly above the last line of the file, `<script type="module" src="sidepanel.js"></script>`:

```html
<div id="save-project-overlay" style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.6);align-items:center;justify-content:center;padding:12px">
  <div class="settings-section" role="dialog" aria-modal="true" aria-labelledby="save-project-title" style="width:100%;max-width:360px">
    <h3 id="save-project-title">Save to Project</h3>
    <div class="form-group">
      <label for="save-project-select">Project</label>
      <select id="save-project-select"></select>
    </div>
    <div class="form-group" style="margin-top:8px">
      <label for="save-project-name">Script Name</label>
      <input type="text" id="save-project-name" maxlength="200">
    </div>
    <div class="form-group" style="margin-top:8px">
      <label for="save-project-description">Description (optional)</label>
      <textarea id="save-project-description" maxlength="2000" style="min-height:48px"></textarea>
    </div>
    <div id="save-project-status" role="status" style="font-size:12px;color:var(--text2);padding:6px 0 0;min-height:20px"></div>
    <div class="btn-row" style="margin-top:8px;justify-content:flex-end">
      <button class="btn btn-secondary" id="save-project-cancel">Cancel</button>
      <button class="btn btn-primary" id="save-project-confirm">Save</button>
    </div>
  </div>
</div>
```

- [ ] **Step 7: Wire the buttons and the dialog**

In `PlaywrightExtension/sidepanel.js`, add this import directly below the `PlatformClient` import:

```js
import { extractCode, looksLikeCode, sectionAfter } from './utils/code-extract.js';
```

In `init()`, directly below the existing `setupPlatform();` line, add:

```js
  setupSaveToProject();
```

Add this function directly below the end of `setupPlatform()` and above the `// ---- 11. SETTINGS ----` comment:

```js
// "Save to Project": sends the code shown in a panel to the Playwright Platform as a new script.
// It needs the Settings → Platform sign-in; without one the buttons only say so, and every
// other feature of the extension works as before.
function setupSaveToProject() {
  const overlay = document.getElementById('save-project-overlay');
  const projectSelect = document.getElementById('save-project-select');
  const nameInput = document.getElementById('save-project-name');
  const descriptionInput = document.getElementById('save-project-description');
  const status = document.getElementById('save-project-status');
  const confirmBtn = document.getElementById('save-project-confirm');
  const cancelBtn = document.getElementById('save-project-cancel');
  if (!overlay || !projectSelect || !nameInput || !descriptionInput || !status || !confirmBtn || !cancelBtn) return;

  const LANGUAGES = { typescript: 'TypeScript', javascript: 'JavaScript' };
  const EXPIRED = 'Platform session expired — sign in again under Settings → Platform.';
  let pending = null;      // { content, source, language } while the dialog is open
  let lastProjectId = '';  // offered again for the next save in this session

  // A panel shows a placeholder or a spinner until it has output; neither is code.
  const outputText = (el) => (el && !el.querySelector('.output-placeholder, .loader') ? el.textContent || '' : '');

  const close = () => {
    overlay.style.display = 'none';
    pending = null;
  };

  async function open({ read, emptyMessage, languageSelectId, source, suggestName }) {
    const text = read();
    if (!looksLikeCode(text)) { showToast(emptyMessage); return; }
    const language = LANGUAGES[document.getElementById(languageSelectId)?.value || 'typescript'];
    if (!language) { showToast('Save to Project supports TypeScript and JavaScript only'); return; }

    const platform = await Storage.getPlatform();
    if (!platform.url || !platform.token) { showToast('Sign in under Settings → Platform first.'); return; }

    let projects;
    try {
      projects = await PlatformClient.listProjects();
    } catch (err) {
      showToast(err.status === 401 ? EXPIRED : err.message);
      return;
    }
    if (projects.length === 0) { showToast('No projects yet — create one in the platform first.'); return; }

    // Built with DOM methods: project names come from the server and must never be parsed as HTML.
    projectSelect.replaceChildren(...projects.map((project) => {
      const option = document.createElement('option');
      option.value = String(project.id);
      option.textContent = project.name;
      return option;
    }));
    if (projects.some((project) => String(project.id) === lastProjectId)) projectSelect.value = lastProjectId;

    pending = { content: extractCode(text), source, language };
    nameInput.value = suggestName();
    descriptionInput.value = '';
    status.textContent = '';
    overlay.style.display = 'flex';
    nameInput.focus();
    nameInput.select();
  }

  document.getElementById('gen-save-project')?.addEventListener('click', () => open({
    read: () => outputText(document.getElementById('gen-output')),
    emptyMessage: 'Generate code first',
    languageSelectId: 'gen-language',
    source: 'GENERATED',
    suggestName: () => 'Generated Test',
  }));

  document.getElementById('rec-save-project')?.addEventListener('click', () => open({
    // While the Recorder's editor is open, the code lives in its textarea, not in the output element.
    read: () => document.getElementById('rec-edit-area')?.value ?? outputText(document.getElementById('rec-output')),
    emptyMessage: 'Record some actions first',
    languageSelectId: 'rec-language',
    source: 'RECORDED',
    suggestName: () => document.getElementById('rec-test-name')?.value?.trim() || 'Recorded Test',
  }));

  document.getElementById('orch-save-project')?.addEventListener('click', () => open({
    // The Orchestrator shows the test plan first; only the part after this heading is code.
    read: () => sectionAfter(outputText(document.getElementById('orch-output')), '## GENERATED CODE'),
    emptyMessage: 'Run the pipeline first',
    languageSelectId: 'orch-language',
    source: 'GENERATED',
    suggestName: () => 'Generated Test',
  }));

  confirmBtn.addEventListener('click', async () => {
    if (!pending) return;
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = 'Enter a script name.';
      nameInput.focus();
      return;
    }
    confirmBtn.disabled = true;
    status.textContent = 'Saving…';
    try {
      const script = await PlatformClient.saveScript(Number(projectSelect.value), {
        name,
        description: descriptionInput.value.trim(),
        content: pending.content,
        source: pending.source,
        language: pending.language,
      });
      lastProjectId = projectSelect.value;
      close();
      showToast(`Saved "${script.name}" to the project`);
    } catch (err) {
      // textContent only: the message comes from the server. The dialog stays open so the
      // name can be changed and the save tried again.
      status.textContent = `❌ ${err.status === 401 ? EXPIRED : err.message}`;
    } finally {
      confirmBtn.disabled = false;
    }
  });

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.style.display !== 'none') close();
  });
}
```

- [ ] **Step 8: Check the wiring that tests cannot reach**

Run (from the repo root):

```bash
node --check PlaywrightExtension/sidepanel.js && node --check PlaywrightExtension/utils/code-extract.js && node --check PlaywrightExtension/utils/platform-client.js && echo "syntax ok"
for id in gen-save-project rec-save-project orch-save-project save-project-overlay save-project-select save-project-name save-project-description save-project-status save-project-cancel save-project-confirm; do
  html=$(grep -c "id=\"$id\"" PlaywrightExtension/sidepanel.html); js=$(grep -c "'$id'" PlaywrightExtension/sidepanel.js)
  [ "$html" = "1" ] && [ "$js" = "1" ] || echo "MISMATCH $id (html $html, js $js)"
done; echo "ids checked"
grep -n "innerHTML" PlaywrightExtension/sidepanel.js | grep -i "save-project\|projectSelect\|status\b" ; echo "innerHTML check done"
git status --short PlaywrightExtension PlaywrightBridge PlaywrightOrchestrator
```

Expected: `syntax ok`; `ids checked` with no `MISMATCH` line; no line printed before `innerHTML check done`; and `git status` lists only `PlaywrightExtension/sidepanel.html`, `PlaywrightExtension/sidepanel.js`, `PlaywrightExtension/utils/platform-client.js`, `PlaywrightExtension/utils/code-extract.js`, and the two files under `PlaywrightExtension/tests/` (no agent, provider, recorder, runner, or Bridge file).

Run: `node --test "PlaywrightExtension/tests/*.test.mjs"`
Expected: PASS, 0 failed.

- [ ] **Step 9: Commit**

```bash
git add PlaywrightExtension
git commit -m "feat(extension): save generated and recorded scripts to a platform project"
```

---

### Task 9: Documentation and final verification

**Files:**
- Modify: `PlaywrightPlatform/README.md`, `CLAUDE.md`, `docs/superpowers/specs/2026-10-03-platform-scripts-design.md` (status line only)

**Interfaces:**
- Consumes: everything from Tasks 1–8
- Produces: documentation that matches the shipped behaviour; a verified branch

- [ ] **Step 1: Update the platform README**

In `PlaywrightPlatform/README.md`, replace the three-line introduction below the title with:

```markdown
Backend, database, and web app for Playwright AI Studio: projects, Playwright scripts with
version history, users, roles, and audit logging today; skills, Jenkins execution, reports,
and healing in later releases. The database already contains the tables for all of those.
```

Add two rows at the end of the Roles table:

```markdown
| View, search, and download scripts and their history | yes | yes | yes |
| Create, import, edit, duplicate, restore, and delete scripts | yes | yes | no |
```

Add this section directly below the Roles table:

```markdown
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
```

In the "Connect the extension" section, add this paragraph at its end:

```markdown
Once signed in, the Generator, Recorder, and Orchestrator panels show **💾 Save to Project**
beside Copy: choose a project and a name, and the script appears in that project's Scripts
tab. Only TypeScript and JavaScript output can be saved.
```

Add these rows at the end of the API table:

```markdown
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
```

Add these rows at the end of the Troubleshooting table:

```markdown
| Saving a script says someone else saved a newer version | Two people edited the same version. Choose **Compare with latest**, then **Keep my text** or **Reload latest**. |
| A save answers `PAYLOAD_TOO_LARGE` | The request is over 2 MB. Text with many non-English characters can reach that before 1,000,000 characters. Split the script. |
| A script change answers `PROJECT_NOT_ACTIVE` | The project is archived. Restore it on the Projects page (Status: Archived → Restore). |
| The extension's Save to Project says to sign in first | Open the side panel's Settings → Platform, enter the platform URL and your credentials, and choose **Sign in**. |
```

- [ ] **Step 2: Update the repository guide and the spec status**

In `CLAUDE.md`, in the "### Extension (PlaywrightExtension)" list, add this bullet after the `utils/bridge-client.js` bullet:

```markdown
- **Platform link** (`utils/platform-client.js`, `utils/code-extract.js`): optional sign-in to the Playwright Platform (Settings → Platform, `setupPlatform()` in `sidepanel.js`) and the "💾 Save to Project" buttons in the Generator, Recorder, and Orchestrator panels (`setupSaveToProject()`). Both modules are free of DOM and `chrome.*` calls and are tested with `node --test "PlaywrightExtension/tests/*.test.mjs"`. Text that came from the server is always written with `textContent`. The extension works unchanged when not signed in.
```

In `docs/superpowers/specs/2026-10-03-platform-scripts-design.md`, change the line `Status: awaiting review` to `Status: approved`.

- [ ] **Step 3: Run every automated check**

Run (from `PlaywrightPlatform/`, one after another; the two database-backed suites must never overlap):

```bash
npm test
npm run test:e2e
npm run typecheck
npm run build
```

Expected: the server suite passes with 0 failed (the 92 foundation tests plus the four new files); the browser suite passes 24 tests with 0 failed; the typecheck prints nothing; the build finishes without errors.

Run (from the repo root):

```bash
node --test "PlaywrightExtension/tests/*.test.mjs"
grep -rn "repositories\|from 'knex'" PlaywrightPlatform/server/src/routes && echo "FAIL: routes reach the database layer" || echo "routes clean"
grep -rn "FastifyRequest\|FastifyReply" PlaywrightPlatform/server/src/services && echo "FAIL: services know HTTP" || echo "services clean"
grep -rn "fetch(" PlaywrightPlatform/web/src --include=*.ts --include=*.tsx | grep -v "src/api/" && echo "FAIL: fetch outside api/" || echo "web clean"
grep -rln "codemirror" PlaywrightPlatform/web/src | grep -v "components/CodeEditor.tsx\|components/CodeDiff.tsx" && echo "FAIL: CodeMirror used outside its wrappers" || echo "codemirror contained"
git diff --stat feat/platform-foundation...HEAD -- PlaywrightBridge PlaywrightOrchestrator PlaywrightPlatform/server/src/migrations
git ls-files | grep -E "(^|/)\.env$" && echo "FAIL: .env is tracked" || echo "no .env tracked"
```

Expected: the extension tests pass with 0 failed; the four greps print `routes clean`, `services clean`, `web clean`, `codemirror contained`; the `git diff --stat` prints nothing (this branch changed no Bridge file, no Orchestrator file, and no migration); and `no .env tracked`.

- [ ] **Step 4: Commit**

```bash
git add PlaywrightPlatform/README.md CLAUDE.md docs/superpowers/specs/2026-10-03-platform-scripts-design.md
git commit -m "docs: document scripts, versions, and Save to Project"
```

- [ ] **Step 5: Hand over the manual checks**

These need a person and a real Chrome; an automated session cannot drive the side panel. Report them as not yet verified until someone has done them.

Setup: `docker compose up -d postgres`, `npm run db:migrate`, `npm run db:seed`, `npm run dev:server`, `npm run dev:web` (from `PlaywrightPlatform/`); then reload the unpacked extension at `chrome://extensions` and open its side panel.

1. **Not signed in.** In the Generator, generate a test with the Mock provider, then press **💾 Save to Project**: a toast says "Sign in under Settings → Platform first." Copy, Run on Page, and Download still work.
2. **Sign in** under Settings → Platform (this also covers the foundation's unverified block): the status line shows the signed-in email and role; Sign out returns it to "Not signed in"; sign in again.
3. **Nothing to save.** With an empty Generator output, the button shows "Generate code first"; an empty Recorder shows "Record some actions first"; an Orchestrator that has not run shows "Run the pipeline first".
4. **Generator → project.** Generate, press Save to Project, pick a project, keep the suggested name, Save: a toast confirms, and the script appears in that project's Scripts tab in the web app with `v1`; its Version History shows source `GENERATED`.
5. **Recorder → project.** Record two actions on any page, stop, press Save to Project: the name field holds the Recorder's Test Name; after saving, the web app shows source `RECORDED` and the same code the panel showed.
6. **Recorder while editing.** Press ✏️ Edit, change a line, and without pressing ✔ Save press Save to Project: the saved script contains the edited text.
7. **Unsupported language.** Set the Recorder language to Python and press Save to Project: a toast says only TypeScript and JavaScript are supported, and no dialog opens.
8. **Orchestrator → project.** Run the pipeline, press Save to Project, save: the stored script contains the generated code and not the "## TEST PLAN" section.
9. **Taken name.** Save twice with the same name into the same project: the second attempt shows the server's "already exists" message inside the dialog, which stays open; changing the name and pressing Save succeeds.
10. **Closing the dialog.** Cancel, the Escape key, and a click on the dark background each close it without saving.
11. **Nothing else changed.** Planner, Generator (Run on Page, Run via Playwright), Healer, and Recorder behave as they did before this branch.
