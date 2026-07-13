# Recorder Panel: Run Recorded Script — Design

**Date:** 2026-07-09
**Scope:** `PlaywrightExtension/sidepanel.html`, `PlaywrightExtension/sidepanel.js`

## Goal

After recording, the user can execute the generated Playwright script directly from the Recorder panel — the same two ways the Generator panel already offers:

1. **▶ Run on Page** — in-page replay via `TestRunner` (parse steps, per-step ✅/❌, failed steps routable to the Healer panel).
2. **🚀 Run via Playwright** — real `npx playwright test` (headed) through the local Bridge via `BridgeClient.runCode`, with streamed output.

## Approach

Extract the two existing Generator click-handler bodies into shared helpers so Recorder and Generator share one implementation (no ~100-line duplication):

- `runCodeViaBridge(code, els)` — `els = { section, results, summary, btn }`. Streams status/output lines; on error shows the Bridge setup instructions.
- `runCodeLive(code, els)` — `els = { section, results, summary, btn, healBtn }`. Renders step rows, runs `TestRunner.run`, shows summary, and on failure reveals the heal button which copies code + errors into the Healer panel and switches to it.

Generator handlers become thin wrappers passing `gen-*` elements. Recorder handlers pass `rec-*` elements.

## UI changes (sidepanel.html, Recorder panel)

- Add `▶ Run on Page` (`rec-run-live`) and `🚀 Run via Playwright` (`rec-run-bridge`) buttons to the existing Recorder `btn-row` next to AI Enhance / Download.
- Add a hidden run-results section mirroring the Generator's: `rec-run-section`, `rec-run-summary`, `rec-heal` (hidden heal button), `rec-run-results`.

## Guards

- No recorded code yet (placeholder text present) → toast "Record some actions first".
- Language is Python → toast "Run supports TypeScript/JavaScript only" (TestRunner parses JS/TS; the Bridge writes a `.spec.ts` file).

## Error handling

Unchanged from the Generator paths: Bridge unavailable → setup instructions in the log; live run with zero parseable steps → toast.

## Testing

Manual: reload unpacked extension → record actions → Stop → click both run buttons. Verify streamed Bridge output and pass/fail summary; verify live per-step icons and that the heal button appears on failure and populates the Healer panel. Regression: Generator panel's two run buttons still work (they now call the shared helpers).
