import { Orchestrator } from './agents/orchestrator.js';
import { MockProvider } from './providers/mock-provider.js';
import { ClaudeProvider } from './providers/claude-provider.js';
import { OpenAIProvider } from './providers/openai-provider.js';
import { GeminiProvider } from './providers/gemini-provider.js';
import { BridgeProvider } from './providers/bridge-provider.js';
import { BridgeClient } from './utils/bridge-client.js';
import { Storage } from './utils/storage.js';
import { PlatformClient } from './utils/platform-client.js';
import {
  countsText, deleteControls, durationText, isFinal, reportLinks, resultRows, runControls, runLinks, runSummary, statusView,
} from './utils/execution-view.js';
import { extractCode, looksLikeCode, pickFixedCode, sectionAfter, toSingleFile } from './utils/code-extract.js';
import { diffStats, lineDiff } from './utils/line-diff.js';
import { withSkills } from './utils/skill-context.js';
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
  setupProjectsPanel();
  setupJenkinsSettings();
  setupPlatform();
  setupSaveToProject();
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

// The skill versions that went into the latest agent request: [{ id, version }].
let skillsUsed = [];

// Skills unticked in the pick lists of the Planner, Generator, and Healer: left out of requests.
const skillsExcluded = new Set();

// The skills of the project chosen under Projects → Skills, or null when none is chosen or
// the panel is not signed in to the platform.
async function fetchSkillContext() {
  const chosen = await Storage.getSkillsProject();
  if (!chosen) return null;
  const platform = await Storage.getPlatform();
  if (!platform.url || !platform.token) return null;
  return PlatformClient.getSkillContext(chosen.id);
}

// What the agents are given: those skills, less the ones unticked for this generation.
async function loadSkillContext() {
  const context = await fetchSkillContext();
  return context ? { ...context, skills: context.skills.filter((skill) => !skillsExcluded.has(skill.id)) } : null;
}

// Above the input of each of the three agents: the project's skills, each with a tick, so a
// generation can leave some out. Built with DOM methods; names come from the server.
async function renderSkillPicks() {
  let context = null;
  try {
    context = await fetchSkillContext();
  } catch {
    // No list is shown; a generation then runs without skills, as loadSkillContext decides.
  }
  for (const anchorId of ['planner-input', 'gen-input', 'healer-error']) {
    const anchor = document.getElementById(anchorId)?.closest('.form-group');
    if (!anchor) continue;
    let box = anchor.previousElementSibling;
    if (!box?.classList.contains('skills-pick')) {
      box = document.createElement('div');
      box.className = 'skills-pick';
      anchor.before(box);
    }
    box.replaceChildren();
    box.style.display = context && context.skills.length > 0 ? '' : 'none';
    if (!context || context.skills.length === 0) continue;
    const title = document.createElement('span');
    title.className = 'skills-pick-title';
    title.textContent = `🧠 Skills from ${context.project}`;
    box.append(title, ...context.skills.map((skill) => {
      const label = document.createElement('label');
      const tick = document.createElement('input');
      tick.type = 'checkbox';
      tick.checked = !skillsExcluded.has(skill.id);
      tick.dataset.skillId = String(skill.id);
      tick.addEventListener('change', () => {
        if (tick.checked) skillsExcluded.delete(skill.id);
        else skillsExcluded.add(skill.id);
        // The same skill in the other two panels follows.
        document.querySelectorAll(`.skills-pick input[data-skill-id="${skill.id}"]`).forEach((other) => { other.checked = tick.checked; });
      });
      const name = document.createElement('span');
      name.textContent = `${skill.name} v${skill.version}`;
      label.append(tick, name);
      return label;
    }));
  }
}
document.addEventListener('skills-project', renderSkillPicks);
document.addEventListener('platform-auth', renderSkillPicks);
document.querySelectorAll('.nav-btn[data-panel]').forEach((btn) => {
  if (['planner', 'generator', 'healer'].includes(btn.getAttribute('data-panel'))) btn.addEventListener('click', renderSkillPicks);
});

