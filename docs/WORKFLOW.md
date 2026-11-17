# Playwright AI Studio — working the way you work with Playwright (v1.1.0)

| Playwright command | In the extension |
|---|---|
| `npx playwright codegen <url>` | 🎬 **Recorder** → ⏺ Start, with the Pick and Assert tools |
| `npx playwright test x.spec.js --debug` | 🐞 **Debug** (Recorder, Generator, Test Explorer) |
| `npx playwright test --ui` | 🧪 **Test Explorer** |

A test runs in one of two ways:

- **On page** (▶ Run on Page, 🐞 Debug): the steps are replayed on the tab you are looking at.
  Nothing to install. This is where the debugger and Pick locator work.
- **Real Playwright** (🚀 Run via Playwright): `@playwright/test` runs the file, headed, on your
  machine. Needs the Bridge.

## 0. Before you start

1. `chrome://extensions` → Developer mode → **Load unpacked** → `PlaywrightExtension/`.
   After an update, press the reload icon on the extension's card **and refresh the tabs of
   the site you test** (a tab keeps the script it was given before the reload).
2. For real Playwright runs and tools:
   ```bash
   cd PlaywrightBridge
   npm run setup   # once
   npm start       # keep it running — ws://127.0.0.1:8787
   ```
   Restart it after an update of the Bridge.

## 1. Record a test, with checks (codegen)

1. Open the site in a tab. Open the side panel → 🎬 **Recorder**.
2. Give the test a name, press **⏺ Start**. A small monitor appears on the page (drag it by
   its green bar if it is in the way).
3. Use the site. Clicks, typing, checkboxes, lists, hovers that open something, keys such as
   Enter, dialogs, new tabs, and steps inside frames are recorded. The recording goes on when
   the tab loads another page.
4. To add a check, choose a tool — in the monitor on the page or in the side panel — and then
   click the element. That click is not given to the page.

   | Tool | What it writes |
   |---|---|
   | 🎯 Pick locator | Nothing. Shows the element's locator, with a Copy button |
   | 👁 Assert visibility | `await expect(locator).toBeVisible();` |
   | 🔤 Assert text | `await expect(locator).toContainText('...');` — shorten or correct the text, Enter accepts |
   | ✏ Assert value | `toHaveValue('...')` for a field, `toBeChecked()` / `not.toBeChecked()` for a checkbox |

   `Esc` cancels a tool. A check can be added while the recording is paused.
5. Press **⏹ Stop**. The test is in *Generated Code*. **✏️ Edit** changes it by hand,
   **🧪 To Explorer** keeps it in the Test Explorer, **💾 Save to Project** stores it on the
   platform, **⬇ Download** gives the spec file.

The locators are the recorder's usual ones (test attribute, role and name, label, placeholder,
text, …), each checked to find exactly one element.

## 2. Run

- **▶ Run on Page** — every step shows ✅ ❌ or ⏭️ and how long it took. A step that finds no
  element is tried for 5 seconds.
- **🚀 Run via Playwright** — the real runner. A failed run is healed and run again, as before.
- **🩹 Heal Failures** appears after a failed run on the page and sends the code and the errors
  to the Healer.

Steps the page cannot do (frames, new tabs, dialogs, file uploads, drags, page-object calls)
are shown as ⏭️ skipped: use **Run via Playwright** for those tests.

## 3. Debug (`--debug`), and Pick locator while the test runs

Press **🐞 Debug**. The run waits before step 1.

| Control | What it does |
|---|---|
| ⏭ Step over | Runs one step, then waits again |
| ▶ Resume | Runs on, to the next breakpoint or failure |
| ⏸ Pause | Waits before the next step |
| ● at the left of a step | Breakpoint: the run waits **before** that step |
| Click on a step | Shows its element on the page |
| ⏹ Stop | Ends the run |

When a step fails, the run waits on it instead of going on:

1. Press **🎯 Pick locator**, then click the right element on the page.
2. Press **↪ Use for paused step**. The locator is put in that step and in the code.
3. Press **↻ Retry step**, then **▶ Resume**.

For Playwright's own Inspector: Test Explorer → choose a test → **🐞 Playwright Inspector**.

## 4. Test Explorer (`--ui`)

🧪 **Test Explorer** keeps tests in this browser, each with the result of its last run. It
needs no sign-in. (The 🗂️ Projects tab is still where tests are kept for the team and run on
Jenkins.)

- Add a test: **🧪 To Explorer** in the Recorder or the Generator, **＋ New**, or **⬆ Import**
  spec files (your own `llc.spec.js`, for example).
- **▶ Run all** / **↻ Run failed** run the listed tests one after the other, on the page or
  with real Playwright (the list next to the buttons). Press the button again to stop after
  the test that is running. A batch does not start the healer.
- Click a test to change its name and code, see the steps of its last run, and Run, Debug,
  Download, or Delete it.

Playwright's own tools, at the bottom of the panel (the Bridge must be running):

- **🖥 Playwright UI Mode** — writes the Explorer's tests to `PlaywrightBridge/tests/explorer/`
  and opens `npx playwright test --ui`: watch mode, the timeline, DOM snapshots.
- **🎬 Playwright Codegen** — opens `npx playwright codegen <url>` (an empty address means the
  current tab). Close its window and the recording is added to the Explorer.
- **🐞 Playwright Inspector** — `npx playwright test --debug` for the chosen test.

## Limits

- Run on Page and Debug do not go into frames, new tabs, or dialogs, and have no time-travel
  snapshots. Playwright UI Mode has them.
- Run on Page does not work on `chrome://` pages or the Chrome Web Store.
- The Bridge takes connections from the extension only, never from a web page.

## When something does not work

| What you see | What to do |
|---|---|
| The tools are not in the Recorder | Reload the extension's card; the version must say 1.1.0 |
| "Page did not respond" | Refresh the site's tab |
| "Bridge not running" | `cd PlaywrightBridge && npm start` |
| UI Mode / Codegen / Inspector buttons do nothing | The Bridge is an old one: stop it and `npm start` again |
| "Start recording first" | The Assert tools add a step to a recording; Pick works without one |
| A step is ⏭️ skipped | The page cannot do it: Run via Playwright |
