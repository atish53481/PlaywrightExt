// Run / debug UI shared by the Generator, Recorder and Test Explorer panels.
//   runCodeLive      — Live engine on the active tab, with debugger controls
//                      (pause, resume, step over, breakpoints, retry, pick locator)
//   runCodeViaBridge — real Playwright via the local bridge (run or --debug)

import { TestRunner, RunController } from '../utils/test-runner.js';
import { BridgeClient } from '../utils/bridge-client.js';

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function toast(msg) {
  const t = document.createElement('div');
  t.textContent = msg;
  t.className = 'pas-toast';
  document.body.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 1600);
}

const ICONS = { pending: '⏳', running: '▶️', passed: '✅', failed: '❌', skipped: '⏭️', stopped: '⏹️' };
const short = (s, n = 90) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

let active = null; // one Live run at a time — they all drive the same tab

export const isLiveRunActive = () => !!active;

// Runs `code` on the active tab. Returns { summary, steps, durationMs, code } or
// null when nothing ran. With debug:true the run starts paused on the first step
// and pauses again on every failure so the step can be fixed and retried.
export async function runCodeLive(code, { section, results, summary, btn, healBtn, debug = false, onHeal, onCodeChange, quiet = false } = {}) {
  if (active) { toast('A run is already in progress — stop it first'); return null; }
  const steps = TestRunner.parse(code);
  if (steps.length === 0) { toast('No runnable Playwright steps found in code'); return null; }

  let currentCode = code;
  let pausedAt = -1, pausedFailed = false, picked = null, finished = false;
  const ctl = new RunController({ startPaused: debug, pauseOnFail: debug });
  const stepResults = steps.map(s => ({ label: s.label, status: 'pending', error: null, ms: null }));
  active = ctl;

  section.style.display = 'block';
  results.innerHTML = `
    <div class="dbg-bar">
      <button class="btn btn-icon" data-a="resume" title="Run to the next breakpoint / failure">▶ Resume</button>
      <button class="btn btn-icon" data-a="step" title="Run one step, then pause">⏭ Step over</button>
      <button class="btn btn-icon" data-a="pause" title="Pause before the next step">⏸ Pause</button>
      <button class="btn btn-icon" data-a="retry" title="Run the failed step again">↻ Retry step</button>
      <button class="btn btn-icon" data-a="stop">⏹ Stop</button>
      <button class="btn btn-icon" data-a="pick" title="Click an element on the page to get its locator">🎯 Pick locator</button>
    </div>
    <div class="dbg-pick" hidden>
      <code></code>
      <button class="btn btn-icon" data-a="copy">📋 Copy</button>
      <button class="btn btn-icon" data-a="use" title="Replace the paused step's locator with this one">↪ Use for paused step</button>
    </div>
    <div class="dbg-steps">${steps.map((s, i) => `
      <div class="run-step" data-i="${i}">
        <span class="bp" title="Toggle breakpoint">●</span>
        <span class="ic">${ICONS.pending}</span>
        <span class="lbl" title="${esc(s.src || s.label)}">${esc(s.label)}</span>
        <span class="ms"></span>
        <div class="detail"></div>
      </div>`).join('')}</div>`;

  const bar = (a) => results.querySelector(`[data-a="${a}"]`);
  const row = (i) => results.querySelector(`.run-step[data-i="${i}"]`);
  const pickBox = results.querySelector('.dbg-pick');

  const refresh = () => {
    const waiting = ctl.waiting && !finished;
    bar('resume').disabled = !waiting;
    bar('step').disabled = !waiting;
    bar('retry').disabled = !(waiting && pausedFailed);
    bar('pause').disabled = finished || waiting || ctl.paused;
    bar('stop').disabled = finished;
    bar('use').disabled = !(waiting && picked && steps[pausedAt]?.locator);
  };
  const setSummary = () => {
    const done = stepResults.filter(r => !['pending', 'running'].includes(r.status)).length;
    summary.textContent = pausedAt >= 0
      ? `⏸ Paused ${pausedFailed ? 'on failed' : 'before'} step ${pausedAt + 1}/${steps.length}`
      : `${done}/${steps.length}`;
  };
  const highlight = (i) => {
    if (steps[i]?.locator) TestRunner.sendToContent({ type: 'HIGHLIGHT', locator: steps[i].locator });
  };

  ctl.onPause = (i, { failed }) => {
    pausedAt = i; pausedFailed = failed;
    row(i)?.classList.add('paused');
    row(i)?.scrollIntoView({ block: 'nearest' });
    if (!failed) highlight(i);
    setSummary(); refresh();
  };
  ctl.onResume = () => {
    results.querySelectorAll('.run-step.paused').forEach(r => r.classList.remove('paused'));
    pausedAt = -1; pausedFailed = false;
    setSummary(); refresh();
  };

  bar('resume').onclick = () => ctl.resume();
  bar('step').onclick = () => ctl.step();
  bar('retry').onclick = () => ctl.retry();
  bar('pause').onclick = () => { ctl.pause(); refresh(); toast('Pausing before the next step'); };
  bar('stop').onclick = () => ctl.stop();

  results.querySelector('.dbg-steps').onclick = (e) => {
    const r = e.target.closest('.run-step');
    if (!r) return;
    const i = Number(r.getAttribute('data-i'));
    if (e.target.classList.contains('bp')) r.classList.toggle('has-bp', ctl.toggleBreakpoint(i));
    else highlight(i);
  };

  // ---- pick locator ----
  if (results.__onPicked) window.removeEventListener('pas-locator-picked', results.__onPicked);
  results.__onPicked = (e) => {
    if (!results.isConnected || !results.contains(pickBox)) return;
    picked = e.detail.locator;
    pickBox.hidden = false;
    pickBox.querySelector('code').textContent = `page.${picked}`;
    bar('pick').classList.remove('on');
    refresh();
  };
  window.addEventListener('pas-locator-picked', results.__onPicked);

  bar('pick').onclick = async () => {
    const resp = await TestRunner.sendToContent({ type: 'START_PICK' });
    if (!resp?.ok) { toast(resp?.error || 'Page did not respond'); return; }
    bar('pick').classList.add('on');
    toast('Click an element on the page (Esc to cancel)');
  };
  bar('copy').onclick = () => navigator.clipboard.writeText(`page.${picked}`).then(() => toast('Copied!')).catch(() => {});
  bar('use').onclick = () => {
    const step = steps[pausedAt];
    const parsed = picked && TestRunner.parseLocator(`page.${picked}`);
    if (!step?.locator || !parsed) return;
    const oldRaw = step.locator.raw;
    steps.forEach((s, i) => {
      if (s.locator?.raw !== oldRaw) return;
      s.locator = parsed;
      s.src = (s.src || '').split(oldRaw).join(parsed.raw);
      s.label = short(s.src.replace(/\s+/g, ' ').replace(/^await\s+/, '').replace(/;$/, '')) || s.label;
      stepResults[i].label = s.label;
      const lbl = row(i)?.querySelector('.lbl');
      if (lbl) { lbl.textContent = s.label; lbl.title = s.src; }
    });
    const next = currentCode.split(oldRaw).join(parsed.raw);
    if (next !== currentCode) {
      currentCode = next;
      onCodeChange?.(currentCode);
      toast('Locator replaced in code — Retry / Resume to continue');
    } else {
      toast('Locator applied to this run only — update the code by hand');
    }
    highlight(pausedAt);
  };

  btn.disabled = true;
  if (healBtn) healBtn.style.display = 'none';
  setSummary(); refresh();
  const t0 = Date.now();
  let runSummary = null;

  try {
    runSummary = await TestRunner.run(steps, (i, status, detail, ms) => {
      stepResults[i] = { label: steps[i].label, status, error: status === 'failed' ? detail : null, ms: ms ?? null };
      const r = row(i);
      if (r) {
        r.querySelector('.ic').textContent = ICONS[status] || '';
        r.querySelector('.ms').textContent = ms != null ? `${ms}ms` : '';
        const d = r.querySelector('.detail');
        d.textContent = status === 'failed' ? detail : status === 'skipped' && detail ? detail : '';
        d.classList.toggle('muted', status !== 'failed');
        r.classList.toggle('running', status === 'running');
        r.scrollIntoView({ block: 'nearest' });
      }
      setSummary();
    }, ctl);

    summary.textContent = `${runSummary.stopped ? '⏹ Stopped · ' : ''}✅ ${runSummary.passed} passed · ❌ ${runSummary.failed} failed · ⏭️ ${runSummary.skipped} skipped`;
    if (!quiet) toast(runSummary.stopped ? 'Run stopped' : runSummary.failed === 0 ? 'All runnable steps passed!' : `${runSummary.failed} step(s) failed`);

    // 🎭 healer stage (official test-agents workflow): route failures to the healer agent
    if (runSummary.failed > 0 && healBtn && onHeal) {
      healBtn.style.display = 'inline-block';
      healBtn.onclick = () => onHeal(currentCode, stepResults.filter(r => r.status === 'failed'));
    }
  } catch (e) {
    summary.textContent = `Error: ${e.message}`;
  } finally {
    finished = true;
    active = null;
    btn.disabled = false;
    refresh();
  }
  if (!runSummary) return null;
  return { summary: runSummary, steps: stepResults, durationMs: Date.now() - t0, code: currentCode };
}