// Shows in the top bar which project's skills the agents are using.
async function showSkillsIndicator() {
  const el = document.getElementById('skills-indicator');
  if (!el) return;
  const chosen = await Storage.getSkillsProject();
  el.textContent = chosen ? `🧠 Skills: ${chosen.name}` : '';
  el.style.display = chosen ? '' : 'none';
}
document.addEventListener('skills-project', showSkillsIndicator);
showSkillsIndicator();

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
  // Every agent request carries the chosen project's skills, and Save to Project records which.
  orchestrator.setProvider(withSkills(provider, loadSkillContext, (refs) => { skillsUsed = refs; }));

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
// The Healer's latest answer as the model wrote it, fences included.
let healerAnswer = '';

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
      healerAnswer = typeof result === 'string' ? result : String(result ?? '');
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

  // ---- Saving a fix back to the platform script it came from ----
  // Set by "Send to Healer" on a failed Jenkins run: { project, scriptId, name, version, content, runId }.
  let healTarget = null;
  const $h = (id) => document.getElementById(id);
  const applyBox = $h('healer-apply');
  const applyTarget = $h('healer-apply-target');
  const fixBox = $h('healer-fix-box');
  const fixed = $h('healer-fixed');
  const diffEl = $h('healer-diff');
  const applyStatus = $h('healer-apply-status');
  const applyReady = applyBox && applyTarget && fixBox && fixed && diffEl && applyStatus;

  function resetApply() {
    if (!applyReady) return;
    applyBox.style.display = healTarget ? '' : 'none';
    fixBox.style.display = 'none';
    diffEl.replaceChildren();
    applyStatus.textContent = '';
    if (healTarget) applyTarget.textContent = `This fix is for "${healTarget.name}" v${healTarget.version} in ${healTarget.project.name}.`;
  }

  // Shows, line by line, what saving would change in the stored script. Returns the number of changed lines.
  function showChanges() {
    const diff = lineDiff(healTarget.content, fixed.value);
    const { added, removed } = diffStats(diff);
    diffEl.replaceChildren(...diff.map((line) => {
      const row = document.createElement('div');
      row.className = `diff-line diff-${line.type}`;
      row.textContent = `${line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '} ${line.text}`;
      return row;
    }));
    applyStatus.textContent = added + removed === 0
      ? 'No difference from the stored script yet.'
      : `${added} line(s) added, ${removed} removed. Nothing is saved until you accept.`;
    return added + removed;
  }

  async function accept(run) {
    if (!healTarget) return;
    if (showChanges() === 0) return;
    if (!looksLikeCode(fixed.value)) { applyStatus.textContent = '❌ The fixed script is empty.'; return; }
    const target = healTarget;
    applyStatus.textContent = 'Saving…';
    try {
      const patch = {
        content: fixed.value,
        baseVersion: target.version,
        changeSummary: `Healed after Jenkins run #${target.runId}`,
        healed: true,
      };
      // The skills the Healer was given are recorded with the new version.
      if (skillsUsed.length > 0) patch.skills = skillsUsed;
      const script = await PlatformClient.updateScript(target.scriptId, patch);
      healTarget = null;
      resetApply();
      showToast(`Saved "${script.name}" as v${script.version}`);
      document.dispatchEvent(new CustomEvent('platform-script-saved', {
        detail: { project: target.project, scriptId: script.id, run },
      }));
    } catch (err) {
      applyStatus.textContent = err.code === 'VERSION_CONFLICT'
        ? '❌ The script was changed after this run. Open it under Projects, run it, and heal that run.'
        : `❌ ${err.message}`;
    }
  }

  if (applyReady) {
    document.addEventListener('heal-target', (event) => {
      healTarget = event.detail;
      healerAnswer = '';
      resetApply();
    });
    $h('healer-review')?.addEventListener('click', () => {
      if (!healTarget) return;
      // The Healer's answer is a report; the complete fixed file in it is offered for saving.
      // Without one, the stored script is put in the box to be edited by hand.
      const code = toSingleFile(pickFixedCode(healerAnswer));
      fixed.value = code ? (code.endsWith('\n') ? code : `${code}\n`) : healTarget.content;
      fixBox.style.display = '';
      showChanges();
      if (!code) applyStatus.textContent = healerAnswer
        ? 'The Healer\'s answer holds no complete test file. Edit the script here, following its advice.'
        : 'Press Heal Test first, or edit the script here by hand.';
    });
    $h('healer-compare')?.addEventListener('click', () => { if (healTarget) showChanges(); });
    $h('healer-accept')?.addEventListener('click', () => accept(false));
    $h('healer-accept-run')?.addEventListener('click', () => accept(true));
  }

  document.getElementById('healer-clear')?.addEventListener('click', () => {
    healTarget = null;
    healerAnswer = '';
    resetApply();
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

// Settings → Platform: optional sign-in to the Playwright Platform backend.
// Everything else in the extension works unchanged when this is left empty.
function setupPlatform() {
  const urlInput = document.getElementById('platform-url');
  const emailInput = document.getElementById('platform-email');
  const passwordInput = document.getElementById('platform-password');
  const fields = document.getElementById('platform-signin-fields');
  const signInBtn = document.getElementById('platform-signin');
  const signOutBtn = document.getElementById('platform-signout');
  const status = document.getElementById('platform-status');
  if (!urlInput || !signInBtn || !signOutBtn || !status) return;

  const render = (user, message) => {
    fields.style.display = user ? 'none' : '';
    signInBtn.style.display = user ? 'none' : '';
    signOutBtn.style.display = user ? '' : 'none';
    urlInput.disabled = Boolean(user);
    // textContent only: the values come from a server and must never be parsed as HTML.
    status.textContent = message || (user ? `✅ Signed in as ${user.email} (${user.role})` : 'Not signed in');
    // The Projects tab and the Jenkins block follow the sign-in state.
    document.dispatchEvent(new CustomEvent('platform-auth', { detail: { user: user || null } }));
  };

  (async () => {
    const platform = await Storage.getPlatform();
    urlInput.value = platform.url || '';
    render(platform.user);
    if (!platform.token) return;
    try {
      const user = await PlatformClient.me();
      render(user, user ? '' : 'Session expired — sign in again');
    } catch (err) {
      render(platform.user, `⚠️ ${err.message}`);
    }
  })();

  signInBtn.addEventListener('click', async () => {
    signInBtn.disabled = true;
    status.textContent = 'Signing in…';
    try {
      const user = await PlatformClient.login(urlInput.value, emailInput.value.trim(), passwordInput.value);
      passwordInput.value = '';
      render(user);
      showToast('Signed in to platform');
    } catch (err) {
      render(null, `❌ ${err.message}`);
    } finally {
      signInBtn.disabled = false;
    }
  });

  signOutBtn.addEventListener('click', async () => {
    signOutBtn.disabled = true;
    try {
      await PlatformClient.logout();
      render(null);
    } catch (err) {
      // The token is dropped by logout() even when the server cannot be reached; say what happened.
      render(null, `⚠️ Signed out here. ${err.message}`);
    } finally {
      signOutBtn.disabled = false;
    }
  });
}

// "Save to Project": sends the code shown in a panel to the Playwright Platform as a new script.
// It needs the Settings → Platform sign-in; without one the buttons only say so, and every
// other feature of the extension works as before.
function setupSaveToProject() {
  const overlay = document.getElementById('save-project-overlay');
  const projectSelect = document.getElementById('save-project-select');
  const nameInput = document.getElementById('save-project-name');
  const descriptionInput = document.getElementById('save-project-description');
  const status = document.getElementById('save-project-status');
  const confirmBtn = document.getElementById('save-project-confirm');
  const cancelBtn = document.getElementById('save-project-cancel');
  if (!overlay || !projectSelect || !nameInput || !descriptionInput || !status || !confirmBtn || !cancelBtn) return;

  const LANGUAGES = { typescript: 'TypeScript', javascript: 'JavaScript' };
  const EXPIRED = 'Platform session expired — sign in again under Settings → Platform.';
  let pending = null;      // { content, source, language } while the dialog is open
  let lastProjectId = '';  // offered again for the next save in this session

  // A panel shows a placeholder or a spinner until it has output; neither is code.
  const outputText = (el) => (el && !el.querySelector('.output-placeholder, .loader') ? el.textContent || '' : '');

  const close = () => {
    overlay.style.display = 'none';
    pending = null;
  };

  async function open({ read, emptyMessage, languageSelectId, source, suggestName }) {
    const text = read();
    if (!looksLikeCode(text)) { showToast(emptyMessage); return; }
    const language = LANGUAGES[document.getElementById(languageSelectId)?.value || 'typescript'];
    if (!language) { showToast('Save to Project supports TypeScript and JavaScript only'); return; }

    const platform = await Storage.getPlatform();
    if (!platform.url || !platform.token) { showToast('Sign in under Settings → Platform first.'); return; }

    let projects;
    try {
      projects = await PlatformClient.listProjects();
    } catch (err) {
      showToast(err.status === 401 ? EXPIRED : err.message);
      return;
    }
    if (projects.length === 0) { showToast('No projects yet — create one in the platform first.'); return; }

    // Built with DOM methods: project names come from the server and must never be parsed as HTML.
    projectSelect.replaceChildren(...projects.map((project) => {
      const option = document.createElement('option');
      option.value = String(project.id);
      option.textContent = project.name;
      return option;
    }));
    if (projects.some((project) => String(project.id) === lastProjectId)) projectSelect.value = lastProjectId;

    // Generated code is several files in one text; a stored script is one file that must run as it is.
    const code = extractCode(text);
    pending = {
      content: source === 'GENERATED' ? toSingleFile(code) : code,
      source,
      language,
      // Generated code is stored with the skill versions the agents were given.
      skills: source === 'GENERATED' ? skillsUsed : [],
    };
    nameInput.value = suggestName();
    descriptionInput.value = '';
    status.textContent = '';
    overlay.style.display = 'flex';
    nameInput.focus();
    nameInput.select();
  }

  document.getElementById('gen-save-project')?.addEventListener('click', () => open({
    read: () => outputText(document.getElementById('gen-output')),
    emptyMessage: 'Generate code first',
    languageSelectId: 'gen-language',
    source: 'GENERATED',
    suggestName: () => 'Generated Test',
  }));

  document.getElementById('rec-save-project')?.addEventListener('click', () => open({
    // While the Recorder's editor is open, the code lives in its textarea, not in the output element.
    read: () => document.getElementById('rec-edit-area')?.value ?? outputText(document.getElementById('rec-output')),
    emptyMessage: 'Record some actions first',
    languageSelectId: 'rec-language',
    source: 'RECORDED',
    suggestName: () => document.getElementById('rec-test-name')?.value?.trim() || 'Recorded Test',
  }));

  document.getElementById('orch-save-project')?.addEventListener('click', () => open({
    // The Orchestrator shows the test plan first; only the part after this heading is code.
    read: () => sectionAfter(outputText(document.getElementById('orch-output')), '## GENERATED CODE'),
    emptyMessage: 'Run the pipeline first',
    languageSelectId: 'orch-language',
    source: 'GENERATED',
    suggestName: () => 'Generated Test',
  }));

  const runAfterBtn = document.getElementById('save-project-run');

  // Saves the script. With `run`, the Projects tab then opens it and starts it on Jenkins.
  async function save(run) {
    if (!pending) return;
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = 'Enter a script name.';
      nameInput.focus();
      return;
    }
    confirmBtn.disabled = true;
    if (runAfterBtn) runAfterBtn.disabled = true;
    status.textContent = 'Saving…';
    try {
      const projectId = Number(projectSelect.value);
      const projectName = projectSelect.selectedOptions[0]?.textContent || '';
      const script = await PlatformClient.saveScript(projectId, {
        name,
        description: descriptionInput.value.trim(),
        content: pending.content,
        source: pending.source,
        language: pending.language,
        skills: pending.skills,
      });
      lastProjectId = projectSelect.value;
      close();
      showToast(run ? `Saved "${script.name}" — starting it on Jenkins` : `Saved "${script.name}". Run it from the Projects tab.`);
      document.dispatchEvent(new CustomEvent('platform-script-saved', {
        detail: { project: { id: projectId, name: projectName }, scriptId: script.id, run },
      }));
    } catch (err) {
      // textContent only: the message comes from the server. The dialog stays open so the
      // name can be changed and the save tried again.
      status.textContent = `❌ ${err.status === 401 ? EXPIRED : err.message}`;
    } finally {
      confirmBtn.disabled = false;
      if (runAfterBtn) runAfterBtn.disabled = false;
    }
  }

  confirmBtn.addEventListener('click', () => save(false));
  runAfterBtn?.addEventListener('click', () => save(true));

  cancelBtn.addEventListener('click', close);
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && overlay.style.display !== 'none') close();
  });
}

