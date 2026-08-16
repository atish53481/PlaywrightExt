import { Orchestrator } from './agents/orchestrator.js';
import { MockProvider } from './providers/mock-provider.js';
import { ClaudeProvider } from './providers/claude-provider.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';
import { BridgeProvider } from './providers/bridge-provider.js';
import { BridgeClient } from './utils/bridge-client.js';
import { Storage } from './utils/storage.js';
import { PlaywrightCodegen } from './utils/playwright-codegen.js';
import { TestRunner } from './utils/test-runner.js';

// ---- State ----
let orchestrator = new Orchestrator(new MockProvider());
let currentProvider = 'mock';
let lastOutput = '';
let recorderActions = [];
let recorderInterval = null;
let sessionInterval = null;
let sessionStartTime = null;
let sessionActionCount = 0;
let sessionRequestCount = 0;
let isRecording = false;
let isInspecting = false;
let isSessionCapturing = false;

// ---- Init ----
async function init() {
  await loadSettings();
  setupNav();
  setupPlanner();
  setupGenerator();
  setupHealer();
  setupRecorder();
  setupInspector();
  setupChat();
  setupFramework();
  setupExport();
  setupSession();
  setupOrchestrator();
  setupSettings();
  listenForContentMessages();
}

// ---- Navigation ----
function setupNav() {
  document.querySelectorAll('.nav-btn[data-panel]').forEach(btn => {
    btn.addEventListener('click', () => {
      const panelId = btn.getAttribute('data-panel');
      document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(`panel-${panelId}`)?.classList.add('active');
    });
  });
}

// ---- Helpers ----
function setOutput(el, text) {
  el.textContent = text;
  lastOutput = text;
}

function showLoading(el, message = 'AI is thinking...') {
  el.innerHTML = `<div class="loader"><div class="spinner"></div>${message}</div>`;
}

function copyText(text) {
  navigator.clipboard.writeText(text).then(() => {
    showToast('Copied!');
  }).catch(() => {});
}

function showToast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  Object.assign(t.style, {
    position: 'fixed', bottom: '12px', left: '50%', transform: 'translateX(-50%)',
    background: 'var(--accent)', color: '#000', padding: '6px 14px',
    borderRadius: '6px', fontSize: '12px', fontWeight: '600',
    zIndex: '99999', pointerEvents: 'none', transition: 'opacity 0.3s'
  });
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 1200);
}

function setStepStatus(stepId, status, text) {
  const el = document.getElementById(stepId);
  if (!el) return;
  el.className = `step-status ${status}`;
  el.textContent = text;
}

function appendOrcLog(msg) {
  const log = document.getElementById('orch-log');
  if (!log) return;
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

// ---- Provider Setup ----
async function loadSettings() {
  const settings = await Storage.getSettings();
  currentProvider = settings.provider || 'mock';
  updateProvider(currentProvider, settings.apiKey, settings.model);

  const apiSection = document.getElementById('api-key-section');
  const apiKeyInput = document.getElementById('settings-apikey');
  const modelInput = document.getElementById('settings-model');
  if (apiKeyInput) apiKeyInput.value = settings.apiKey || '';
  if (modelInput) modelInput.value = settings.model || '';
  if (apiSection) apiSection.style.display = (currentProvider !== 'mock' && currentProvider !== 'bridge') ? 'block' : 'none';

  document.querySelectorAll('.provider-card').forEach(card => {
    card.classList.toggle('selected', card.getAttribute('data-provider') === currentProvider);
  });
}

function updateProvider(providerName, apiKey = '', model = '') {
  const providers = {
    mock:   () => new MockProvider(),
    claude: () => new ClaudeProvider({ apiKey, model }),
    openai: () => new OpenAIProvider({ apiKey, model }),
    gemini: () => new GeminiProvider({ apiKey, model }),
    bridge: () => new BridgeProvider(),
  };
  const factory = providers[providerName] || providers.mock;
  const provider = factory();
  orchestrator.setProvider(provider);

  const badge = document.getElementById('provider-badge');
  const label = document.getElementById('provider-label');
  const names = { mock: 'Mock Provider', claude: 'Claude', openai: 'OpenAI', gemini: 'Gemini', bridge: 'Bridge (Claude Code)' };
  if (badge) badge.textContent = providerName.toUpperCase();
  if (label) label.textContent = names[providerName] || providerName;

  // Warn immediately when a real provider is selected but its key is unusable —
  // otherwise every agent call fails and it looks like "generator not working"
  if (providerName !== 'mock' && !provider.isConfigured()) {
    if (badge) badge.textContent = `${providerName.toUpperCase()} ⚠ NO KEY`;
    if (label) label.textContent = `${names[providerName]} — API key missing/invalid`;
  }
}

// ---- 1. TEST PLANNER ----
function setupPlanner() {
  const runBtn = document.getElementById('planner-run');
  const output = document.getElementById('planner-output');

  runBtn?.addEventListener('click', async () => {
    const text = document.getElementById('planner-input')?.value?.trim();
    if (!text) { showToast('Enter requirements first'); return; }
    const inputType = document.getElementById('planner-input-type')?.value;
    runBtn.disabled = true;
    showLoading(output, '🎭 planner agent exploring requirements...');
    try {
      // Seed context from the live page (maps to the official seed.spec.ts concept)
      const pageContext = await new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, tab =>
          resolve(tab?.url ? { url: tab.url, title: tab.title || '' } : null));
      });
      const result = await orchestrator.dispatch('planner', { text, inputType, pageContext });
      setOutput(output, result);
    } catch(e) {
      output.textContent = `Error: ${e.message}`;
    } finally { runBtn.disabled = false; }
  });

  document.getElementById('planner-copy')?.addEventListener('click', () => {
    copyText(document.getElementById('planner-output')?.textContent || '');
  });

  document.getElementById('planner-export-md')?.addEventListener('click', () => {
    const content = document.getElementById('planner-output')?.textContent;
    if (content) orchestrator.getAgent('export').exportAsMarkdown(content, 'test-plan');
  });

  document.getElementById('planner-export-csv')?.addEventListener('click', () => {
    showToast('CSV export: paste output into any CSV converter');
  });

  document.getElementById('planner-clear')?.addEventListener('click', () => {
    document.getElementById('planner-input').value = '';
    document.getElementById('planner-output').innerHTML = '<span class="output-placeholder">Test plan will appear here...</span>';
  });
}

