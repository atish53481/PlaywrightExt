# Playwright Bridge

Local companion for the **Playwright AI Studio** Chrome extension. Gives the extension two superpowers a browser extension cannot have on its own:

1. **Real Playwright runs** — generated tests execute with the actual Playwright runner in a headed Chromium window you can watch.
2. **Local LLM via Claude Code** — the extension can use your locally installed Claude Code CLI as its AI provider. No API key pasted into the extension.

## Setup (once)

```bash
cd Atish/PlaywrightBridge
npm run setup        # installs deps + Chromium
```

## Run

```bash
npm start            # starts ws://127.0.0.1:8787
```

Keep this terminal open while using the extension.

## Use from the extension

- **Run tests:** Generator panel → **🚀 Run via Playwright** — code is written to `tests/bridge.spec.ts` and executed headed; output streams back into the side panel.
- **LLM:** Settings → select **Bridge (Claude Code)** provider → Save. All agents (planner/generator/healer/chat) now use your local Claude Code CLI.

## Protocol

WebSocket JSON messages on `127.0.0.1:8787`:

| cmd | payload | responses |
|---|---|---|
| `ping` | — | `pong` |
| `runCode` | `{ code }` | `status`, `output`*, `done {exitCode, passed}` |
| `complete` | `{ system, prompt }` | `completeResult {text}` or `error` |
| `stop` | — | `status` |

## Security

Binds `127.0.0.1` only. It executes Playwright code and shells out to `claude` for local clients — never expose the port beyond localhost.
