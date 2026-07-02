# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Playwright Orchestrator (`pworch`) — a multi-agent QA automation CLI. 15 specialized agents (planner, generator, healer, accessibility, security, etc.) are coordinated by a master `OrchestratorAgent`. Per `Requirement.md`, the design goal is that Playwright's planner/generator/healer are *implementations inside this platform*, not hard-coded dependencies, so other frameworks (Selenium, Cypress, Appium) could be swapped in later.

Note: this directory sits inside a larger git repo rooted at `C:\Users\atish\Documents\Playwright`; sibling directories are separate projects.

## Commands

```bash
npm run dev                    # run CLI via ts-node (shows commander help)
npm run build                  # tsc → dist/
npm run status                 # boot all 15 agents, print statuses

# CLI commands (all boot agents, execute one task, teardown, exit):
npx ts-node src/index.ts plan <url> [-n name]
npx ts-node src/index.ts generate <url>
npx ts-node src/index.ts execute [-p path] [--project chromium] [--headed] [-w workers]
npx ts-node src/index.ts heal [--url url] [--apply]        # dry-run unless --apply
npx ts-node src/index.ts scaffold [-d dir] [-n name] [-p Home,Login]
npx ts-node src/index.ts accessibility <url> [--level wcag21aa]
npx ts-node src/index.ts security <url> [--depth basic|deep]
npx ts-node src/index.ts performance <url> [-r runs]
npx ts-node src/index.ts api <url> [--token t]
npx ts-node src/index.ts chat "<message>" [--url url]
npx ts-node src/index.ts orchestrate <workflow> <url>      # full-cycle | quick-check | generate-and-run | audit

# Playwright tests (testDir: ./tests):
npm test                       # all projects (chromium, firefox, webkit, mobile-chrome, mobile-safari)
npx playwright test tests/examples/sample.spec.ts          # single file
npx playwright test --project=chromium                     # single browser
npm run test:ui / test:headed / test:report
```

No lint script configured. Test artifacts go to `reports/` (html, results.json, test-results).

## Architecture

Everything flows through singletons and an event bus; agents never call each other directly.

- **`src/models/AgentTask.ts`** — the universal message format. Every unit of work is an `AgentTask` (`TaskType` enum + untyped `payload`) created via `createTask()`; every agent returns an `AgentResult`. Adding a capability means adding a `TaskType` here first.
- **`src/agents/base/Agent.ts`** — abstract base. Subclasses implement `init()` and `execute(task) → AgentResult`. Base constructor auto-subscribes to `agent:<name>:message` on the event bus. Use `this.createResult(...)` to build results and `this.log` (per-agent winston child logger).
- **`src/agents/base/AgentRegistry.ts`** — singleton (`agentRegistry`) holding all agents. `src/index.ts` `bootstrap()` registers all 15 and calls `initAll()`; every CLI command does bootstrap → one orchestrator task → `destroyAll()`.
- **`src/agents/OrchestratorAgent.ts`** — the router. `AGENT_ROUTE` maps each `TaskType` to its handling agent (a new agent must be added there, in `bootstrap()`, and usually as a CLI command in `src/index.ts`). Also owns the named workflows (`full-cycle`, `quick-check`, `generate-and-run`, `audit`) — sequential step lists where each step's result data is merged into the next step's payload, stopping on first `FAILURE`. Has a priority `TaskQueue` for evented dispatch (`orchestrator:task`), while CLI calls go directly through `execute()`.
- **`src/core/EventBus.ts`** — singleton pub/sub (`eventBus`) used for agent messaging and result broadcast (`agent:result:<taskId>`, `orchestrator:result:<taskId>`).
- **`src/playwright/PlaywrightContext.ts`** — shared browser lifecycle for agents that drive a real browser (inspector, accessibility, performance, security). Honors `DEFAULT_BROWSER`, `HEADLESS`, `SLOW_MO`, `BASE_URL`.

Env vars (loaded via dotenv in both `src/index.ts` and `playwright.config.ts`): `BASE_URL` (default `http://localhost:3000`), `LOG_LEVEL`, `HEADLESS`, `DEFAULT_BROWSER`, `SLOW_MO`, `PERF_FCP_THRESHOLD`, `CI` (affects retries/workers/forbidOnly).