// ---- 2. TEST GENERATOR ----
function setupGenerator() {
  const runBtn = document.getElementById('gen-run');
  const output = document.getElementById('gen-output');

  runBtn?.addEventListener('click', async () => {
    const testPlan = document.getElementById('gen-input')?.value?.trim();
    if (!testPlan) { showToast('Enter a test plan or requirements first'); return; }
    const language = document.getElementById('gen-language')?.value;
    const framework = document.getElementById('gen-framework')?.value;
    const options = {
      generatePOM: document.getElementById('gen-pom')?.checked,
      fixtures: document.getElementById('gen-fixtures')?.checked,
      utilities: document.getElementById('gen-utils')?.checked,
      api: document.getElementById('gen-api')?.checked,
      visual: document.getElementById('gen-visual')?.checked,
    };
    runBtn.disabled = true;
    showLoading(output, `Test Generator creating ${language} ${framework} code...`);
    try {
      const result = await orchestrator.dispatch('generator', { testPlan, language, framework, options });
      setOutput(output, result);
    } catch(e) {
      output.textContent = `Error: ${e.message}`;
    } finally { runBtn.disabled = false; }
  });

  document.getElementById('gen-copy')?.addEventListener('click', () => {
    copyText(document.getElementById('gen-output')?.textContent || '');
  });

  document.getElementById('gen-export')?.addEventListener('click', () => {
    const content = document.getElementById('gen-output')?.textContent;
    const lang = document.getElementById('gen-language')?.value || 'typescript';
    if (content) orchestrator.getAgent('export').exportAsCode(content, lang, 'playwright-tests');
  });

  document.getElementById('gen-clear')?.addEventListener('click', () => {
    document.getElementById('gen-input').value = '';
    document.getElementById('gen-output').innerHTML = '<span class="output-placeholder">Playwright code will appear here...</span>';
    const runSection = document.getElementById('gen-run-section');
    if (runSection) runSection.style.display = 'none';
  });

  // ---- Run generated code with the REAL Playwright runner via the local bridge ----
  const bridgeBtn = document.getElementById('gen-run-bridge');
  bridgeBtn?.addEventListener('click', async () => {
    const code = document.getElementById('gen-output')?.textContent || '';
    if (!code || code.includes('will appear here')) { showToast('Generate code first'); return; }
    await runCodeViaBridge(code, {
      section: document.getElementById('gen-run-section'),
      results: document.getElementById('gen-run-results'),
      summary: document.getElementById('gen-run-summary'),
      btn: bridgeBtn
    });
  });

  // ---- Run generated code live on the active page ----
  const liveBtn = document.getElementById('gen-run-live');
  liveBtn?.addEventListener('click', async () => {
    const code = document.getElementById('gen-output')?.textContent || '';
    if (!code || code.includes('will appear here')) { showToast('Generate code first'); return; }
    await runCodeLive(code, {
      section: document.getElementById('gen-run-section'),
      results: document.getElementById('gen-run-results'),
      summary: document.getElementById('gen-run-summary'),
      btn: liveBtn,
      healBtn: document.getElementById('gen-heal'),
      idPrefix: 'gen-run'
    });
  });
}

