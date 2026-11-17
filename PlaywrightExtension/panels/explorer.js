// The Test Explorer panel: what `npx playwright test --ui` is to a folder of tests. It keeps
// tests in this browser (chrome.storage.local), runs one, all, or the failed ones, on the page
// or with the real runner, shows the steps of a run, and opens Playwright's own tools (UI
// Mode, the Inspector, Codegen) through the bridge. It needs no sign-in: the Projects tab is
// where tests are kept for a team and run on Jenkins.

import { Storage } from '../utils/storage.js';
import { BridgeClient } from '../utils/bridge-client.js';

const $ = (id) => document.getElementById(id);
const ICON = { passed: '✅', failed: '❌', stopped: '⏹️', skipped: '⏭️' };
const duration = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);
// ANSI colour codes of the runner's output.
const plain = (text) => String(text || '').replace(/\x1b\[[0-9;]*m/g, '');

let tests = [];
let selectedId = null;
// A batch (Run all, Run failed) is in progress; `halt` asks it to end after the test it is on.
let batch = false;
let halt = false;
// What the side panel lends: { runLive, runBridge, toast, download }.
let panel = {};

const save = () => Storage.saveTests(tests);

// Adds a test, or replaces the code of the one with the same name. For the "To Explorer"
// buttons of the Generator and the Recorder, and for a recording brought back from Codegen.
export async function saveTestToExplorer({ name, code, source = 'manual' }) {
  tests = await Storage.getTests();
  const title = String(name || '').trim() || 'Untitled test';
  let test = tests.find((t) => t.name === title);
  if (test) {
    Object.assign(test, { code, source, lastRun: null });
  } else {
    test = { id: `t_${Date.now()}_${Math.floor(Math.random() * 1000)}`, name: title, code, source, createdAt: new Date().toISOString(), lastRun: null };
    tests.push(test);
  }
  await save();
  selectedId = test.id;
  render();
  return test;
}

function shown() {
  const wanted = ($('exp-filter')?.value || '').trim().toLowerCase();
  return wanted ? tests.filter((t) => t.name.toLowerCase().includes(wanted)) : tests;
}

// A test's name and code come from a file or from a page: they are written with textContent.
function render() {
  const list = $('exp-list');
  if (!list) return;
  list.textContent = '';
  const rows = shown();
  if (rows.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'exp-empty';
    empty.textContent = tests.length
      ? 'No test matches the filter.'
      : 'No tests yet. Record or generate a test and press 🧪 To Explorer, press ＋ New, or ⬆ Import a spec file.';
    list.append(empty);
  }
  for (const t of rows) {
    const row = document.createElement('div');
    row.className = `exp-row${t.id === selectedId ? ' selected' : ''}`;
    row.dataset.id = t.id;
    const span = (className, text) => { const s = document.createElement('span'); s.className = className; s.textContent = text; return s; };
    const button = (act, label, title) => { const b = document.createElement('button'); b.className = 'btn btn-icon'; b.dataset.act = act; b.textContent = label; b.title = title; return b; };
    const run = t.lastRun;
    row.append(
      span('exp-status', run ? ICON[run.status] || '○' : '○'),
      span('exp-name', t.name),
      span('exp-meta', run ? `${run.engine === 'bridge' ? 'PW' : 'Page'} ${duration(run.durationMs)}` : t.source || ''),
      button('run', '▶', 'Run on Page'),
      button('debug', '🐞', 'Debug on the page, step by step'),
    );
    list.append(row);
  }
  const count = (status) => tests.filter((t) => t.lastRun?.status === status).length;
  $('exp-summary').textContent = `${tests.length} test(s) · ✅ ${count('passed')} · ❌ ${count('failed')} · ○ ${tests.filter((t) => !t.lastRun).length} not run`;
  renderDetail();
}

function renderDetail() {
  const detail = $('exp-detail');
  const t = tests.find((x) => x.id === selectedId);
  detail.style.display = t ? 'flex' : 'none';
  if (!t) return;
  // The boxes are filled when another test is chosen, not while this one is being edited.
  if (detail.dataset.id !== t.id) {
    detail.dataset.id = t.id;
    $('exp-name').value = t.name;
    $('exp-code').value = t.code;
    $('exp-run-section').style.display = 'none';
  }
  const run = t.lastRun;
  $('exp-last').textContent = !run ? 'Not run yet'
    : `Last run: ${ICON[run.status] || ''} ${run.status} · ${run.engine === 'bridge' ? 'real Playwright' : 'on page'} · ${duration(run.durationMs)} · ${new Date(run.at).toLocaleString()}`
      + (run.engine === 'live' ? ` · ${run.passed} passed, ${run.failed} failed, ${run.skipped} skipped` : '');
}

// Runs one test and keeps how it ended. Resolves with that record, or with null when the run
// could not start (the bridge is not running, or another run has the page).
async function runTest(test, { engine = 'live', debug = false, btn, quiet = false, heal = true } = {}) {
  selectedId = test.id;
  render();
  const at = new Date().toISOString();
  const started = Date.now();
  const where = { section: $('exp-run-section'), results: $('exp-run-results'), summary: $('exp-run-summary'), btn, quiet };
  let lastRun;

  if (engine === 'bridge') {
    $('exp-heal').style.display = 'none';
    const outcome = await panel.runBridge(test.code, {
      ...where, heal,
      // The code that passed is the test's code from now on, a healer's fix included.
      onPassed: (passed) => { test.code = passed; $('exp-code').value = passed; },
    });
    if (outcome === null) return null;
    lastRun = { status: outcome, engine: 'bridge', durationMs: Date.now() - started, at };
  } else {
    const result = await panel.runLive(test.code, {
      ...where, healBtn: $('exp-heal'), debug,
      onCodeChange: (code) => { test.code = code; $('exp-code').value = code; save(); },
    });
    // Nothing the page can run (a test of page objects only), or another run has the page.
    if (!result) return null;
    const s = result.summary;
    lastRun = {
      status: s.failed > 0 ? 'failed' : s.stopped ? 'stopped' : 'passed', engine: 'live', durationMs: result.durationMs, at,
      passed: s.passed, failed: s.failed, skipped: s.skipped,
      steps: result.steps.map(({ label, status, error, ms }) => ({ label, status, error, ms })),
    };
    if (s.stopped) halt = true;
  }
  test.lastRun = lastRun;
  await save();
  render();
  return lastRun;
}

// Run all / Run failed: one test after the other. The button stops the batch while it runs.
async function runMany(list, btn) {
  if (batch) { halt = true; panel.toast('Stopping after this test...'); return; }
  if (list.length === 0) { panel.toast('Nothing to run'); return; }
  const engine = $('exp-engine').value;
  const label = btn.textContent;
  batch = true; halt = false;
  btn.textContent = '⏹ Stop';
  let ran = 0, passed = 0, failed = 0;
  try {
    for (const t of list) {
      if (halt) break;
      $('exp-progress').textContent = `Running ${ran + 1}/${list.length}: ${t.name}`;
      // A batch reports; it does not start the healer on each failure.
      const run = await runTest(t, { engine, btn: $('exp-run'), quiet: true, heal: false });
      if (!run) break;
      ran += 1;
      if (run.status === 'passed') passed += 1;
      else if (run.status === 'failed') failed += 1;
    }
  } finally {
    batch = false;
    btn.textContent = label;
    $('exp-progress').textContent = ran ? `Finished: ${ran}/${list.length} run · ✅ ${passed} · ❌ ${failed}` : '';
    if (ran) panel.toast(failed ? `${failed} test(s) failed` : `${passed} test(s) passed`);
  }
}

function toolLog(text, fresh = false) {
  const box = $('exp-tool-log');
  box.style.display = 'block';
  if (fresh) box.textContent = '';
  box.textContent += plain(text);
  box.scrollTop = box.scrollHeight;
}

// Opens one of Playwright's own tools through the bridge. Resolves with the bridge's last
// message when the tool's window is closed, or null when the bridge could not do it.
async function launch(cmd, payload, title) {
  toolLog(`${title}\n`, true);
  try {
    return await BridgeClient.launchTool(cmd, payload, (msg) => {
      if (msg.type === 'status' || msg.type === 'output') toolLog(msg.message || msg.line || '');
    });
  } catch (e) {
    toolLog(`${e.message}\n\nSetup (once):\n  cd PlaywrightExt/PlaywrightBridge\n  npm run setup\nThen keep running:\n  npm start\n`);
    return null;
  }
}

export async function setupExplorer(lent = {}) {
  panel = lent;
  if (!$('exp-list')) return;
  tests = await Storage.getTests();
  const selected = () => tests.find((t) => t.id === selectedId);

  $('exp-filter').addEventListener('input', render);

  $('exp-list').addEventListener('click', (e) => {
    const row = e.target.closest('.exp-row');
    const t = row && tests.find((x) => x.id === row.dataset.id);
    if (!t) return;
    const act = e.target.dataset.act;
    if (batch && act) { panel.toast('Tests are running — stop them first'); return; }
    selectedId = t.id;
    render();
    if (act === 'run') runTest(t, { btn: $('exp-run') });
    else if (act === 'debug') runTest(t, { debug: true, btn: $('exp-debug') });
  });

  $('exp-run-all').addEventListener('click', (e) => runMany(shown(), e.currentTarget));
  $('exp-run-failed').addEventListener('click', (e) => runMany(shown().filter((t) => t.lastRun?.status === 'failed'), e.currentTarget));

  $('exp-new').addEventListener('click', () => saveTestToExplorer({
    name: `New test ${tests.length + 1}`,
    code: `import { test, expect } from '@playwright/test';\n\ntest('new test', async ({ page }) => {\n  await page.goto('https://example.com/');\n  await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();\n});`,
  }));

  $('exp-import').addEventListener('click', () => $('exp-file').click());
  $('exp-file').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      const name = file.name.replace(/(\.(spec|test))?\.(ts|js|mjs|cjs)$/i, '') || file.name;
      await saveTestToExplorer({ name, code: await file.text(), source: 'import' });
    }
    e.target.value = '';
    panel.toast('Imported');
  });

  // ---- The chosen test ----
  // What is in the boxes is the test: it is kept before the test is run or downloaded.
  const keepBoxes = async (t) => {
    const name = $('exp-name').value.trim() || t.name;
    const code = $('exp-code').value;
    if (name === t.name && code === t.code) return;
    Object.assign(t, { name, code });
    await save();
  };
  const withTest = (act) => async (e) => {
    const t = selected();
    if (!t) return;
    if (batch) { panel.toast('Tests are running — stop them first'); return; }
    await keepBoxes(t);
    act(t, e.currentTarget);
  };
  $('exp-save').addEventListener('click', withTest(() => { render(); panel.toast('Saved'); }));
  $('exp-run').addEventListener('click', withTest((t, btn) => runTest(t, { btn })));
  $('exp-debug').addEventListener('click', withTest((t, btn) => runTest(t, { debug: true, btn })));
  $('exp-run-bridge').addEventListener('click', withTest((t, btn) => runTest(t, { engine: 'bridge', btn })));
  $('exp-download').addEventListener('click', withTest((t) => panel.download?.(t.code, t.name)));
  $('exp-delete').addEventListener('click', withTest(async (t) => {
    tests = tests.filter((x) => x.id !== t.id);
    selectedId = null;
    await save();
    render();
    panel.toast(`Deleted "${t.name}"`);
  }));

  // ---- Playwright's own tools ----
  // npx playwright test --debug: the Playwright Inspector steps through the chosen test.
  $('exp-inspector').addEventListener('click', withTest(async (t, btn) => {
    btn.disabled = true;
    const done = await launch('debug', { code: t.code }, '🐞 npx playwright test --debug');
    btn.disabled = false;
    if (done) toolLog(`\n${done.passed ? '✅ passed' : `❌ ended with code ${done.exitCode}`}\n`);
  }));

  // npx playwright test --ui, with every test of the Explorer.
  $('exp-ui-mode').addEventListener('click', async () => {
    if (tests.length === 0) { panel.toast('Add a test first'); return; }
    await launch('uiMode', { tests: tests.map(({ name, code }) => ({ name, code })) }, '🖥 npx playwright test --ui');
  });

  // npx playwright codegen <url>: what is recorded there comes back as a test of the Explorer.
  $('exp-codegen').addEventListener('click', async () => {
    let url = $('exp-codegen-url').value.trim();
    if (!url) {
      const tab = await new Promise((resolve) => chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, resolve));
      if (/^https?:/.test(tab?.url || '')) url = tab.url;
    }
    const done = await launch('codegen', { url }, `🎬 npx playwright codegen ${url}`);
    if (!done) return;
    if (!String(done.code || '').trim()) { toolLog('\nCodegen was closed with nothing recorded.\n'); return; }
    const t = await saveTestToExplorer({ name: `Codegen ${new Date().toLocaleTimeString()}`, code: done.code, source: 'codegen' });
    toolLog(`\nThe recording is in the Explorer as "${t.name}".\n`);
    panel.toast('Codegen recording imported');
  });

  render();
}
