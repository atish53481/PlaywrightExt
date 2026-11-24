// Test Explorer — the extension's take on `npx playwright test --ui`:
// saved tests, run one / all / failed, per-step timeline, debug, and buttons that
// open the real Playwright tools (UI Mode, Inspector, Codegen) through the bridge.

import { Storage } from '../utils/storage.js';
import { BridgeClient } from '../utils/bridge-client.js';
import { runCodeLive, runCodeViaBridge, isLiveRunActive, toast, esc } from './live-run.js';

const $ = (id) => document.getElementById(id);
const STATUS_ICON = { passed: '✅', failed: '❌', stopped: '⏹️', norun: '⚠️' };
const fmtMs = (ms) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

let tests = [];
let selectedId = null;
let busy = false;
let abortAll = false;
let hooks = {};

async function persist() { await Storage.saveTests(tests); }

// Adds a test (or updates the one with the same name). Used by the Recorder and
// Generator panels' "Save to Explorer" buttons and by Codegen import.
export async function saveTestToExplorer({ name, code, source = 'manual' }) {
  tests = await Storage.getTests();
  const clean = (name || 'Untitled test').trim() || 'Untitled test';
  let test = tests.find(t => t.name === clean);
  if (test) {
    test.code = code;
    test.source = source;
    test.lastRun = null;
  } else {
    test = { id: `t_${Date.now()}_${Math.floor(Math.random() * 1000)}`, name: clean, code, source, createdAt: new Date().toISOString(), lastRun: null };
    tests.push(test);
  }
  await persist();
  selectedId = test.id;
  render();
  return test;
}

function visibleTests() {
  const q = ($('exp-filter')?.value || '').trim().toLowerCase();
  return q ? tests.filter(t => t.name.toLowerCase().includes(q)) : tests;
}

function render() {
  const list = $('exp-list');
  if (!list) return;
  const shown = visibleTests();
  list.innerHTML = shown.length === 0
    ? `<div class="exp-empty">${tests.length ? 'No test matches the filter.' : 'No saved tests yet. Record or generate a test and click 💾 Save to Explorer, or ⬆ Import a spec file.'}</div>`
    : shown.map(t => {
      const r = t.lastRun;
      return `<div class="exp-row${t.id === selectedId ? ' selected' : ''}" data-id="${esc(t.id)}">
        <span class="exp-status" title="${esc(r ? r.status : 'not run')}">${r ? STATUS_ICON[r.status] || '○' : '○'}</span>
        <span class="exp-name">${esc(t.name)}</span>
        <span class="exp-meta">${r ? `${esc(r.engine === 'bridge' ? 'PW' : 'Live')} ${fmtMs(r.durationMs)}` : esc(t.source || '')}</span>
        <button class="btn btn-icon" data-act="run" title="Run on page">▶</button>
        <button class="btn btn-icon" data-act="debug" title="Debug on page (step through)">🐞</button>
      </div>`;
    }).join('');

  const count = (s) => tests.filter(t => t.lastRun?.status === s).length;
  $('exp-summary').textContent = `${tests.length} test(s) · ✅ ${count('passed')} · ❌ ${count('failed')} · ○ ${tests.filter(t => !t.lastRun).length} not run`;
  renderDetail();
}

function renderDetail() {
  const detail = $('exp-detail');
  const t = tests.find(x => x.id === selectedId);
  detail.style.display = t ? 'flex' : 'none';
  if (!t) return;
  if (detail.getAttribute('data-id') !== t.id) {
    detail.setAttribute('data-id', t.id);
    $('exp-name').value = t.name;
    $('exp-code').value = t.code;
    $('exp-run-section').style.display = 'none';
  }
  const r = t.lastRun;
  $('exp-last').textContent = !r ? 'Not run yet'
    : `Last run: ${STATUS_ICON[r.status] || ''} ${r.status} · ${r.engine === 'bridge' ? 'Playwright' : 'Live'} · ${fmtMs(r.durationMs)} · ${new Date(r.at).toLocaleString()}`
      + (r.engine === 'live' ? ` · ${r.passed} passed, ${r.failed} failed, ${r.skipped} skipped` : '');
}

