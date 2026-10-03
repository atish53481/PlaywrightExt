# Platform Scripts — Design

Date: 2026-10-03
Status: approved
Sub-project: 2 of 5 (see `2026-10-03-platform-foundation-design.md`, section 1)
Source requirements: `../Req.md` sections 6, 7, 14–17, 31, 33, 34, 58 (one level above this repo)
Branch: `feat/platform-scripts`, cut from `feat/platform-foundation`

## 1. Context

The foundation sub-project delivered the backend, the full database schema, sign-in,
roles, audit logging, projects, and a web app. The tables `test_scripts`,
`test_script_versions`, `tags`, and `script_tags` already exist and are empty; nothing
reads or writes them.

This sub-project makes the database the home of Playwright scripts: a project member
can create, import, edit, version, compare, restore, tag, search, duplicate, download,
and delete scripts in the web app, and can save a script produced by the extension's
Generator, Recorder, or Orchestrator into a project.

## 2. Decisions already made

- **Versioning:** every change to script content creates a new version. Changes to
  name, description, test scenario, or tags do not. History is never rewritten:
  restoring an old version creates a new version with that content.
- **Roles:** ADMIN and USER may create, edit, duplicate, restore, and delete scripts.
  VIEWER may read and download.
- **Delete:** soft. The row stays with status `DELETED`, `deleted_at`, and
  `deleted_by`; the name becomes reusable. There is no restore-from-deleted screen in
  this sub-project.
- **Agents stay in the extension.** The web app does not plan, generate, or record. Its
  Record and Generate buttons explain how to do that in the extension and save the
  result to the project.
- **Editor:** CodeMirror 6, chosen over Monaco because it is much smaller and needs no
  web workers, which keeps the existing content security policy unchanged.

## 3. Goal and success criteria

After this sub-project:

- A USER can create a script in a project by typing or pasting it, or by importing a
  file, and sees it in the project's Scripts tab with version `v1`.
- Editing the content and saving produces `v2`; the version history lists both; any two
  versions can be compared side by side; restoring `v1` produces `v3` whose content
  equals `v1`.
- Scripts can be found by name, description, test scenario, or tag, and filtered by tag.
- A script can be duplicated, downloaded as a `.spec.ts` or `.spec.js` file, and deleted
  after confirmation.
- In the extension, a signed-in user can press "Save to Project" in the Generator,
  Recorder, or Orchestrator panel, choose a project and a name, and then find the
  complete script in the web app.
- A VIEWER can open and download scripts and sees no control that changes anything; the
  API refuses the same actions.
- Every change writes an audit row in the same transaction as the change.
- The project overview counters show real script totals.
- The extension's existing behaviour is unchanged when the user is not signed in to the
  platform.

## 4. Out of scope

- Running a script (sub-project 4) and healing one (sub-project 5). Their buttons are
  shown disabled with a "coming soon" hint.
- Recording which Skill versions produced a script (`script_skills`, sub-project 3).
- The lifecycle states after `SAVED` (`VALIDATED`, `READY`, `RUNNING`, `PASSED`,
  `FAILED`, `HEALING`); later sub-projects set them.
- Saving from the extension as a new version of an existing script. A name that is
  already taken is reported and the user chooses another name.
- An archive state for scripts, restoring deleted scripts, and bulk actions.
- No database migration is expected. If one proves necessary it is a new migration file,
  never an edit to a shipped one.

## 5. Data rules

No new tables. The existing columns are used as follows.

| Field | Rule |
|---|---|
| `name` | Trimmed, 1–200 characters, unique within a project among non-deleted scripts, compared case-insensitively |
| `description` | Trimmed, up to 2,000 characters, default empty |
| `test_scenario` | Trimmed, up to 5,000 characters, default empty |
| `script_content` | 1 to 1,000,000 characters; always equal to the content of the latest version |
| `language` | `TypeScript` or `JavaScript`, default `TypeScript` |
| `framework` | Always `Playwright` |
| `script_type` | `E2E`, `API`, or `COMPONENT`, default `E2E` |
| `version` | Number of the latest version, starting at 1 |
| `status` | `ACTIVE` or `DELETED` (`ARCHIVED` is unused in this sub-project) |
| `lifecycle_state` | Set to `SAVED` on create and whenever a new version is written |