// Runs code with the real Playwright runner via the bridge. mode: 'run' | 'debug'
// (debug = npx playwright test --debug, opens the Playwright Inspector).
// Returns { passed, exitCode, output } or null when the bridge is unavailable.
export async function runCodeViaBridge(code, { section, results, summary, btn, mode = 'run', quiet = false } = {}) {
  section.style.display = 'block';
  results.innerHTML = '<pre class="bridge-log"></pre>';
  const log = results.querySelector('pre');
  summary.textContent = '🌉 connecting to bridge...';
  btn.disabled = true;

  const onEvent = (msg) => {
    if (msg.type === 'status' || msg.type === 'output') {
      // strip ANSI colour codes from the Playwright reporter
      log.textContent += (msg.message || msg.line || '').replace(/\x1b\[[0-9;]*m/g, '');
      results.scrollTop = results.scrollHeight;
      summary.textContent = mode === 'debug' ? '🐞 Playwright Inspector open...' : '🏃 Playwright running (headed)...';
    }
  };

  try {
    const res = mode === 'debug' ? await BridgeClient.launchTool('debug', { code }, onEvent) : await BridgeClient.runCode(code, onEvent);
    summary.textContent = res.passed ? '✅ Playwright run PASSED' : `❌ Playwright run FAILED (exit ${res.exitCode})`;
    if (!quiet) toast(res.passed ? 'Real Playwright run passed!' : 'Run failed — see output');
    return { passed: !!res.passed, exitCode: res.exitCode, output: log.textContent };
  } catch (e) {
    summary.textContent = '🌉 bridge unavailable';
    log.textContent += `${e.message}\n\nSetup (once):\n  cd PlaywrightExt/PlaywrightBridge\n  npm run setup\n\nThen keep running:\n  npm start`;
    return null;
  } finally {
    btn.disabled = false;
  }
}