const runTargets = (btn) => ({
  section: $('exp-run-section'), results: $('exp-run-results'), summary: $('exp-run-summary'), btn,
});

// Runs one test and stores its result. Returns the lastRun record (or null if nothing ran).
async function runTest(test, { engine = 'live', debug = false, btn, quiet = false } = {}) {
  selectedId = test.id;
  render();
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let lastRun = null;

  if (engine === 'bridge') {
    const res = await runCodeViaBridge(test.code, { ...runTargets(btn), mode: debug ? 'debug' : 'run', quiet });
    if (!res) return null; // bridge unavailable — leave the previous result alone
    lastRun = { status: res.passed ? 'passed' : 'failed', engine: 'bridge', durationMs: Date.now() - t0, at: startedAt, exitCode: res.exitCode };
  } else {
    const res = await runCodeLive(test.code, {
      ...runTargets(btn), healBtn: $('exp-heal'), debug, quiet,
      onHeal: hooks.onHeal,
      onCodeChange: (code) => { test.code = code; $('exp-code').value = code; persist(); },
    });
    if (!res) {
      if (isLiveRunActive()) return null;
      lastRun = { status: 'norun', engine: 'live', durationMs: 0, at: startedAt, passed: 0, failed: 0, skipped: 0, steps: [] };
    } else {
      const s = res.summary;
      lastRun = {
        status: s.failed > 0 ? 'failed' : s.stopped ? 'stopped' : 'passed', engine: 'live',
        durationMs: res.durationMs, at: startedAt, passed: s.passed, failed: s.failed, skipped: s.skipped, steps: res.steps,
      };
      if (s.stopped) abortAll = true;
    }
  }
  test.lastRun = lastRun;
  await persist();
  render();
  return lastRun;
}

async function runMany(list, btn) {
  if (busy) { abortAll = true; toast('Stopping after the current test...'); return; }
  if (list.length === 0) { toast('Nothing to run'); return; }
  const engine = $('exp-engine').value;
  busy = true; abortAll = false;
  const label = btn.textContent;
  btn.textContent = '⏹ Stop';
  let passed = 0, failed = 0, ran = 0;
  try {
    for (const t of list) {
      if (abortAll) break;
      $('exp-progress').textContent = `Running ${ran + 1}/${list.length}: ${t.name}`;
      const r = await runTest(t, { engine, btn: $('exp-run'), quiet: true });
      if (!r) break; // bridge unavailable or another run in progress
      ran++;
      if (r.status === 'passed') passed++; else if (r.status === 'failed') failed++;
    }
  } finally {
    busy = false;
    btn.textContent = label;
    $('exp-progress').textContent = ran ? `Finished: ${ran}/${list.length} run · ✅ ${passed} · ❌ ${failed}` : '';
    if (ran) toast(failed ? `${failed} test(s) failed` : `${passed} test(s) passed`);
  }
}