// ---- Shared run helpers (Generator + Recorder panels) ----
async function runCodeViaBridge(code, { section, results, summary, btn }) {
  section.style.display = 'block';
  results.innerHTML = '<pre style="margin:0;font-size:11px;white-space:pre-wrap;word-break:break-all"></pre>';
  const log = results.querySelector('pre');
  summary.textContent = '🌉 connecting to bridge...';
  btn.disabled = true;

  try {
    const res = await BridgeClient.runCode(code, (msg) => {
      if (msg.type === 'status' || msg.type === 'output') {
        log.textContent += msg.message || msg.line || '';
        results.scrollTop = results.scrollHeight;
        summary.textContent = '🏃 Playwright running (headed)...';
      }
    });
    summary.textContent = res.passed ? '✅ Playwright run PASSED' : `❌ Playwright run FAILED (exit ${res.exitCode})`;
    showToast(res.passed ? 'Real Playwright run passed!' : 'Run failed — see output');
  } catch (e) {
    summary.textContent = '🌉 bridge unavailable';
    log.textContent = `${e.message}\n\nSetup (once):\n  cd PlaywrightExt/PlaywrightBridge\n  npm run setup\n\nThen keep running:\n  npm start`;
  } finally {
    btn.disabled = false;
  }
}

async function runCodeLive(code, { section, results, summary, btn, healBtn, idPrefix }) {
  const steps = TestRunner.parse(code);
  if (steps.length === 0) { showToast('No runnable Playwright steps found in code'); return; }

  section.style.display = 'block';
  summary.textContent = `0/${steps.length}`;

  const icons = { pending: '⏳', running: '▶️', passed: '✅', failed: '❌', skipped: '⏭️' };
  results.innerHTML = steps.map((s, i) =>
    `<div class="run-step" id="${idPrefix}-step-${i}" style="padding:3px 6px;font-size:11px;font-family:monospace;border-bottom:1px solid var(--border,#333)">
      <span id="${idPrefix}-step-icon-${i}">${icons.pending}</span> ${s.label.replace(/</g, '&lt;')}
      <div id="${idPrefix}-step-detail-${i}" style="color:#ff6b6b;padding-left:20px"></div>
    </div>`).join('');

  btn.disabled = true;
  if (healBtn) healBtn.style.display = 'none';
  const failedSteps = [];
  let done = 0;
  try {
    const runSummary = await TestRunner.run(steps, (i, status, detail) => {
      const icon = document.getElementById(`${idPrefix}-step-icon-${i}`);
      if (icon) icon.textContent = icons[status] || '';
      if (status !== 'running') {
        done++;
        summary.textContent = `${done}/${steps.length}`;
      }
      if (status === 'failed' && detail) {
        failedSteps.push({ label: steps[i].label, error: detail });
        const d = document.getElementById(`${idPrefix}-step-detail-${i}`);
        if (d) d.textContent = detail;
      }
      document.getElementById(`${idPrefix}-step-${i}`)?.scrollIntoView({ block: 'nearest' });
    });
    summary.textContent = `✅ ${runSummary.passed} passed · ❌ ${runSummary.failed} failed · ⏭️ ${runSummary.skipped} skipped`;
    showToast(runSummary.failed === 0 ? 'All runnable steps passed!' : `${runSummary.failed} step(s) failed`);

    // 🎭 healer stage (official test-agents workflow): route failures to the healer agent
    if (runSummary.failed > 0 && healBtn) {
      healBtn.style.display = 'inline-block';
      healBtn.onclick = () => {
        const healerCode = document.getElementById('healer-code');
        const healerError = document.getElementById('healer-error');
        if (healerCode) healerCode.value = code;
        if (healerError) healerError.value = failedSteps.map(f => `${f.label} → ${f.error}`).join('\n');
        document.querySelector('.nav-btn[data-panel="healer"]')?.click();
        document.getElementById('healer-run')?.click();
      };
    }
  } catch (e) {
    summary.textContent = `Error: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- 3. TEST HEALER ----
function setupHealer() {
  const runBtn = document.getElementById('healer-run');
  const output = document.getElementById('healer-output');

  runBtn?.addEventListener('click', async () => {
    const brokenCode = document.getElementById('healer-code')?.value?.trim();
    if (!brokenCode) { showToast('Paste broken test code first'); return; }
    const errorMessage = document.getElementById('healer-error')?.value?.trim();
    const context = document.getElementById('healer-context')?.value?.trim();
    runBtn.disabled = true;
    showLoading(output, 'Test Healer analyzing broken test...');
    try {
      const result = await orchestrator.dispatch('healer', { brokenCode, errorMessage, context });
      setOutput(output, result);
    } catch(e) {
      output.textContent = `Error: ${e.message}`;
    } finally { runBtn.disabled = false; }
  });

  document.getElementById('healer-copy')?.addEventListener('click', () => {
    copyText(document.getElementById('healer-output')?.textContent || '');
  });

  document.getElementById('healer-export')?.addEventListener('click', () => {
    const content = document.getElementById('healer-output')?.textContent;
    if (content) orchestrator.getAgent('export').exportAsMarkdown(content, 'healer-report');
  });

  document.getElementById('healer-clear')?.addEventListener('click', () => {
    ['healer-code','healer-error','healer-context'].forEach(id => { const el = document.getElementById(id); if(el) el.value=''; });
    document.getElementById('healer-output').innerHTML = '<span class="output-placeholder">Healing analysis will appear here...</span>';
  });
}

// ---- 4. RECORDER ----
function setupRecorder() {
  const startBtn = document.getElementById('rec-start');
  const pauseBtn = document.getElementById('rec-pause');
  const stopBtn  = document.getElementById('rec-stop');
  const dot      = document.getElementById('rec-dot');
  const statusTxt= document.getElementById('rec-status-text');
  const countTxt = document.getElementById('rec-count');
  const output   = document.getElementById('rec-output');
  const editBtn  = document.getElementById('rec-edit');
  let isEditingCode = false;   // textarea currently open
  let userEditedCode = false;  // saved manual edits — don't overwrite with regenerated code

  function updateRecOutput() {
    if (recorderActions.length === 0 || isEditingCode || userEditedCode) return;
    const lang = document.getElementById('rec-language')?.value || 'typescript';
    const name = document.getElementById('rec-test-name')?.value || 'Recorded Test';
    const code = PlaywrightCodegen.actionsToTest(recorderActions, name, lang);
    output.textContent = code;
    lastOutput = code;
  }

  function renderActionList() {
    const list = document.getElementById('action-list');
    if (!list) return;
    list.innerHTML = recorderActions.length === 0
      ? '<span style="color:var(--text3);font-size:11px;padding:4px">No actions yet</span>'
      : recorderActions.map(a => `<div class="action-item"><span class="action-type">${a.type}</span><span>${a.selector || a.url || a.key || a.value || ''}</span></div>`).join('');
    list.scrollTop = list.scrollHeight;
    if (countTxt) countTxt.textContent = `${recorderActions.length} actions`;
    renderRiskWarnings();
  }

  function renderRiskWarnings() {
    const box = document.getElementById('rec-warnings');
    if (!box) return;
    const risky = PlaywrightCodegen.detectRiskyActions(recorderActions);
    if (risky.length === 0) { box.style.display = 'none'; box.innerHTML = ''; return; }
    box.style.display = 'block';
    box.innerHTML = `⚠ ${risky.length} action(s) may assume missing setup:<br>` +
      risky.map(r => `&bull; ${r.reason.replace(/</g, '&lt;')}`).join('<br>');
  }

  startBtn?.addEventListener('click', () => {
    isRecording = true; recorderActions = [];
    isEditingCode = false; userEditedCode = false;
    if (editBtn) editBtn.textContent = '✏️ Edit';
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'START_RECORDING' } }, (resp) => {
      if (resp?.error || !resp?.ok) {
        // Recording never started on the page — show why instead of a fake state
        isRecording = false;
        clearInterval(recorderInterval);
        dot.className = 'rec-dot';
        statusTxt.textContent = `❌ ${resp?.error || 'Page did not respond — refresh the tab and retry'}`;
        startBtn.disabled = false; pauseBtn.disabled = true; stopBtn.disabled = true;
        showToast('Recording failed to start');
        return;
      }
      dot.className = 'rec-dot recording';
      statusTxt.textContent = 'Recording...';
    });
    startBtn.disabled = true; pauseBtn.disabled = false; stopBtn.disabled = false;
    renderActionList();
    recorderInterval = setInterval(() => { updateRecOutput(); }, 2000);
  });

  pauseBtn?.addEventListener('click', () => {
    if (isRecording) {
      isRecording = false;
      chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'PAUSE_RECORDING' } });
      dot.className = 'rec-dot paused';
      statusTxt.textContent = 'Paused';
      pauseBtn.textContent = '▶ Resume';
    } else {
      isRecording = true;
      chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'RESUME_RECORDING' } });
      dot.className = 'rec-dot recording';
      statusTxt.textContent = 'Recording...';
      pauseBtn.textContent = '⏸ Pause';
    }
  });

  stopBtn?.addEventListener('click', () => {
    isRecording = false;
    clearInterval(recorderInterval);
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'STOP_RECORDING' } }, (resp) => {
      if (resp?.actions) recorderActions = resp.actions;
      renderActionList();
      updateRecOutput();
    });
    dot.className = 'rec-dot';
    statusTxt.textContent = `Stopped — ${recorderActions.length} actions`;
    startBtn.disabled = false; pauseBtn.disabled = true; stopBtn.disabled = true;
    pauseBtn.textContent = '⏸ Pause';
  });

  document.getElementById('rec-ai-enhance')?.addEventListener('click', async () => {
    if (recorderActions.length === 0) { showToast('Record some actions first'); return; }
    const lang = document.getElementById('rec-language')?.value;
    const name = document.getElementById('rec-test-name')?.value;
    showLoading(output, 'AI enhancing recorded code...');
    try {
      const result = await orchestrator.dispatch('recorder', { actions: recorderActions, language: lang, testName: name });
      setOutput(output, result);
    } catch(e) { output.textContent = `Error: ${e.message}`; }
  });

  // ---- Edit / Save recorded code ----
  editBtn?.addEventListener('click', () => {
    if (!isEditingCode) {
      if (isRecording) { showToast('Stop recording first'); return; }
      const code = output?.textContent || '';
      if (!code || code.includes('will generate code here')) { showToast('Record some actions first'); return; }
      isEditingCode = true;
      output.innerHTML = '';
      const ta = document.createElement('textarea');
      ta.id = 'rec-edit-area';
      ta.value = code;
      ta.spellcheck = false;
      ta.style.cssText = 'width:100%;min-height:220px;resize:vertical;background:transparent;color:inherit;border:none;outline:none;font-family:monospace;font-size:inherit;white-space:pre';
      output.appendChild(ta);
      ta.focus();
      editBtn.textContent = '✔ Save';
      showToast('Editing — click Save when done');
    } else {
      const edited = document.getElementById('rec-edit-area')?.value ?? '';
      isEditingCode = false;
      userEditedCode = true;
      output.textContent = edited;
      lastOutput = edited;
      editBtn.textContent = '✏️ Edit';
      showToast('Edits saved');
    }
  });

  // ---- Run the recorded script (same two paths as the Generator panel) ----
  function getRecordedCode() {
    if (isEditingCode) { showToast('Save edits first (✔ Save)'); return null; }
    const code = output?.textContent || '';
    if (!code || code.includes('will generate code here')) { showToast('Record some actions first'); return null; }
    if ((document.getElementById('rec-language')?.value || 'typescript') === 'python') {
      showToast('Run supports TypeScript/JavaScript only');
      return null;
    }
    return code;
  }

  const recBridgeBtn = document.getElementById('rec-run-bridge');
  recBridgeBtn?.addEventListener('click', async () => {
    const code = getRecordedCode();
    if (!code) return;
    await runCodeViaBridge(code, {
      section: document.getElementById('rec-run-section'),
      results: document.getElementById('rec-run-results'),
      summary: document.getElementById('rec-run-summary'),
      btn: recBridgeBtn
    });
  });

  const recLiveBtn = document.getElementById('rec-run-live');
  recLiveBtn?.addEventListener('click', async () => {
    const code = getRecordedCode();
    if (!code) return;
    await runCodeLive(code, {
      section: document.getElementById('rec-run-section'),
      results: document.getElementById('rec-run-results'),
      summary: document.getElementById('rec-run-summary'),
      btn: recLiveBtn,
      healBtn: document.getElementById('rec-heal'),
      idPrefix: 'rec-run'
    });
  });

  document.getElementById('rec-copy')?.addEventListener('click', () =>
    copyText(isEditingCode ? (document.getElementById('rec-edit-area')?.value || '') : output.textContent));
  document.getElementById('rec-export')?.addEventListener('click', () => {
    const code = isEditingCode ? (document.getElementById('rec-edit-area')?.value || '') : output.textContent;
    if (code) orchestrator.getAgent('export').exportAsCode(code, 'typescript', 'recorded-test');
  });
  document.getElementById('rec-clear')?.addEventListener('click', () => {
    recorderActions = [];
    clearInterval(recorderInterval);
    renderActionList();
    isEditingCode = false; userEditedCode = false;
    if (editBtn) editBtn.textContent = '✏️ Edit';
    output.innerHTML = '<span class="output-placeholder">Recording will generate code here...</span>';
    const runSection = document.getElementById('rec-run-section');
    if (runSection) runSection.style.display = 'none';
  });
}

// ---- 5. INSPECTOR ----
function setupInspector() {
  const startBtn = document.getElementById('inspect-start');
  const stopBtn  = document.getElementById('inspect-stop');
  const results  = document.getElementById('inspect-results');
  const hint     = document.getElementById('inspect-hint');

  startBtn?.addEventListener('click', () => {
    isInspecting = true;
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'START_INSPECT' } });
    startBtn.disabled = true; stopBtn.disabled = false;
    hint.textContent = '🔍 Click any element on the active page...';
    results.style.display = 'block';
  });

  stopBtn?.addEventListener('click', () => {
    isInspecting = false;
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'STOP_INSPECT' } });
    startBtn.disabled = false; stopBtn.disabled = true;
    hint.textContent = 'Start inspecting then click any element on the active page to see ranked locators.';
  });

  document.getElementById('best-locator')?.addEventListener('click', function() { copyText(this.textContent); });
}

function renderInspectorResults(elementInfo) {
  const { locators = [], tag, id, text, ariaLabel, role, type, html } = elementInfo;
  const best = locators[0];
  if (!best) return;

  document.getElementById('best-strategy').textContent = best.strategy;
  document.getElementById('best-locator').textContent = `page.${best.locator}`;
  document.getElementById('best-score-bar').style.width = `${best.score}%`;
  document.getElementById('best-score-label').textContent = `Score: ${best.score}/100 — ${best.score >= 90 ? 'Excellent' : best.score >= 70 ? 'Good' : best.score >= 50 ? 'Fair' : 'Poor'}`;

  const list = document.getElementById('locator-list');
  list.innerHTML = locators.map((l, i) => `
    <div class="locator-card" style="cursor:pointer" onclick="navigator.clipboard.writeText('page.${l.locator}').then(()=>{})">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="locator-strategy">${l.strategy}</span>
        <span style="font-size:10px;color:var(--text2)">${l.score}/100</span>
      </div>
      <div class="locator-code">page.${l.locator}</div>
      <div class="score-bar"><div class="score-fill" style="width:${l.score}%"></div></div>
    </div>`).join('');

  document.getElementById('element-info').textContent = [
    `Tag: ${tag || '—'}`, id ? `ID: ${id}` : null,
    text ? `Text: "${text.slice(0,80)}"` : null,
    ariaLabel ? `ARIA Label: ${ariaLabel}` : null,
    role ? `Role: ${role}` : null, type ? `Type: ${type}` : null
  ].filter(Boolean).join('\n');
}

// ---- 6. AI CHAT ----
function setupChat() {
  const input  = document.getElementById('chat-input');
  const sendBtn= document.getElementById('chat-send');
  const history= document.getElementById('chat-history');

  function addMessage(content, isUser) {
    const msg = document.createElement('div');
    msg.className = `msg ${isUser ? 'msg-user' : 'msg-ai'}`;
    const bubble = document.createElement('div');
    bubble.className = 'msg-bubble';
    bubble.textContent = content;
    msg.appendChild(bubble);
    history.appendChild(msg);
    history.scrollTop = history.scrollHeight;
    return bubble;
  }

  async function sendMessage() {
    const text = input?.value?.trim();
    if (!text) return;
    input.value = '';
    addMessage(text, true);

    const loadingBubble = addMessage('...', false);
    loadingBubble.innerHTML = '<div class="loader"><div class="spinner"></div>Thinking...</div>';

    try {
      const result = await orchestrator.dispatch('chat', { message: text });
      loadingBubble.textContent = result;
    } catch(e) {
      loadingBubble.textContent = `Error: ${e.message}`;
    }
    history.scrollTop = history.scrollHeight;
  }

  sendBtn?.addEventListener('click', sendMessage);
  input?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendMessage(); }
  });
  document.getElementById('chat-clear')?.addEventListener('click', () => {
    history.innerHTML = '<div class="msg msg-ai"><div class="msg-bubble">👋 Chat cleared. What can I help you with?</div></div>';
    orchestrator.getAgent('chat').clearConversation();
  });
}

// ---- 7. FRAMEWORK ----
function setupFramework() {
  const runBtn = document.getElementById('fw-run');
  const output = document.getElementById('fw-output');

  runBtn?.addEventListener('click', async () => {
    const action = document.getElementById('fw-action')?.value;
    const language = document.getElementById('fw-language')?.value;
    const code = document.getElementById('fw-code')?.value?.trim();
    if ((action === 'analyze' || action === 'improve') && !code) { showToast('Paste code first'); return; }
    const options = {
      bdd: document.getElementById('fw-bdd')?.checked,
      api: document.getElementById('fw-api')?.checked,
      visual: document.getElementById('fw-visual')?.checked,
      ci: document.getElementById('fw-ci')?.checked,
      docker: document.getElementById('fw-docker')?.checked,
      allure: document.getElementById('fw-allure')?.checked,
    };
    runBtn.disabled = true;
    showLoading(output, `Framework Agent running (${action})...`);
    try {
      const result = await orchestrator.dispatch('framework', { code, action, language, options });
      setOutput(output, result);
    } catch(e) { output.textContent = `Error: ${e.message}`; }
    finally { runBtn.disabled = false; }
  });

  document.getElementById('fw-copy')?.addEventListener('click', () => copyText(output.textContent));
  document.getElementById('fw-export')?.addEventListener('click', () => {
    if (output.textContent) orchestrator.getAgent('export').exportAsMarkdown(output.textContent, 'framework-output');
  });
  document.getElementById('fw-clear')?.addEventListener('click', () => {
    document.getElementById('fw-code').value = '';
    output.innerHTML = '<span class="output-placeholder">Framework output will appear here...</span>';
  });
}

// ---- 8. EXPORT/IMPORT ----
function setupExport() {
  document.getElementById('export-download')?.addEventListener('click', () => {
    const content = document.getElementById('export-content')?.value || lastOutput;
    if (!content) { showToast('Nothing to export'); return; }
    const format = document.getElementById('export-format')?.value || 'markdown';
    const filename = document.getElementById('export-filename')?.value || 'playwright-export';
    orchestrator.dispatch('export', { content, format, filename });
    showToast(`Downloaded ${filename}`);
  });

  document.getElementById('export-clipboard')?.addEventListener('click', async () => {
    const content = document.getElementById('export-content')?.value || lastOutput;
    if (content) { await navigator.clipboard.writeText(content); showToast('Copied to clipboard!'); }
    else showToast('Nothing to copy');
  });
}

// ---- 9. BROWSER SESSION ----
function setupSession() {
  const startBtn = document.getElementById('sess-start');
  const stopBtn  = document.getElementById('sess-stop');
  const dot      = document.getElementById('sess-dot');
  const statusTxt= document.getElementById('sess-status-text');
  const output   = document.getElementById('sess-output');

  startBtn?.addEventListener('click', async () => {
    isSessionCapturing = true; sessionStartTime = Date.now();
    sessionActionCount = 0; sessionRequestCount = 0;
    dot.className = 'rec-dot recording';
    statusTxt.textContent = 'Capturing session...';
    startBtn.disabled = true; stopBtn.disabled = false;
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'START_RECORDING' } });
    sessionInterval = setInterval(() => {
      const elapsed = Math.floor((Date.now() - sessionStartTime) / 1000);
      document.getElementById('sess-duration').textContent = elapsed + 's';
    }, 1000);
  });

  stopBtn?.addEventListener('click', () => {
    isSessionCapturing = false;
    clearInterval(sessionInterval);
    chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: { type: 'STOP_RECORDING' } }, (resp) => {
      if (resp?.actions) { sessionActionCount = resp.actions.length; }
      document.getElementById('sess-actions').textContent = sessionActionCount;
    });
    dot.className = 'rec-dot';
    statusTxt.textContent = `Captured ${sessionActionCount} actions`;
    startBtn.disabled = false; stopBtn.disabled = true;
  });

  document.getElementById('sess-generate')?.addEventListener('click', async () => {
    showLoading(output, 'Browser Session Agent generating test...');
    try {
      const result = await orchestrator.dispatch('session', { sessionData: { url: 'active page', duration: sessionActionCount }, actions: [] });
      setOutput(output, result);
    } catch(e) { output.textContent = `Error: ${e.message}`; }
  });

  document.getElementById('sess-copy')?.addEventListener('click', () => copyText(output.textContent));
}

// ---- 10. ORCHESTRATOR ----
function setupOrchestrator() {
  const runBtn = document.getElementById('orch-run');
  const output = document.getElementById('orch-output');

  runBtn?.addEventListener('click', async () => {
    const requirement = document.getElementById('orch-input')?.value?.trim();
    if (!requirement) { showToast('Enter requirements first'); return; }
    const language = document.getElementById('orch-language')?.value || 'typescript';

    runBtn.disabled = true;
    const log = document.getElementById('orch-log');
    log.innerHTML = '';
    output.innerHTML = '<span class="output-placeholder">Pipeline running...</span>';

    setStepStatus('step-planner-status', 'running', '⏳ Running');
    setStepStatus('step-generator-status', '', 'Waiting');
    setStepStatus('step-export-status', '', 'Waiting');

    appendOrcLog('🚀 Pipeline started');
    try {
      appendOrcLog('📋 Test Planner analyzing requirements...');
      const plan = await orchestrator.dispatch('planner', { text: requirement, inputType: 'feature description' });
      setStepStatus('step-planner-status', 'done', '✅ Done');
      appendOrcLog('✅ Test plan generated');

      setStepStatus('step-generator-status', 'running', '⏳ Running');
      appendOrcLog('⚡ Test Generator creating code...');
      const code = await orchestrator.dispatch('generator', { testPlan: plan, language, framework: 'pom' });
      setStepStatus('step-generator-status', 'done', '✅ Done');
      appendOrcLog('✅ Playwright tests generated');

      setStepStatus('step-export-status', 'done', '✅ Ready');
      appendOrcLog('✅ Pipeline complete!');

      setOutput(output, `## TEST PLAN\n\n${plan}\n\n---\n\n## GENERATED CODE\n\n${code}`);
    } catch(e) {
      appendOrcLog(`❌ Error: ${e.message}`);
      output.textContent = `Error: ${e.message}`;
      setStepStatus('step-planner-status', 'error', '❌ Error');
    } finally { runBtn.disabled = false; }
  });

  document.getElementById('orch-copy')?.addEventListener('click', () => copyText(output.textContent));
  document.getElementById('orch-clear')?.addEventListener('click', () => {
    document.getElementById('orch-input').value = '';
    document.getElementById('orch-log').innerHTML = '<span style="color:var(--text3)">Pipeline log...</span>';
    output.innerHTML = '<span class="output-placeholder">Run the pipeline to see results...</span>';
    ['step-planner-status','step-generator-status','step-export-status'].forEach(id => setStepStatus(id, '', 'Waiting'));
  });
}