Text fields reject the NUL character, as in the foundation.

**Versions.** `test_script_versions` rows are inserted and never updated or deleted.
`source` records where the content came from:

| Source | When |
|---|---|
| `MANUAL` | Typed or pasted in the web app; also the first version of a duplicate |
| `GENERATED` | Saved from the extension's Generator or Orchestrator |
| `RECORDED` | Saved from the extension's Recorder |
| `IMPORTED` | Imported from a file in the web app |
| `RESTORED` | Created by restoring an earlier version |

`change_summary` is optional text up to 500 characters. Restores and duplicates write
their own summary ("Restored from v1", "Duplicated from Login Test v3").

**Tags.** A script has at most 20 tags. A tag is trimmed, 1–40 characters, and may
contain letters, digits, spaces, and `- _ . @`. Tags are unique case-insensitively across
the whole installation; the first spelling saved is kept. Tag rows are created on demand
and never deleted.

## 6. API

All routes are under `/api` and follow the foundation's conventions: Zod validation of
input (`parse`) and output (`shape`), the standard error shape, CSRF for cookie sessions,
and audit rows.

A new guard `writers` admits ADMIN and USER. `signedIn` admits any role.

| Method | Path | Guard | Behaviour |
|---|---|---|---|
| GET | `/projects/:projectId/scripts` | signedIn | List. Query: `search`, `tag`, `status` (`ACTIVE` default; `DELETED` for ADMIN only), `page`, `pageSize` (1–100, default 25). Newest update first |
| POST | `/projects/:projectId/scripts` | writers | Create the script and version 1 |
| GET | `/scripts/:id` | signedIn | One script with its latest content and tags |
| PUT | `/scripts/:id` | writers | Change metadata and/or content |
| DELETE | `/scripts/:id` | writers | Soft delete |
| POST | `/scripts/:id/duplicate` | writers | New script in the same project with its own history |
| GET | `/scripts/:id/versions` | signedIn | Version list without content |
| GET | `/scripts/:id/versions/:version` | signedIn | One version with content |
| POST | `/scripts/:id/versions/:version/restore` | writers | Create a new version from an old one |
| GET | `/scripts/:id/download` | signedIn | File download; optional `version` query |
| GET | `/tags` | signedIn | Tag names matching optional `search`, at most 50, for autocomplete |

### 6.1 Bodies and responses

**Create** — `{ name, description?, testScenario?, content, language?, scriptType?,
tags?, source?, changeSummary? }`. `source` may be `MANUAL`, `GENERATED`, `RECORDED`, or
`IMPORTED` (default `MANUAL`). Returns 201 with the script.

**Update** — `{ name?, description?, testScenario?, tags?, content?, changeSummary?,
baseVersion? }` with at least one field. `baseVersion` is required when `content` is
present. If `content` equals the current content, no version is created. Returns the
script.

**Duplicate** — `{ name? }`. The default name is the original name followed by
` (copy)`. The copy takes the latest content, description, test scenario, language,
type, and tags, and starts at version 1.

**Script** (all single-script responses) — `{ id, projectId, name, description,
testScenario, content, language, framework, scriptType, version, status,
lifecycleState, tags: string[], createdAt, updatedAt, updatedBy: string | null }` where
`updatedBy` is the display name of the last editor.

**List item** — the same without `content` and `testScenario`. The list response is
`{ items, total, page, pageSize }`.

**Version list item** — `{ version, source, changeSummary, createdBy: string | null,
createdAt, size }` where `size` is the content length in characters. One version adds
`content`.

**Download** — `Content-Type: text/plain; charset=utf-8` and
`Content-Disposition: attachment` with a file name built from the script name reduced to
letters, digits, and hyphens, plus `.spec.ts` or `.spec.js`. The body is the content,
unmodified.

