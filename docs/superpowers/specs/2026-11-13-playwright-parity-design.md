# Playwright parity: codegen assertions, debugger, UI mode

Date: 2026-11-13

## Intent

Operate the extension the way Playwright's own tools are operated:

| Playwright | Extension equivalent |
|---|---|
| `npx playwright codegen <url>` with assert tools | Recorder toolbar: Pick locator, Assert visibility / text / value |
| `npx playwright test x.spec.js --debug` + Pick Locator | Debug run: pause, step over, breakpoints, retry step, pick locator while paused |
| `npx playwright test --ui` | Test Explorer panel: saved tests, run one / all / failed, per-step timeline |

Each also has a Bridge button that launches the real Playwright tool.

## Decisions

- Two engines stay. **Live** (content script on the active tab) gets the new features natively.
  **Bridge** launches the real `--ui`, `--debug` and `codegen`.
- Locators are structured data (`chain` of segments), produced by `content.js`, rendered to
  JS/TS or Python by `utils/playwright-codegen.js`, parsed back from code by `utils/test-runner.js`.
  The same resolver is used for generation and replay, so a generated locator is verified unique.
- Live engine follows Playwright semantics: auto-wait (5s), strict mode (a locator matching more
  than one element fails), `toHaveText` exact vs `toContainText` substring.
- Recording survives full page navigation: the service worker keeps recording state in
  `chrome.storage.session`; the content script asks on load and resumes.
- The side panel is the source of truth for recorded actions.
- Saved tests live in `chrome.storage.local` under `pas_tests`.

## Non-goals

- Time-travel DOM snapshots / trace viewer in the Live engine (use Bridge UI mode).
- iframes and shadow-DOM piercing in the Live engine.
- Watch mode.

## Bridge protocol additions

`uiMode {tests:[{name,code}]}`, `debug {code}`, `codegen {url}` (returns recorded code in `done`).
The server now rejects WebSocket connections whose `Origin` is a web page.