// ---- 11. SETTINGS ----
function setupSettings() {
  document.querySelectorAll('.provider-card').forEach(card => {
    card.addEventListener('click', () => {
      const provider = card.getAttribute('data-provider');
      document.querySelectorAll('.provider-card').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
      const apiSection = document.getElementById('api-key-section');
      if (apiSection) apiSection.style.display = (provider !== 'mock' && provider !== 'bridge') ? 'block' : 'none';
    });
  });

  document.getElementById('settings-save')?.addEventListener('click', async () => {
    const provider = document.querySelector('.provider-card.selected')?.getAttribute('data-provider') || 'mock';
    const apiKey = document.getElementById('settings-apikey')?.value?.trim() || '';
    const model = document.getElementById('settings-model')?.value?.trim() || '';
    await Storage.saveSettings({ provider, apiKey, model });
    updateProvider(provider, apiKey, model);
    const status = document.getElementById('settings-status');
    if (status) { status.textContent = '✅ Settings saved'; setTimeout(() => { status.textContent = ''; }, 2000); }
  });

  document.getElementById('settings-test')?.addEventListener('click', async () => {
    const status = document.getElementById('settings-status');
    if (status) status.textContent = '🔄 Testing connection...';
    try {
      await orchestrator.dispatch('chat', { message: 'Say "Connection OK" and nothing else.' });
      if (status) { status.textContent = '✅ Connection successful!'; setTimeout(() => { status.textContent = ''; }, 3000); }
    } catch(e) {
      if (status) status.textContent = `❌ ${e.message}`;
    }
  });
}

// ---- Content Script Message Listener ----
function listenForContentMessages() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'ELEMENT_INSPECTED') {
      renderInspectorResults(message.elementInfo);
    }
    if (message.type === 'RECORDING_ACTION') {
      recorderActions.push(message.action);
      const countTxt = document.getElementById('rec-count');
      if (countTxt) countTxt.textContent = `${recorderActions.length} actions`;
    }
  });
}

// ---- Start ----
init().catch(console.error);
