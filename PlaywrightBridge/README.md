# Playwright Bridge

Local companion for the **Playwright AI Studio** Chrome extension. Gives the extension two superpowers a browser extension cannot have on its own:

1. **Real Playwright runs** — generated tests execute with the actual Playwright runner in a headed Chromium window you can watch.
2. **Local LLM via Claude Code** — the extension can use your locally installed Claude Code CLI as its AI provider. No API key pasted into the extension.

## Setup (once)

```bash
cd PlaywrightExt/PlaywrightBridge
npm run setup        # installs deps + Chromium
```

## Run

```bash
npm start            # starts ws://127.0.0.1:8787
```

Keep this terminal open while using the extension.

## Use from the extension

- **Run tests:** Generator or Recorder panel → **🚀 Run via Playwright** — code is written to `tests/bridge.spec.ts` and executed headed; output streams back into the side panel.
- **LLM:** Settings → select **Bridge (Claude Code)** provider → Save. All agents (planner/generator/healer/chat) now use your local Claude Code CLI.

- **Self-healing runs:** a run that fails is fixed and run again, twice at most. The first fix is made by the AI provider chosen in Settings, from the runner's output and the page snapshot Playwright writes for a failed test (`test-results/**/error-context.md`). The second, or the only one when the Mock provider is chosen, is made by the Playwright healer agent (below).

## Playwright agents and Playwright MCP

This folder holds Playwright's own test agents for Claude Code and the MCP server they work through:

| File | What it is |
|---|---|
| `.claude/agents/playwright-test-{planner,generator,healer}.md` | The three agent definitions |
| `.mcp.json` | The `playwright-test` MCP server (`npx playwright run-test-mcp-server`) |
| `tests/seed.spec.ts`, `specs/` | The seed test and the folder for test plans the agents expect |

They were made by `npx playwright init-agents --loop=claude`; run that again after upgrading `@playwright/test`.

The extension uses the **healer** agent: the Bridge starts `claude -p --agent playwright-test-healer` in this folder, the agent runs `tests/bridge.spec.ts` in a real browser through MCP, looks at the page where it fails, and edits the test until it passes. A fix takes a minute or two. The agent may read this folder, edit files under `tests/`, and use the Playwright MCP tools; it is given no shell. The planner and generator agents are installed and can be used from Claude Code in this folder, but no button of the extension starts them.

## Protocol

WebSocket JSON messages on `127.0.0.1:8787`:

| cmd | payload | responses |
|---|---|---|
| `ping` | — | `pong {version, agents}` |
| `runCode` | `{ code }` | `status`, `output`*, `done {exitCode, passed, errorContext}` |
| `agentHeal` | `{ code }` | `status`*, `agentHealResult {code, summary}` or `error` |
| `complete` | `{ system, prompt, attachments }` | `completeResult {text}` or `error` |
| `stop` | — | `status` |

## Security

Binds `127.0.0.1` only, and takes a connection from the extension or from a program on this machine, never from a web page (a connection with a website's `Origin` is refused). It executes Playwright code, shells out to `claude`, and starts an agent that edits the tests in this folder — never expose the port beyond localhost.