### 6.2 Errors

| Status | Code | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Any rule in section 5 is broken; `baseVersion` missing with `content` |
| 403 | `FORBIDDEN` | VIEWER attempts a write; non-ADMIN lists deleted scripts |
| 404 | `NOT_FOUND` | Project, script, or version does not exist or is deleted |
| 409 | `SCRIPT_NAME_TAKEN` | Another live script in the project has that name |
| 409 | `VERSION_CONFLICT` | `baseVersion` is not the current version. `details` carries `{ currentVersion, updatedBy }` |
| 409 | `ALREADY_CURRENT` | Restore names the version that is already the latest |
| 409 | `PROJECT_NOT_ACTIVE` | Any write (create, update, delete, duplicate, restore) in a project that is archived |
| 413 | `PAYLOAD_TOO_LARGE` | The request body exceeds 2 MB |

A deleted project hides its scripts: every script route answers 404.

### 6.3 Consistency

Each write runs in one transaction through the foundation's `Transact`, together with
its audit row. The transaction locks the script row before reading its version, so two
simultaneous saves cannot both produce the same version number: the second sees the
first's result and answers `VERSION_CONFLICT`.

Audit actions: `script.create`, `script.update` (metadata only), `script.version`
(new content), `script.restore`, `script.duplicate`, `script.delete`. Audit details name
the fields changed and the version numbers involved. Script content is never written to
an audit row or a log line.

Script content is stored and returned as text. The server never executes, imports, or
evaluates it in this sub-project.

## 7. Server structure

New files, following the foundation's layering (routes → services → repositories):

| File | Responsibility |
|---|---|
| `repositories/script-repository.ts` | Queries on `test_scripts` and `test_script_versions`, including the row lock and the search |
| `repositories/tag-repository.ts` | Find-or-create tags, set a script's tags, list tags |
| `services/script-service.ts` | Rules: project state, name conflicts, version bump, conflict detection, restore, duplicate, audit |
| `schemas/scripts.ts` | Zod schemas and DTO mapping |
| `routes/scripts.ts` | The eleven routes |

Changes to existing files: `repositories/index.ts` adds the two repositories to `Repos`;
`plugins/auth.ts` exports `writers`; `app.ts` constructs `ScriptService` and registers
the routes; `types.ts` gains the script types.

The body size limit for the create and update routes is raised to 2 MB; all other routes
keep the default.

Search matches `name`, `description`, and `test_scenario` case-insensitively with
wildcards escaped, and also matches any script carrying a tag whose name contains the
search text. The `tag` filter matches one tag name exactly, case-insensitively.

## 8. Web app

**Project dashboard → Scripts tab** (replaces the placeholder):

- Buttons: New Script, Import, Record, Generate. Record and Generate open a short
  explanation: do it in the extension, then press "Save to Project".
- Search box, tag filter, Refresh, and Previous/Next paging with the total count.
- Table: name, version (`v3`), state, tags, last updated, updated by.
- Row actions: View, Edit, Duplicate, Version History, Download, Delete, plus Run and
  Heal shown disabled. Write actions are hidden from a VIEWER.
- Delete asks: "Are you sure? This will remove the script from the project."

**New Script page** — name, description, test scenario, language, type, tags, and the
editor. Import opens the same page with the content, the name (from the file name), and
the source `IMPORTED` filled in. Accepted files: `.ts`, `.js`, `.mjs`, `.cjs` up to
1 MB, read in the browser as UTF-8.

**Script page** — the editor with syntax highlighting, the metadata fields, the tag
editor with autocomplete, and Save with an optional change summary. A VIEWER sees the
same page read-only. Leaving with unsaved changes asks for confirmation. On
`VERSION_CONFLICT` the page says who saved which version, keeps the user's text, and
offers "Reload latest" or "Compare with latest".

**Version history page** — the list of versions (number, source, summary, author, date)
and a side-by-side comparison of any two, defaulting to the latest against the one
before it. Restore asks for confirmation and then shows the new version.