// Projects tab: browse the platform's projects and scripts, and run a stored script on Jenkins.
// Every value shown here came from the server, so it is written with textContent and built
// with DOM methods, never parsed as HTML.
function setupProjectsPanel() {
  const $ = (id) => document.getElementById(id);
  const message = $('projects-message');
  const views = {
    list: $('projects-view-list'),
    scripts: $('projects-view-scripts'),
    script: $('projects-view-script'),
    skills: $('projects-view-skills'),
    skill: $('projects-view-skill'),
  };
  const projectList = $('projects-list');
  const projectName = $('scripts-project-name');
  const searchInput = $('scripts-search');
  const scriptList = $('scripts-list');
  const scriptName = $('script-name');
  const scriptMeta = $('script-meta');
  const scriptCode = $('script-code');
  const runBtn = $('script-run');
  const stopBtn = $('script-stop');
  const runNote = $('script-run-note');
  const card = $('run-card');
  const runStatus = $('run-status');
  const runTitle = $('run-title');
  const runCounts = $('run-counts');
  const runTimes = $('run-times');
  const runError = $('run-error');
  const runLinksEl = $('run-links');
  const runHistory = $('run-history');
  const runResults = $('run-results');
  const deleteBtn = $('script-delete');
  const deleteConfirm = $('script-delete-confirm');
  const deleteYes = $('script-delete-yes');
  const deleteNo = $('script-delete-no');
  const healBtn = $('run-heal');
  const required = [
    message, views.list, views.scripts, views.script, projectList, projectName, searchInput, scriptList,
    scriptName, scriptMeta, scriptCode, runBtn, stopBtn, runNote, card, runStatus, runTitle, runCounts,
    runTimes, runError, runLinksEl, runHistory, runResults, deleteBtn, deleteConfirm, deleteYes, deleteNo,
  ];
  if (required.some((el) => !el)) return;

  const POLL_MS = 3000;
  const SEARCH_DELAY_MS = 300;
  const EXPIRED = 'Platform session expired — sign in again under Settings → Platform.';

  const state = {
    user: null,       // the signed-in platform user
    jenkins: null,    // the Jenkins settings as the server reports them
    project: null,    // the open project
    script: null,     // the open script, with its content
    execution: null,  // the run shown in the status card
    runs: [],         // the open script's recent runs
    resultsFor: null, // id of the run whose tests are listed in the card
    results: [],      // those tests, as rows
    shotUrls: [],     // object URLs of the screenshots shown, to be released
    turn: 0,          // goes up on every navigation, so an answer that arrives late is dropped
    pollTimer: null,
    pollSeq: 0,       // goes up whenever the watch is restarted or stopped
    searchTimer: null,
  };

  const show = (el, visible) => { el.style.display = visible ? '' : 'none'; };
  const say = (text) => { message.textContent = text; show(message, Boolean(text)); };
  const fail = (err) => say(err.status === 401 ? EXPIRED : `❌ ${err.message}`);
  const showView = (name) => {
    for (const [key, el] of Object.entries(views)) show(el, key === name);
  };
  const scriptDetail = (script) =>
    [`v${script.version}`, script.language, ...script.tags.map((tag) => `#${tag}`)].join(' · ');

  // One row of a list: a title and a line of detail.
  function item(title, detail, onOpen) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'item';
    const top = document.createElement('span');
    top.className = 'item-title';
    top.textContent = title;
    const bottom = document.createElement('span');
    bottom.className = 'item-sub';
    bottom.textContent = detail;
    row.append(top, bottom);
    row.addEventListener('click', onOpen);
    return row;
  }

  function emptyLine(text) {
    const line = document.createElement('div');
    line.className = 'item-empty';
    line.textContent = text;
    return line;
  }

  function stopPolling() {
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    // A request already on its way cannot be cancelled; its answer is dropped instead.
    state.pollSeq += 1;
  }

  // Asks again in 3 seconds while the shown run is unfinished. A chain of timeouts, not an
  // interval, so a slow answer never overlaps the next request.
  function keepWatching() {
    stopPolling();
    const watched = state.execution;
    if (!watched || isFinal(watched.status)) return;
    const turn = state.turn;
    const seq = state.pollSeq;
    state.pollTimer = setTimeout(async () => {
      try {
        const fresh = await PlatformClient.getExecution(watched.id);
        // Stop or Run answered meanwhile and started a newer watch with newer state.
        if (seq !== state.pollSeq) return;
        if (turn !== state.turn || state.execution?.id !== watched.id) return;
        say('');
        renderRun(fresh);
      } catch (err) {
        if (seq !== state.pollSeq || turn !== state.turn) return;
        if (err.status === 401) { fail(err); return; }
        // One failed poll does not end the watch: the last known state stays on screen.
        say(`⚠️ ${err.message}`);
      }
      keepWatching();
    }, POLL_MS);
  }

  function renderControls() {
    const controls = runControls({
      role: state.user?.role,
      projectStatus: state.script?.projectStatus,
      jenkinsConfigured: Boolean(state.jenkins?.configured),
      execution: state.execution,
    });
    show(runBtn, controls.showRun);
    runBtn.disabled = controls.runDisabled;
    show(stopBtn, controls.showStop);
    runNote.textContent = controls.note;
    show(runNote, Boolean(controls.note));

    const removal = deleteControls({
      role: state.user?.role,
      projectStatus: state.script?.projectStatus,
      execution: state.execution,
    });
    show(deleteBtn, removal.showDelete);
    deleteBtn.disabled = removal.deleteDisabled;
    if (!removal.showDelete || removal.deleteDisabled) show(deleteConfirm, false);
  }

  // Lists the tests of a finished run in the card: the report, inside the panel. Built with
  // DOM methods and textContent only, because test names and errors come from the server.
  async function showResults(execution) {
    // The Healer is offered for a run that did not pass, once it has ended.
    if (healBtn) show(healBtn, Boolean(execution) && (execution.status === 'FAILED' || execution.status === 'ERROR'));
    if (!execution || !isFinal(execution.status)) {
      state.resultsFor = null;
      state.results = [];
      runResults.replaceChildren();
      return;
    }
    if (state.resultsFor === execution.id) return;
    state.resultsFor = execution.id;
    state.results = [];
    runResults.replaceChildren();
    const turn = state.turn;
    let rows;
    try {
      rows = resultRows(await PlatformClient.listExecutionResults(execution.id), state.jenkins?.baseUrl || '');
    } catch {
      // The card still shows the counts; the list is tried again the next time the run is drawn.
      if (state.resultsFor === execution.id) state.resultsFor = null;
      return;
    }
    if (turn !== state.turn || state.execution?.id !== execution.id) return;
    state.results = rows;
    for (const url of state.shotUrls) URL.revokeObjectURL(url);
    state.shotUrls = [];
    runResults.replaceChildren(...rows.map((result, index) => {
      const row = document.createElement('div');
      row.className = 'result-row';
      const badge = document.createElement('span');
      badge.className = result.className;
      badge.textContent = result.label;
      const name = document.createElement('span');
      name.className = 'result-name';
      name.textContent = result.name;
      const time = document.createElement('span');
      time.className = 'result-time';
      time.textContent = result.duration;
      row.append(badge, name, time);
      if (result.error) {
        const error = document.createElement('div');
        error.className = 'run-error';
        error.textContent = result.error;
        row.append(error);
      }
      // What the build kept for a failed test: opened from Jenkins in a new tab.
      if (result.links.length > 0) {
        const files = document.createElement('div');
        files.className = 'btn-row result-files';
        files.append(...result.links.map(({ label, href }) => {
          const link = document.createElement('a');
          link.className = 'btn btn-icon';
          link.textContent = label;
          link.href = href;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          return link;
        }));
        row.append(files);
      }
      // The screenshot itself, read through the platform so no Jenkins sign-in is needed.
      if (result.links.some((link) => link.label === 'Screenshot')) {
        PlatformClient.getScreenshot(execution.id, index).then((blob) => {
          if (state.resultsFor !== execution.id) return;
          const url = URL.createObjectURL(blob);
          state.shotUrls.push(url);
          const shot = document.createElement('img');
          shot.className = 'result-shot';
          shot.alt = `Screenshot of the failed test ${result.name}`;
          shot.src = url;
          shot.addEventListener('click', () => window.open(url, '_blank', 'noopener'));
          row.append(shot);
        }).catch(() => {
          // The Screenshot link above still opens it from Jenkins.
        });
      }
      return row;
    }));
  }

  function renderRuns() {
    if (state.runs.length === 0) {
      runHistory.replaceChildren(emptyLine('No runs yet.'));
      return;
    }
    runHistory.replaceChildren(...state.runs.map((execution) => {
      const row = item(runSummary(execution), new Date(execution.createdAt).toLocaleString(), () => selectRun(execution.id));
      if (state.execution?.id === execution.id) row.classList.add('selected');
      return row;
    }));
  }

  // Shows a run in the status card, or hides the card when there is none.
  function renderRun(execution) {
    state.execution = execution;
    show(card, Boolean(execution));
    if (execution) {
      // The list shows the same run, so it must not lag behind the card.
      state.runs = state.runs.map((run) => (run.id === execution.id ? execution : run));
      const status = statusView(execution.status);
      runStatus.className = status.className;
      runStatus.textContent = status.label;
      const build = execution.buildNumber ? ` · build ${execution.buildNumber}` : '';
      runTitle.textContent = `Run #${execution.id} · v${execution.scriptVersion}${build}`;
      runCounts.textContent = countsText(execution);
      const duration = durationText(execution.durationMs);
      runTimes.textContent = [
        execution.triggeredBy ? `Started by ${execution.triggeredBy}` : '',
        duration ? `Took ${duration}` : '',
      ].filter(Boolean).join(' · ');
      runError.textContent = execution.errorMessage || '';
      drawLinks(execution);
    }
    renderControls();
    renderRuns();
    showResults(execution);
    loadReports(execution);
  }

  // The links of the status card: the Jenkins build, and the run's reports once they are known.
  function drawLinks(execution) {
    const reports = state.reportsFor === execution.id ? state.reportLinks : [];
    const links = [...runLinks(execution, state.jenkins?.baseUrl || ''), ...reports];
    runLinksEl.replaceChildren(...links.map(({ label, href }) => {
      const link = document.createElement('a');
      link.className = 'btn btn-secondary btn-sm';
      link.textContent = label;
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      return link;
    }));
  }

  // Asks the platform where a finished run's reports open. A link works for an hour, so the
  // answer is kept for half of that.
  async function loadReports(execution) {
    if (!execution || !isFinal(execution.status) || !execution.buildNumber) return;
    if (state.reportsFor === execution.id && Date.now() - state.reportsAt < 30 * 60_000) return;
    state.reportsFor = execution.id;
    state.reportsAt = Date.now();
    state.reportLinks = [];
    try {
      const { reports, platformUrl } = await PlatformClient.getReportLinks(execution.id);
      if (state.reportsFor !== execution.id) return;
      state.reportLinks = reportLinks(reports, platformUrl);
    } catch {
      // The card still shows the run; the reports are asked for again the next time it is drawn.
      if (state.reportsFor === execution.id) state.reportsFor = null;
      return;
    }
    if (state.execution?.id === execution.id) drawLinks(execution);
  }

  async function loadRuns() {
    if (!state.script) return;
    const turn = state.turn;
    try {
      const runs = await PlatformClient.listExecutions(state.script.id, 10);
      if (turn !== state.turn) return;
      state.runs = runs;
      renderRuns();
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  // Shows one run in the card. Reading it makes the server bring it up to date with Jenkins.
  async function selectRun(id) {
    const turn = state.turn;
    try {
      const execution = await PlatformClient.getExecution(id);
      if (turn !== state.turn) return;
      renderRun(execution);
      keepWatching();
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  async function openList() {
    const turn = ++state.turn;
    stopPolling();
    state.project = null;
    state.script = null;
    state.execution = null;
    if (!state.user) {
      showView(null);
      say('Sign in under Settings → Platform to see your projects.');
      return;
    }
    showView('list');
    say('Loading…');
    try {
      const projects = await PlatformClient.listProjects();
      if (turn !== state.turn) return;
      say(projects.length === 0 ? 'No projects yet. An administrator creates them in the platform web app.' : '');
      projectList.replaceChildren(...projects.map((project) => item(
        project.name,
        `${project.scriptCount} ${project.scriptCount === 1 ? 'script' : 'scripts'}`,
        () => openProject(project),
      )));
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  function openProject(project) {
    state.project = project;
    projectName.textContent = project.name;
    searchInput.value = '';
    loadScripts();
  }

  async function loadScripts() {
    if (!state.project) return;
    const turn = ++state.turn;
    stopPolling();
    state.script = null;
    state.execution = null;
    showView('scripts');
    say('Loading…');
    const search = searchInput.value;
    try {
      const scripts = await PlatformClient.listScripts(state.project.id, search);
      if (turn !== state.turn) return;
      const none = search.trim()
        ? 'No scripts match the search.'
        : 'This project has no scripts yet. Save one from the Generator or Recorder.';
      say(scripts.length === 0 ? none : '');
      scriptList.replaceChildren(...scripts.map((script) => item(script.name, scriptDetail(script), () => openScript(script.id))));
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  async function openScript(scriptId) {
    const turn = ++state.turn;
    stopPolling();
    clearTimeout(state.searchTimer);
    state.script = null;
    state.execution = null;
    state.runs = [];
    show(deleteConfirm, false);
    showView(null);
    say('Loading…');
    try {
      const [script, jenkins, runs] = await Promise.all([
        PlatformClient.getScript(scriptId),
        PlatformClient.getJenkinsSettings(),
        PlatformClient.listExecutions(scriptId, 10),
      ]);
      if (turn !== state.turn) return;
      state.script = script;
      state.jenkins = jenkins;
      state.runs = runs;
      scriptName.textContent = script.name;
      scriptMeta.textContent = scriptDetail(script);
      scriptCode.textContent = script.content;
      say('');
      showView('script');
      renderRun(null);
      // A run that is still going is shown again, so closing the panel never loses it.
      const unfinished = runs.find((execution) => !isFinal(execution.status));
      if (unfinished) await selectRun(unfinished.id);
    } catch (err) {
      if (turn !== state.turn) return;
      showView('scripts');
      fail(err);
    }
  }

  runBtn.addEventListener('click', async () => {
    if (!state.script) return;
    const turn = state.turn;
    runBtn.disabled = true;
    say('Starting the run…');
    try {
      const execution = await PlatformClient.runScript(state.script.id);
      if (turn !== state.turn) return;
      say('');
      state.runs = [execution, ...state.runs].slice(0, 10);
      renderRun(execution);
      keepWatching();
    } catch (err) {
      if (turn !== state.turn) return;
      fail(err);
      // A start that failed is kept in history, and a refusal may name the run in progress.
      await loadRuns();
      if (turn !== state.turn) return;
      const inProgress = err.code === 'RUN_IN_PROGRESS' ? err.details?.executionId : null;
      if (Number.isInteger(inProgress)) await selectRun(inProgress);
      else renderControls();
    }
  });

  stopBtn.addEventListener('click', async () => {
    const watched = state.execution;
    if (!watched) return;
    const turn = state.turn;
    stopBtn.disabled = true;
    try {
      const execution = await PlatformClient.stopExecution(watched.id);
      if (turn !== state.turn) return;
      say('');
      renderRun(execution);
      keepWatching();
    } catch (err) {
      if (turn !== state.turn) return;
      fail(err);
      // 409: it had already finished. Read it again to show how.
      if (err.status === 409) await selectRun(watched.id);
    } finally {
      stopBtn.disabled = false;
    }
  });

  // Delete asks once more in the panel itself, then removes the script from the platform and
  // its builds from Jenkins.
  deleteBtn.addEventListener('click', () => show(deleteConfirm, true));
  deleteNo.addEventListener('click', () => show(deleteConfirm, false));
  deleteYes.addEventListener('click', async () => {
    const script = state.script;
    if (!script) return;
    const turn = state.turn;
    deleteYes.disabled = true;
    say('Deleting…');
    try {
      await PlatformClient.deleteScript(script.id);
      if (turn !== state.turn) return;
      show(deleteConfirm, false);
      showToast(`Deleted "${script.name}"`);
      await loadScripts();
    } catch (err) {
      if (turn !== state.turn) return;
      show(deleteConfirm, false);
      fail(err);
      // A run started elsewhere in the meantime: show it, which also disables Delete.
      const inProgress = err.code === 'RUN_IN_PROGRESS' ? err.details?.executionId : null;
      if (Number.isInteger(inProgress)) await selectRun(inProgress);
    } finally {
      deleteYes.disabled = false;
    }
  });

  $('projects-refresh')?.addEventListener('click', () => openList());
  $('scripts-back')?.addEventListener('click', () => openList());
  $('script-back')?.addEventListener('click', () => loadScripts());
  $('script-copy')?.addEventListener('click', () => copyText(scriptCode.textContent || ''));
  searchInput.addEventListener('input', () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(loadScripts, SEARCH_DELAY_MS);
  });

  // ---- Skills: the project's notes of rules and examples that the AI agents are given ----
  const skillEls = {
    list: $('skills-list'), crumb: $('skills-project-name'), auto: $('skills-auto'), actions: $('skills-actions'),
    file: $('skill-file'), editorCrumb: $('skill-crumb'), name: $('skill-name'), description: $('skill-description'),
    content: $('skill-content'), summary: $('skill-summary'), summaryRow: $('skill-summary-row'),
    globalRow: $('skill-global-row'), global: $('skill-global'), save: $('skill-save'), archive: $('skill-archive'),
    versionsSection: $('skill-versions-section'), versions: $('skill-versions'),
    search: $('skills-search'), tags: $('skill-tags'), duplicate: $('skill-duplicate'), download: $('skill-download'),
  };
  // "smoke, Login , smoke" → ['smoke', 'Login']; the server applies the rules for a tag.
  const tagList = (text) => [...new Set(String(text).split(',').map((tag) => tag.trim()).filter(Boolean))];
  const skillsReady = views.skills && views.skill && Object.values(skillEls).every(Boolean);
  const canWrite = () => state.user?.role === 'ADMIN' || state.user?.role === 'USER';
  const UPLOAD_LIMIT = 300_000;  // bytes; the server's own limit is 200,000 characters
  let editing = null;            // the skill in the editor; null while a new one is written
  let newFileName = '';          // the uploaded file's name, kept with a new skill

  async function openSkills() {
    if (!skillsReady || !state.project) return;
    const turn = ++state.turn;
    stopPolling();
    showView('skills');
    say('Loading…');
    skillEls.crumb.textContent = `${state.project.name} · Skills`;
    show(skillEls.actions, canWrite());
    const chosen = await Storage.getSkillsProject();
    skillEls.auto.checked = chosen?.id === state.project.id;
    const search = skillEls.search.value;
    try {
      const skills = await PlatformClient.listProjectSkills(state.project.id, search);
      if (turn !== state.turn) return;
      const none = search.trim()
        ? 'No skills match the search.'
        : 'No skills yet. A skill is a Markdown note of rules and examples that the AI agents follow.';
      say(skills.length === 0 ? none : '');
      skillEls.list.replaceChildren(...skills.map(skillRow));
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  // One skill in the list: a switch for this project, its name, and its place in the order.
  function skillRow(skill) {
    const row = document.createElement('div');
    row.className = 'skill-row';

    const use = document.createElement('input');
    use.type = 'checkbox';
    use.checked = skill.enabled;
    use.disabled = !canWrite();
    use.title = 'Use this skill in this project';
    use.addEventListener('change', async () => {
      try {
        // Switching on a global skill the project does not have yet also attaches it.
        await PlatformClient.setProjectSkill(state.project.id, skill.id, use.checked ? { attached: true, enabled: true } : { enabled: false });
      } catch (err) {
        use.checked = !use.checked;
        fail(err);
      }
    });

    const scope = skill.scope === 'GLOBAL' ? 'Global' : 'Project';
    const detail = [scope, `v${skill.version}`, skill.description, ...skill.tags.map((tag) => `#${tag}`)].filter(Boolean).join(' · ');
    const open = item(skill.name, detail, () => openSkill(skill.id));

    const order = document.createElement('input');
    order.type = 'number';
    order.min = '1';
    order.max = '1000';
    order.value = String(skill.priority);
    order.disabled = !canWrite();
    order.title = 'Order: lower numbers are given to the agents first';
    order.addEventListener('change', async () => {
      const priority = Number(order.value);
      if (!Number.isInteger(priority) || priority < 1 || priority > 1000) { order.value = String(skill.priority); return; }
      try {
        await PlatformClient.setProjectSkill(state.project.id, skill.id, { priority });
        await openSkills();
      } catch (err) {
        order.value = String(skill.priority);
        fail(err);
      }
    });

    row.append(use, open, order);
    return row;
  }

  // Shows a skill in the editor, or an empty editor for a new one (`preset` fills it from an upload).
  function showEditor(skill, preset = {}) {
    state.turn += 1;
    editing = skill;
    newFileName = skill ? '' : preset.fileName || '';
    showView('skill');
    say('');
    const scope = skill?.scope === 'GLOBAL' ? 'Global skill' : 'Project skill';
    skillEls.editorCrumb.textContent = skill ? `${scope} · v${skill.version}` : 'New skill';
    skillEls.name.value = skill?.name ?? preset.name ?? '';
    skillEls.description.value = skill?.description ?? preset.description ?? '';
    skillEls.content.value = skill?.content ?? preset.content ?? '';
    skillEls.tags.value = (skill?.tags ?? preset.tags ?? []).join(', ');
    skillEls.summary.value = '';
    skillEls.global.checked = false;
    // A global skill is changed by an ADMIN only; everyone else reads it.
    const writable = canWrite() && (!skill || skill.scope === 'PROJECT' || state.user?.role === 'ADMIN');
    for (const el of [skillEls.name, skillEls.description, skillEls.content, skillEls.summary, skillEls.tags]) el.readOnly = !writable;
    // A copy is a new skill of this project, so anyone who may write here can make one.
    show(skillEls.duplicate, Boolean(skill) && canWrite());
    show(skillEls.download, Boolean(skill));
    show(skillEls.globalRow, !skill && state.user?.role === 'ADMIN');
    show(skillEls.summaryRow, Boolean(skill) && writable);
    show(skillEls.save, writable);
    show(skillEls.archive, Boolean(skill) && writable);
    skillEls.archive.textContent = 'Archive';
    show(skillEls.versionsSection, Boolean(skill));
    if (skill) loadSkillVersions(skill, writable);
  }

  async function openSkill(id) {
    const turn = state.turn;
    say('Loading…');
    try {
      const skill = await PlatformClient.getSkill(id);
      if (turn === state.turn) showEditor(skill);
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  async function loadSkillVersions(skill, writable) {
    const turn = state.turn;
    skillEls.versions.replaceChildren();
    try {
      const versions = await PlatformClient.listSkillVersions(skill.id);
      if (turn !== state.turn) return;
      skillEls.versions.replaceChildren(...versions.map((version) => {
        const row = document.createElement('div');
        row.className = 'version-row';
        const text = document.createElement('span');
        text.textContent = [
          `v${version.version}`,
          version.changeSummary,
          version.createdBy,
          new Date(version.createdAt).toLocaleString(),
        ].filter(Boolean).join(' · ');
        row.append(text);
        if (writable && version.version !== skill.version) {
          const restore = document.createElement('button');
          restore.className = 'btn btn-secondary btn-sm';
          restore.textContent = 'Restore';
          restore.addEventListener('click', async () => {
            try {
              const restored = await PlatformClient.restoreSkillVersion(skill.id, version.version);
              showToast(`Restored v${version.version} as v${restored.version}`);
              showEditor(restored);
            } catch (err) {
              fail(err);
            }
          });
          row.append(restore);
        }
        return row;
      }));
    } catch (err) {
      if (turn === state.turn) fail(err);
    }
  }

  if (skillsReady) {
    $('scripts-skills')?.addEventListener('click', () => openSkills());
    $('skills-back')?.addEventListener('click', () => loadScripts());
    $('skill-back')?.addEventListener('click', () => openSkills());
    $('skill-new')?.addEventListener('click', () => showEditor(null));
    $('skill-upload')?.addEventListener('click', () => skillEls.file.click());

    // An uploaded file is only read as text and put in the editor; nothing is saved until Save.
    skillEls.file.addEventListener('change', async () => {
      const file = skillEls.file.files?.[0];
      skillEls.file.value = '';
      if (!file) return;
      if (file.size > UPLOAD_LIMIT) { say('❌ That file is too large for a skill (300 KB at most).'); return; }
      const content = await file.text();
      const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
      const base = file.name.replace(/(\.skill)?\.(md|markdown|txt)$/i, '');
      // The server takes a plain .md name only; any other name is simply not kept.
      const fileName = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/.test(file.name) && file.name.length <= 120 ? file.name : '';
      showEditor(null, { name: (heading || base).slice(0, 200), content, fileName });
    });

    skillEls.auto.addEventListener('change', async () => {
      await Storage.saveSkillsProject(skillEls.auto.checked ? state.project : null);
      document.dispatchEvent(new CustomEvent('skills-project'));
    });

    skillEls.save.addEventListener('click', async () => {
      const body = {
        name: skillEls.name.value.trim(),
        description: skillEls.description.value.trim(),
        content: skillEls.content.value,
        tags: tagList(skillEls.tags.value),
      };
      if (!body.name) { say('❌ Enter a skill name.'); skillEls.name.focus(); return; }
      if (!body.content.trim()) { say('❌ A skill cannot be empty.'); skillEls.content.focus(); return; }
      skillEls.save.disabled = true;
      try {
        if (editing) {
          const summary = skillEls.summary.value.trim();
          const updated = await PlatformClient.updateSkill(editing.id, summary ? { ...body, changeSummary: summary } : body);
          showToast(`Saved "${updated.name}" · v${updated.version}`);
          showEditor(updated);
        } else {
          const global = skillEls.global.checked;
          const created = await PlatformClient.createSkill(global ? null : state.project.id, { ...body, fileName: newFileName });
          // A new global skill is put to use in the project it was written from.
          if (global) await PlatformClient.setProjectSkill(state.project.id, created.id, { attached: true });
          showToast(`Saved "${created.name}"`);
          await openSkills();
        }
      } catch (err) {
        fail(err);
      } finally {
        skillEls.save.disabled = false;
      }
    });

    skillEls.search.addEventListener('input', () => {
      clearTimeout(state.searchTimer);
      state.searchTimer = setTimeout(openSkills, SEARCH_DELAY_MS);
    });

    // A copy opens in the editor as a new skill of this project; nothing is stored until Save.
    skillEls.duplicate.addEventListener('click', () => {
      if (!editing) return;
      showEditor(null, {
        name: `${editing.name} (copy)`.slice(0, 200),
        description: editing.description,
        content: skillEls.content.value,
        tags: editing.tags,
      });
    });

    // The skill as a .md file: what is in the editor, under its stored file name or one made from its name.
    skillEls.download.addEventListener('click', () => {
      if (!editing) return;
      const slug = editing.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'skill';
      const link = document.createElement('a');
      link.href = URL.createObjectURL(new Blob([skillEls.content.value], { type: 'text/markdown' }));
      link.download = editing.fileName || `${slug}.skill.md`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });

    // Archive asks once more by changing its own label; the second press does it.
    skillEls.archive.addEventListener('click', async () => {
      if (!editing) return;
      if (skillEls.archive.textContent !== 'Confirm archive') { skillEls.archive.textContent = 'Confirm archive'; return; }
      try {
        await PlatformClient.archiveSkill(editing.id);
        showToast(`Archived "${editing.name}"`);
        await openSkills();
      } catch (err) {
        fail(err);
      }
    });
  }

  // "Save & Run on Jenkins" in the save dialog: show the saved script here and start it.
  document.addEventListener('platform-script-saved', async (event) => {
    const { project, scriptId, run } = event.detail;
    if (!run) return;
    document.querySelector('.nav-btn[data-panel="projects"]')?.click();
    state.project = project;
    projectName.textContent = project.name;
    await openScript(scriptId);
    // Run is missing or disabled when Jenkins is not set up, the role may not run, or a run
    // is already going; the script page then says which.
    if (state.script?.id === scriptId && runBtn.style.display !== 'none' && !runBtn.disabled) runBtn.click();
  });

  // A failed run goes to the Healer panel with the script and what Jenkins reported.
  healBtn?.addEventListener('click', () => {
    const execution = state.execution;
    if (!execution || !state.script) return;
    const failed = state.results.filter((result) => result.label === 'Failed');
    const errors = failed.length > 0
      ? failed.map((result) => `${result.name}\n${result.error}`).join('\n\n')
      : execution.errorMessage || '';
    const fill = (id, value) => { const el = document.getElementById(id); if (el) el.value = value; };
    fill('healer-error', errors);
    fill('healer-code', state.script.content);
    fill('healer-context', `Jenkins run #${execution.id} of "${state.script.name}" v${execution.scriptVersion} ended ${statusView(execution.status).label}.`);
    // A fix can be saved back only onto the version that ran: anything else would overwrite later work.
    const current = execution.scriptVersion === state.script.version;
    document.dispatchEvent(new CustomEvent('heal-target', {
      detail: current && state.project
        ? {
            project: state.project,
            scriptId: state.script.id,
            name: state.script.name,
            version: state.script.version,
            content: state.script.content,
            runId: execution.id,
          }
        : null,
    }));
    document.querySelector('.nav-btn[data-panel="healer"]')?.click();
    showToast('Failed run sent to the Healer — press Heal Test');
  });

  // Sign-in, sign-out, and a changed role all start again from the project list.
  document.addEventListener('platform-auth', (event) => {
    const user = event.detail.user;
    const same = (state.user?.id ?? null) === (user?.id ?? null) && (state.user?.role ?? null) === (user?.role ?? null);
    const first = state.turn === 0;
    state.user = user;
    if (first || !same) openList();
  });

  // Jenkins was set up or changed under Settings: Run may now be available.
  document.addEventListener('jenkins-settings', (event) => {
    state.jenkins = event.detail.settings;
    if (state.script) renderRun(state.execution);
  });

  // Leaving the tab stops the polling; coming back picks the watch up again.
  document.querySelectorAll('.nav-btn[data-panel]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (btn.getAttribute('data-panel') !== 'projects') { stopPolling(); return; }
      if (state.execution && !isFinal(state.execution.status)) selectRun(state.execution.id);
    });
  });
}

// Settings → Jenkins. Shown once signed in to the platform. An ADMIN gets the form; other
// roles only see whether Jenkins is set up. The API token goes to the platform server, which
// stores it encrypted; the extension never keeps it.
function setupJenkinsSettings() {
  const $ = (id) => document.getElementById(id);
  const section = $('jenkins-section');
  const summary = $('jenkins-summary');
  const adminForm = $('jenkins-admin');
  const urlInput = $('jenkins-url');
  const usernameInput = $('jenkins-username');
  const tokenInput = $('jenkins-token');
  const jobInput = $('jenkins-job');
  const status = $('jenkins-status');
  const testBtn = $('jenkins-test');
  const saveBtn = $('jenkins-save');
  const jobBtn = $('jenkins-create-job');
  const required = [section, summary, adminForm, urlInput, usernameInput, tokenInput, jobInput, status, testBtn, saveBtn, jobBtn];
  if (required.some((el) => !el)) return;

  let shownFor = null;  // id and role of the user the block was last drawn for

  // textContent and .value only: these values come from the server.
  const fill = (settings) => {
    summary.textContent = settings.configured ? '✅ Jenkins is set up.' : 'Jenkins is not set up yet.';
    urlInput.value = settings.baseUrl;
    usernameInput.value = settings.username;
    jobInput.value = settings.jobName;
    tokenInput.value = '';
    tokenInput.placeholder = settings.hasToken ? 'saved — leave empty to keep it' : '';
    jobBtn.disabled = !settings.configured;
  };

  async function load(user) {
    section.style.display = user ? '' : 'none';
    adminForm.style.display = user?.role === 'ADMIN' ? '' : 'none';
    status.textContent = '';
    if (!user) return;
    summary.textContent = 'Loading…';
    try {
      fill(await PlatformClient.getJenkinsSettings());
    } catch (err) {
      summary.textContent = `⚠️ ${err.message}`;
    }
  }

  document.addEventListener('platform-auth', (event) => {
    const user = event.detail.user;
    const key = user ? `${user.id}:${user.role}` : '';
    if (key === shownFor) return;
    shownFor = key;
    load(user);
  });

  const form = () => ({
    baseUrl: urlInput.value.trim(),
    username: usernameInput.value.trim(),
    jobName: jobInput.value.trim(),
    token: tokenInput.value,
  });

  // Runs one button's action and puts its result, or the reason it failed, in the status line.
  async function act(button, busyText, work) {
    button.disabled = true;
    status.textContent = busyText;
    try {
      status.textContent = await work();
    } catch (err) {
      status.textContent = `❌ ${err.message}`;
    } finally {
      button.disabled = false;
    }
  }

  testBtn.addEventListener('click', () => act(testBtn, 'Testing…', async () => {
    const result = await PlatformClient.testJenkins(form());
    return `${result.ok ? '✅' : '❌'} ${result.message}`;
  }));

  saveBtn.addEventListener('click', () => act(saveBtn, 'Saving…', async () => {
    const settings = await PlatformClient.saveJenkinsSettings(form());
    fill(settings);
    document.dispatchEvent(new CustomEvent('jenkins-settings', { detail: { settings } }));
    return '✅ Saved. Press Create Job if the job is not in Jenkins yet.';
  }));

  jobBtn.addEventListener('click', () => act(jobBtn, 'Creating the job…', async () => {
    const result = await PlatformClient.createJenkinsJob();
    return `✅ Job ${result.created ? 'created' : 'updated'}: ${result.jobUrl}`;
  }));
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