function toolLog(text, reset) {
  const box = $('exp-tool-log');
  box.style.display = 'block';
  if (reset) box.textContent = '';
  box.textContent += text.replace(/\x1b\[[0-9;]*m/g, '');
  box.scrollTop = box.scrollHeight;
}

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

// { onHeal(code, failedSteps), exportCode(code, name) }
export async function setupExplorer(opts = {}) {
  hooks = opts;
  tests = await Storage.getTests();
  const selected = () => tests.find(t => t.id === selectedId);
  const isJs = (t) => !/^\s*(from|import)\s+playwright|def\s+test_/m.test(t.code);

  $('exp-filter').addEventListener('input', render);

  $('exp-list').addEventListener('click', (e) => {
    const row = e.target.closest('.exp-row');
    if (!row) return;
    const t = tests.find(x => x.id === row.getAttribute('data-id'));
    if (!t) return;
    const act = e.target.getAttribute('data-act');
    if (busy && act) { toast('A batch run is in progress'); return; }
    selectedId = t.id;
    render();
    if (act === 'run') runTest(t, { btn: e.target });
    else if (act === 'debug') runTest(t, { debug: true, btn: e.target });
  });

  $('exp-run-all').addEventListener('click', (e) => runMany(visibleTests().filter(isJs), e.currentTarget));
  $('exp-run-failed').addEventListener('click', (e) => runMany(visibleTests().filter(t => t.lastRun?.status === 'failed'), e.currentTarget));

  $('exp-new').addEventListener('click', async () => {
    await saveTestToExplorer({
      name: `New test ${tests.length + 1}`,
      code: `import { test, expect } from '@playwright/test';\n\ntest('new test', async ({ page }) => {\n  await page.goto('https://example.com/');\n  await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();\n});`,
    });
  });

  $('exp-import').addEventListener('click', () => $('exp-file').click());
  $('exp-file').addEventListener('change', async (e) => {
    for (const file of e.target.files) {
      const code = await file.text();
      await saveTestToExplorer({ name: file.name.replace(/\.(spec|test)?\.?(ts|js|mjs|cjs)$/i, '') || file.name, code, source: 'import' });
    }
    e.target.value = '';
    toast('Imported');
  });

  // ---- detail ----
  $('exp-save').addEventListener('click', async () => {
    const t = selected();
    if (!t) return;
    t.name = $('exp-name').value.trim() || t.name;
    t.code = $('exp-code').value;
    await persist();
    render();
    toast('Saved');
  });
  const withSaved = (fn) => async (e) => {
    const t = selected();
    if (!t) return;
    if (busy) { toast('A batch run is in progress'); return; }
    if ($('exp-code').value !== t.code) { t.code = $('exp-code').value; await persist(); }
    fn(t, e.currentTarget);
  };
  $('exp-run').addEventListener('click', withSaved((t, btn) => runTest(t, { btn })));
  $('exp-debug').addEventListener('click', withSaved((t, btn) => runTest(t, { debug: true, btn })));
  $('exp-run-bridge').addEventListener('click', withSaved((t, btn) => runTest(t, { engine: 'bridge', btn })));
  $('exp-debug-bridge').addEventListener('click', withSaved((t, btn) => runTest(t, { engine: 'bridge', debug: true, btn })));
  $('exp-export').addEventListener('click', withSaved((t) => hooks.exportCode?.(t.code, t.name)));
  $('exp-delete').addEventListener('click', async () => {
    const t = selected();
    if (!t || busy) return;
    tests = tests.filter(x => x.id !== t.id);
    selectedId = null;
    await persist();
    render();
    toast(`Deleted "${t.name}"`);
  });

  // ---- real Playwright tools (bridge) ----
  $('exp-ui-mode').addEventListener('click', async () => {
    const js = tests.filter(isJs);
    if (!js.length) { toast('Save a test first'); return; }
    await launch('uiMode', { tests: js.map(t => ({ name: t.name, code: t.code })) }, '🖥 npx playwright test --ui');
  });

  $('exp-codegen').addEventListener('click', async () => {
    let url = $('exp-codegen-url').value.trim();
    if (!url) {
      const tab = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, r));
      if (/^https?:/.test(tab?.url || '')) url = tab.url;
    }
    const res = await launch('codegen', { url }, `🎬 npx playwright codegen ${url}`);
    if (res?.code?.trim()) {
      const t = await saveTestToExplorer({ name: `Codegen ${new Date().toLocaleTimeString()}`, code: res.code, source: 'codegen' });
      toolLog(`\nRecording imported as "${t.name}".\n`);
      toast('Codegen recording imported');
    } else if (res) {
      toolLog('\nCodegen closed without recording anything.\n');
    }
  });

  render();
}
