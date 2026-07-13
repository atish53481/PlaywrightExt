# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository Layout

Three sibling projects forming one AI-powered Playwright testing suite. They share no code — the Extension talks to the Bridge over WebSocket; the Orchestrator is fully standalone.

| Project | What it is | Runtime |
|---|---|---|
| `PlaywrightExtension/` | "Playwright AI Studio" Chrome MV3 extension (side panel UI, AI agents) | Browser, no build step |
| `PlaywrightBridge/` | Local WebSocket server the extension uses for real Playwright runs + Claude Code CLI as LLM | Node (ESM) |
| `PlaywrightOrchestrator/` | Standalone multi-agent QA CLI (`pworch`), 15 TypeScript agents | Node + ts-node |

`PlaywrightOrchestrator/CLAUDE.md` has full detail for that project — read it before working there.

Feature design docs live in `docs/superpowers/specs/` (one dated markdown file per feature) — check for an existing spec before designing changes to the Extension panels.

## Commands

### PlaywrightBridge
```bash
cd PlaywrightBridge
npm run setup        # npm install + npx playwright install chromium (once)
npm start            # WebSocket server on ws://127.0.0.1:8787
```
No tests/lint of its own — `tests/bridge.spec.ts` is a scratch file overwritten on every `runCode` request from the extension.

### PlaywrightExtension
No build, no package.json — plain ES modules loaded by Chrome. Load via `chrome://extensions` → Developer mode → "Load unpacked" → select `PlaywrightExtension/`. After editing, click the reload icon on the extension card (service-worker + side panel changes need it).

### PlaywrightOrchestrator
```bash
cd PlaywrightOrchestrator
npm run dev                  # CLI help via ts-node
npm run build                # tsc → dist/
npx tsc --noEmit             # typecheck
npm test                     # playwright test (all 5 browser projects)
npx playwright test tests/examples/sample.spec.ts --project=chromium   # single test
```
See `PlaywrightOrchestrator/CLAUDE.md` for the full CLI command list (plan/generate/execute/heal/orchestrate/...) and architecture.

## Architecture

### Extension (PlaywrightExtension)
- **`sidepanel.js`** is the hub: instantiates the `Orchestrator` (agents/orchestrator.js) with the selected AI provider and wires all panel UI. `sidepanel.html`/`sidepanel.css` hold the entire UI.
- **Agents** (`agents/`): planner, generator, healer, recorder, inspector, chat, framework, export, session — all extend `BaseAgent` (`agents/base-agent.js`) and receive an `AIProvider`. Official Playwright test-agents flow: planner → generator → healer (`Orchestrator.runFullPipeline`).
- **Templates** (`templates/`): `test_plan_template.md` and `test_case_template.md` are the source of truth for test-plan output structure — the planner agent fetches them at runtime and embeds them in its system prompt. Change the plan format by editing the templates, not the agent prompt.
- **Providers** (`providers/`): implement `AIProvider.complete({system, prompt})` (`base-provider.js`). `mock` is default (no key, canned output, 15KB of realistic samples), `claude`/`openai`/`gemini` call public APIs with a user-supplied key, `bridge` proxies to the local Claude Code CLI via the Bridge. Provider switching lives in `sidepanel.js` `updateProvider()`; settings persist through `utils/storage.js` (chrome.storage).
- **`background.js`** (MV3 service worker): message relay only — injects/reaches `content.js` in the active tab (`RELAY_TO_CONTENT`), exposes tab info and debugger-based network capture. `content.js` does in-page work: recorder event capture and element inspection.
- **Recorder pipeline**: `content.js` captures DOM events (a `navigate` action with the current URL is recorded on start, so generated tests begin with `page.goto`) → streams `RECORDING_ACTION` messages to the side panel → `utils/playwright-codegen.js` `actionsToTest()` renders code (`normalizeActions()` collapses per-keystroke `fill` events to the final value). `getBestLocatorText()` in `content.js` must emit valid Playwright selector-engine syntax (`text="..."`, CSS attribute selectors) — its output lands verbatim inside `page.locator('...')`.
- **Two run paths**, shared by the Generator and Recorder panels via helpers in `sidepanel.js` (`runCodeViaBridge`, `runCodeLive`): Bridge = real `npx playwright test` (headed) with streamed output; Live = `utils/test-runner.js` parses the generated code line-by-line and replays steps on the active tab, with failed steps routable to the Healer panel.
- **`utils/bridge-client.js`**: WebSocket client for the Bridge (`ws://127.0.0.1:8787`), used for `runCode` (real test runs, streamed output) and `complete` (LLM via Claude Code CLI).

### Bridge (PlaywrightBridge)
Single file, `server.js`. Protocol: JSON `{id, cmd, payload}` messages — `ping`, `runCode` (writes `tests/bridge.spec.ts`, spawns `npx playwright test` headed, streams stdout), `complete` (pipes prompt to `claude -p`), `stop`. Binds 127.0.0.1 only — it executes arbitrary Playwright code and shells out to `claude`, so never expose the port.

### Orchestrator (PlaywrightOrchestrator)
Separate multi-agent framework — event bus + singleton registry + `OrchestratorAgent` routing `TaskType` → agent. Full architecture documented in its own CLAUDE.md.

## Cross-project Conventions

- The Extension's agent/provider names (planner, generator, healer...) mirror the Orchestrator's agents but the implementations are independent — a change in one does not affect the other.
- Bridge protocol changes must be kept in sync on both sides: `PlaywrightBridge/server.js` and `PlaywrightExtension/utils/bridge-client.js`.
