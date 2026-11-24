# Playwright AI Studio — Workflow Guide (v1.1.0)

How to operate the extension the way you operate Playwright's own tools.

| Playwright command | In the extension |
|---|---|
| `npx playwright codegen <url>` | 🎬 Recorder panel → ⏺ Start, with Pick / Assert tools |
| `npx playwright test x.spec.js --debug` | 🐞 Debug button (Recorder, Generator, Test Explorer) |
| `npx playwright test --ui` | 🧪 Test Explorer panel |

Two engines run tests:

- **Live (on page)** — replays the test on the tab you are looking at. No setup. Supports the
  debugger and Pick locator.
- **Real Playwright (Bridge)** — runs `@playwright/test` headed on your machine. Needs the Bridge.

## 0. Setup

1. `chrome://extensions` → Developer mode → **Load unpacked** → `PlaywrightExtension/`.
   After any update, click the reload icon on the extension card and refresh open site tabs.
2. Optional, for real Playwright runs and tools:
   ```bash
   cd PlaywrightBridge
   npm run setup   # once
   npm start       # keep running — ws://127.0.0.1:8787
   ```

## 1. Record a test with assertions (codegen)

1. Open the site in a tab, open the side panel, go to 🎬 **Recorder**.
2. Set a test name and language, click **⏺ Start**. A floating toolbar appears on the page
   (drag it by its header if it covers something).
3. Use the site normally. Clicks, typing, checkboxes, dropdowns and Enter/Tab/Escape are
   recorded. Recording continues across page navigations.
4. To add an assertion, click a tool (on the page toolbar or in the side panel), then click
   the element. The click is not sent to the page.

   | Tool | Generates |
   |---|---|
   | 🎯 Pick locator | shows the best locator, with Copy (records nothing) |
   | 👁 Assert visibility | `await expect(locator).toBeVisible();` |
   | 🔤 Assert text | `await expect(locator).toContainText('...');` — edit the text, Enter to accept |
   | ✏ Assert value | `toHaveValue('...')` for inputs, `toBeChecked()` for checkboxes |

   `Esc` cancels a tool.
5. Click **⏹ Stop**. The code is in *Generated Code*. **✏️ Edit** to change it by hand,
   **💾 Save** to send it to the Test Explorer, **⬇ Download** for a spec file.

Locator priority: `data-testid` → `data-test`/`data-qa`/`data-cy` → role + name → label →
placeholder → alt → text → title → id → name → CSS path. Every locator is checked to match
exactly one element; if not, `exact: true` or `.nth(n)` is added.

## 2. Run

- **▶ Run on Page** — Live engine. Each step shows ✅ / ❌ / ⏭️ and its time.
- **🚀 Run via Playwright** — real runner through the Bridge, output streamed into the panel.
- **🩹 Heal Failures** appears after a failed Live run and sends code + errors to the Healer.

Live engine rules match Playwright: actions wait up to 5s for the element to be visible and
enabled; a locator matching several elements fails with a strict mode violation;
`toHaveText` is an exact match, `toContainText` a substring.

Lines the Live engine cannot run (page-object calls, runtime-computed values, unsupported
APIs) are marked ⏭️ skipped with the reason. Use **Run via Playwright** for those tests.

## 3. Debug (`--debug`) and Pick Locator at runtime

Click **🐞 Debug**. The run starts paused before step 1.

| Control | What it does |
|---|---|
| ⏭ Step over | run one step, pause again |
| ▶ Resume | run to the next breakpoint or failure |
| ⏸ Pause | pause before the next step |
| ● (left of a step) | toggle a breakpoint — the run pauses before that step |
| click a step | highlight its element on the page |
| ⏹ Stop | end the run |

When a step fails the run pauses on it instead of ending:

1. Click **🎯 Pick locator**, then click the correct element on the page.
2. Click **↪ Use for paused step** — the locator is replaced in the run and in the code.
3. Click **↻ Retry step**, then **▶ Resume**.

For the real Playwright Inspector use Test Explorer → **🐞 Playwright Inspector**.

## 4. Test Explorer (`--ui`)

🧪 **Test Explorer** keeps your saved tests and their last result.

- Add tests: **💾 Save** in Recorder / Generator, **＋ New**, or **⬆ Import** spec files.
- **▶ Run all** / **↻ Run failed**, with the engine chosen in the dropdown (On page or
  Real Playwright). Click the button again to stop after the current test.
- Click a test to edit its name and code, see the step timeline of the last run, and
  Run / Debug / Download / Delete it.
- Tests and results are stored in the browser and survive restarts.

Real Playwright tools (Bridge must be running):

- **🖥 Playwright UI Mode** — writes the saved tests to `PlaywrightBridge/tests/explorer/`
  and opens `npx playwright test --ui` (watch mode, time-travel trace, DOM snapshots).
- **🎬 Playwright Codegen** — opens `npx playwright codegen <url>` (blank URL = current tab).
  Close the Codegen window and the recording is imported into the Explorer.

## 5. AI agents with the same flow

Planner → Generator → (Run / Debug) → Healer, as before. Generated code now has the same
**▶ Run on Page**, **🐞 Debug**, **🚀 Run via Playwright** and **💾 Save** buttons.

## Limits

- Live engine does not reach inside iframes or shadow DOM, and has no time-travel
  snapshots — use Playwright UI Mode for those.
- Live engine cannot run on `chrome://` pages or the Chrome Web Store.
- Python output is for export only; it cannot be run from the extension.
- The Bridge only accepts connections from browser extensions, not from web pages.

## Troubleshooting

| Symptom | Fix |
|---|---|
| "Page did not respond" | Refresh the site tab (it was open before the extension loaded) |
| "Bridge not running" | `cd PlaywrightBridge && npm start` |
| strict mode violation | Locator matches several elements — Pick a new one or add `.first()` |
| Step ⏭️ skipped | Not supported by the Live engine — run it via Playwright |