New routes: `/projects/:projectId/scripts/new`, `/scripts/:id`,
`/scripts/:id/versions`. The Scripts tab is addressable as `/projects/:id?tab=scripts`
so the back button returns to it.

New dependencies in `web`: `codemirror`, `@codemirror/lang-javascript`,
`@codemirror/merge`, `@codemirror/theme-one-dark`. The editor and the comparison view
are each wrapped in one React component so pages do not touch CodeMirror directly.

## 9. Extension

- `utils/platform-client.js` gains `saveScript(projectId, { name, description, content,
  source, language })`.
- `utils/code-extract.js` (new) turns panel output into plain code: if the text contains
  fenced code blocks it joins their contents, otherwise it returns the text unchanged.
- `sidepanel.html` gains a "💾 Save to Project" button beside Copy in the Generator,
  Recorder, and Orchestrator panels, and one shared dialog with project, script name,
  and description.
- `sidepanel.js` gains one function that wires the three buttons and the dialog. The
  project list comes from `PlatformClient.listProjects()`. The Recorder's test name
  pre-fills the script name. Source is `RECORDED` from the Recorder and `GENERATED`
  from the other two.

If the user is not signed in, the button shows "Sign in under Settings → Platform
first." If the panel has no code yet, it shows the same message the Copy button shows
today. A taken name shows the server's message and leaves the dialog open. All text
from the server is written with `textContent`.

No agent, provider, recorder, runner, or Bridge code changes.

## 10. Testing

**Server (Vitest, real PostgreSQL):**

- Create: stores script and version 1; duplicate name rejected case-insensitively; name
  reusable after delete; each field limit; unknown project; archived project.
- Update: metadata-only change keeps the version; content change bumps it and records
  the summary; identical content creates nothing; missing or stale `baseVersion`.
- Concurrency: two simultaneous content saves from the same base produce exactly one
  new version and one `VERSION_CONFLICT`.
- Versions: list order and fields; fetch one; unknown version.
- Restore: creates a new version equal to the old content with source `RESTORED`;
  restoring the latest is refused; earlier versions are untouched.
- Duplicate: copies content, metadata, and tags; independent history; name clash.
- Tags: created on demand; case-insensitive reuse; limits; invalid characters.
- Search and filter: each searched field; tag match; literal `%` and `_`; paging bounds.
- Delete: soft; hidden from lists and from fetch; visible to ADMIN with
  `status=DELETED`.
- Download: headers, file name sanitising for a hostile script name, exact body, a
  chosen version.
- Roles: every route against ADMIN, USER, VIEWER, and no session; CSRF on cookie writes.
- Audit: one row per action, written atomically (a failing audit write rolls the change
  back); no script content in any audit row.
- Size: content at the limit accepted, over the limit rejected, body over 2 MB rejected.
- Project overview counters reflect created and deleted scripts.

**Web (Playwright):** create a script; edit it and see `v2`; compare `v1` with `v2`;
restore `v1` and see `v3`; tag it and find it by tag and by search; duplicate; download
and check the file content; delete with confirmation; import a file; a VIEWER sees the
read-only page and no write controls; a conflict from a second browser context shows the
conflict message and keeps the typed text.

**Extension (`node --test`):** `saveScript` request and errors; `extractCode` for fenced,
multi-block, and plain text. The Save to Project dialog is checked by hand in Chrome and
listed in the plan as a checklist.

## 11. Risks

- **The extension UI cannot be driven from an automated session.** The foundation's
  Settings block is still unverified in Chrome, and this sub-project adds more side-panel
  UI. Both need a manual pass before the work is called complete.
- **Editor bundle size.** CodeMirror adds roughly 150–200 KB compressed. It is loaded
  only on the script and version pages.
- **Large scripts in lists.** List queries never select `script_content`.
- **Foundation branch not merged.** This branch builds on `feat/platform-foundation`.
  If that branch changes before it is merged, this one is rebased onto it.
