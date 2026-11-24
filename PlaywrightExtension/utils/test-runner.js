// Test Runner — parses Playwright code into steps and executes them on the
// active tab via the content script (the "Live" engine), with debugger controls:
// pause, resume, step over, breakpoints, retry-after-failure.

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Tokenizer helpers (string / regex / bracket aware)
// ---------------------------------------------------------------------------
function skipString(src, i) {
  const q = src[i];
  i++;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === q) return i + 1;
    i++;
  }
  return i;
}

function isRegexStart(src, i) {
  if (src[i] !== '/' || src[i + 1] === '/' || src[i + 1] === '*') return false;
  let j = i - 1;
  while (j >= 0 && /\s/.test(src[j])) j--;
  return j < 0 || '(,:=[{!&|?'.includes(src[j]);
}

function skipRegex(src, i) {
  i++;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) { i++; break; }
    i++;
  }
  while (i < src.length && /[a-z]/i.test(src[i])) i++;
  return i;
}

// Index of the bracket that closes the one at src[open], or -1.
function matchBracket(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i) - 1; continue; }
    if (isRegexStart(src, i)) { i = skipRegex(src, i) - 1; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

// Net count of unclosed "(" on a line.
function parenBalance(line) {
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(line, i) - 1; continue; }
    if (isRegexStart(line, i)) { i = skipRegex(line, i) - 1; continue; }
    if (c === '/' && line[i + 1] === '/') break;
    if (c === '(') depth++; else if (c === ')') depth--;
  }
  return depth;
}

function splitTop(src) {
  const parts = [];
  let depth = 0, start = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i = skipString(src, i) - 1; continue; }
    if (isRegexStart(src, i)) { i = skipRegex(src, i) - 1; continue; }
    if (c === '(' || c === '{' || c === '[') depth++;
    else if (c === ')' || c === '}' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(src.slice(start, i)); start = i + 1; }
  }
  parts.push(src.slice(start));
  return parts.map(p => p.trim()).filter(Boolean);
}

function unescapeJs(body) {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g, (_, e) => {
    if (e[0] === 'u' || e[0] === 'x') return String.fromCharCode(parseInt(e.slice(1), 16));
    return ({ n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' })[e] ?? e;
  });
}

// → { text } | { regex, flags } | { bool } | { obj } | { dynamic: true }
function parseLiteral(tok) {
  tok = (tok || '').trim();
  if (!tok) return null;
  const q = tok[0];
  if (q === "'" || q === '"' || q === '`') {
    if (skipString(tok, 0) !== tok.length) return { dynamic: true };
    const body = tok.slice(1, -1);
    if (q === '`' && body.includes('${')) return { dynamic: true };
    return { text: unescapeJs(body) };
  }
  if (q === '/') {
    const end = skipRegex(tok, 0);
    if (end !== tok.length) return { dynamic: true };
    const lastSlash = tok.lastIndexOf('/');
    return { regex: tok.slice(1, lastSlash), flags: tok.slice(lastSlash + 1) };
  }
  if (q === '{') {
    const obj = {};
    for (const pair of splitTop(tok.slice(1, -1))) {
      const idx = pair.indexOf(':');
      if (idx < 0) continue;
      obj[pair.slice(0, idx).trim().replace(/^['"]|['"]$/g, '')] = parseLiteral(pair.slice(idx + 1));
    }
    return { obj };
  }
  if (/^-?\d+(\.\d+)?$/.test(tok)) return { text: tok, num: Number(tok) };
  if (tok === 'true' || tok === 'false') return { bool: tok === 'true' };
  return { dynamic: true };
}

const parseArgs = (args) => splitTop(args || '').map(parseLiteral);
const isMatcher = (v) => !!v && (v.text != null || v.regex != null);

// "page.getByRole('x').click()" → [{name:'page',args:null,start,end}, {name:'getByRole',args:"'x'",...}, ...]
function parseCalls(src) {
  const calls = [];
  let i = 0;
  while (i < src.length) {
    while (i < src.length && /[\s.!?;]/.test(src[i])) i++;
    const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i));
    if (!m) break;
    const start = i;
    i += m[0].length;
    let j = i;
    while (src[j] === ' ') j++;
    if (src[j] === '(') {
      const end = matchBracket(src, j);
      if (end < 0) return null;
      calls.push({ name: m[0], args: src.slice(j + 1, end), start, end: end + 1 });
      i = end + 1;
    } else {
      calls.push({ name: m[0], args: null, start, end: i });
    }
  }
  return i >= src.length || !src.slice(i).trim() ? calls : null;
}

// ---------------------------------------------------------------------------
// Locator parsing
// ---------------------------------------------------------------------------
const TEXT_LOCATORS = new Set(['getByText', 'getByLabel', 'getByPlaceholder', 'getByAltText', 'getByTitle']);
const LOCATOR_METHODS = new Set([...TEXT_LOCATORS, 'getByRole', 'getByTestId', 'locator', 'first', 'last', 'nth', 'filter']);

// calls → chain segments, or null when something is not supported by the Live engine
function callsToChain(calls) {
  const chain = [];
  for (const c of calls) {
    const a = parseArgs(c.args);
    const opts = a[1]?.obj || {};
    if (c.name === 'getByRole') {
      if (a[0]?.text == null) return null;
      const seg = { m: 'getByRole', role: a[0].text };
      if (opts.name) {
        if (!isMatcher(opts.name)) return null;
        seg.name = { ...opts.name, exact: opts.exact?.bool === true };
      }
      chain.push(seg);
    } else if (TEXT_LOCATORS.has(c.name)) {
      if (!isMatcher(a[0])) return null;
      chain.push({ m: c.name, text: { ...a[0], exact: opts.exact?.bool === true } });
    } else if (c.name === 'getByTestId') {
      if (a[0]?.text == null) return null;
      chain.push({ m: 'getByTestId', id: a[0].text });
    } else if (c.name === 'locator') {
      if (a[0]?.text == null) return null;
      chain.push({ m: 'locator', selector: a[0].text });
      if (opts.hasText) {
        if (!isMatcher(opts.hasText)) return null;
        chain.push({ m: 'filter', hasText: opts.hasText });
      }
    } else if (c.name === 'first') chain.push({ m: 'nth', index: 0 });
    else if (c.name === 'last') chain.push({ m: 'nth', index: -1 });
    else if (c.name === 'nth') {
      if (a[0]?.num == null) return null;
      chain.push({ m: 'nth', index: a[0].num });
    } else if (c.name === 'filter') {
      const f = a[0]?.obj;
      if (!f || !isMatcher(f.hasText) || Object.keys(f).length !== 1) return null;
      chain.push({ m: 'filter', hasText: f.hasText });
    } else return null;
  }
  return chain.length ? chain : null;
}

const ACTIONS = {
  click: 'click', dblclick: 'dblclick', tap: 'click', fill: 'fill', clear: 'clear', press: 'press',
  type: 'type', pressSequentially: 'type', check: 'check', uncheck: 'uncheck', selectOption: 'selectOption',
  hover: 'hover', focus: 'focus', waitFor: 'waitFor', scrollIntoViewIfNeeded: 'scrollIntoView',
};
const ASSERTIONS = new Set(['toBeVisible', 'toBeHidden', 'toBeAttached', 'toContainText', 'toHaveText', 'toHaveValue',
  'toBeEnabled', 'toBeDisabled', 'toBeChecked', 'toBeFocused', 'toBeEditable', 'toBeEmpty', 'toHaveCount', 'toHaveAttribute']);

const short = (s, n = 70) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------------------
// Statement extraction: join multi-line chains / calls into one statement
// ---------------------------------------------------------------------------
function toStatements(source) {
  const out = [];
  let cur = null;
  const lines = source.split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].trim();
    if (!line || line.startsWith('//') || line.startsWith('*') || line.startsWith('/*')) continue;
    if (cur) {
      cur.text += '\n' + lines[n];
      cur.balance += parenBalance(line);
    } else if (line.startsWith('.') && out.length) {
      // continuation of a fluent chain:  await page\n  .getByRole(...)\n  .click();
      const prev = out[out.length - 1];
      prev.text += '\n' + lines[n];
      const bal = parenBalance(line);
      if (bal > 0) { cur = out.pop(); cur.balance = bal; }
      continue;
    } else {
      cur = { text: lines[n], line: n + 1, balance: parenBalance(line) };
      // block openers (test(...) => {, if (...) {) are never merged with what follows
      const opensBlock = /\{$/.test(line) && (/=>|\bfunction\b/.test(line) || /^(if|for|while|try|else|switch|class|do)\b/.test(line) || /^}/.test(line));
      if (opensBlock) cur.balance = 0;
    }
    if (cur.balance <= 0) { out.push(cur); cur = null; }
  }
  if (cur) out.push(cur);
  return out;
}

export const TestRunner = {

  // Parses "page.getByRole('button')" (or without the page. prefix) → { chain, raw } | null
  parseLocator(expr) {
    const src = expr.trim().replace(/^await\s+/, '').replace(/;$/, '');
    const calls = parseCalls(src);
    if (!calls || !calls.length) return null;
    const rest = calls[0].name === 'page' && calls[0].args === null ? calls.slice(1) : calls;
    const chain = callsToChain(rest);
    if (!chain) return null;
    return { chain, raw: src.startsWith('page.') ? src : `page.${src}` };
  },

  // Extracts executable steps from Playwright code. Statements the Live engine
  // cannot execute (page objects, unsupported APIs) become 'skip' steps.
  parse(code) {
    const fences = [...code.matchAll(/```(?:typescript|javascript|ts|js)?\r?\n([\s\S]*?)```/g)];
    const source = (fences.length ? fences.map(f => f[1]).join('\n') : code).replace(/\r/g, '');

    const steps = [];
    const vars = {}; // const submit = page.getByRole(...)  → reusable locator
    const push = (st, step) => steps.push({ ...step, line: st.line, src: st.text.trim() });
    const skip = (st, reason) => push(st, { action: 'skip', label: short(st.text.trim().replace(/\s+/g, ' ')), reason });

    // resolves [page|var, ...locator calls] → { chain, raw, used } where used = calls consumed
    const locatorFrom = (calls, text) => {
      if (!calls.length) return null;
      let base = null, i = 1;
      if (calls[0].name === 'page' && calls[0].args === null) base = { chain: [], raw: 'page' };
      else if (calls[0].args === null && vars[calls[0].name]) base = vars[calls[0].name];
      else return null;
      const locCalls = [];
      while (i < calls.length && LOCATOR_METHODS.has(calls[i].name) && calls[i].args !== null) locCalls.push(calls[i++]);
      if (!locCalls.length) return base.chain.length ? { locator: base, used: 1 } : null;
      const chain = callsToChain(locCalls);
      if (!chain) return { unsupported: true };
      const own = text.slice(locCalls[0].start, locCalls[locCalls.length - 1].end);
      return { locator: { chain: [...base.chain, ...chain], raw: `${base.raw}.${own}` }, used: i };
    };

    for (const st of toStatements(source)) {
      let text = st.text.trim();
      if (/^(import|export|test\b|test\.|describe|\}|\)|const\s*\{)/.test(text) && !/^test\.step/.test(text)) {
        if (!/^(const|let|var)\s+\w+\s*=/.test(text)) continue;
      }
      const hadAwait = /^(return\s+)?await\s/.test(text);
      text = text.replace(/^return\s+/, '').replace(/^await\s+/, '').replace(/;\s*$/, '').replace(/^this\./, '');

      // locator variable:  const btn = page.getByRole('button', { name: 'Go' });
      const decl = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:await\s+)?([\s\S]+)$/.exec(text);
      if (decl) {
        const calls = parseCalls(decl[2].replace(/^this\./, ''));
        const res = calls && locatorFrom(calls, decl[2].replace(/^this\./, ''));
        if (res?.locator && res.used === calls.length) vars[decl[1]] = res.locator;
        else if (hadAwait || /=\s*await\s/.test(text)) skip(st, 'value is computed at runtime — Live engine cannot evaluate it');
        continue;
      }

      // ---- expect(...) ----
      const exp = /^expect(?:\.soft)?\s*\(/.exec(text);
      if (exp) {
        const open = text.indexOf('(');
        const close = matchBracket(text, open);
        const inner = close > 0 ? text.slice(open + 1, close).trim() : '';
        const tail = close > 0 ? parseCalls(text.slice(close + 1)) : null;
        if (!tail || !tail.length) { skip(st, 'could not parse assertion'); continue; }
        const negated = tail[0].name === 'not';
        const call = tail[negated ? 1 : 0];
        if (!call || call.args === null) { skip(st, 'could not parse assertion'); continue; }
        const a = parseArgs(call.args);

        if (inner === 'page') {
          if (call.name === 'toHaveURL' && isMatcher(a[0])) {
            push(st, { action: 'assertURL', expected: a[0], negated, label: `expect(page)${negated ? '.not' : ''}.toHaveURL(${short(call.args, 40)})` });
          } else if (call.name === 'toHaveTitle' && isMatcher(a[0])) {
            push(st, { action: 'assertTitle', expected: a[0], negated, label: `expect(page)${negated ? '.not' : ''}.toHaveTitle(${short(call.args, 40)})` });
          } else skip(st, `expect(page).${call.name} is not supported by the Live engine`);
          continue;
        }
        const innerCalls = parseCalls(inner);
        const res = innerCalls && locatorFrom(innerCalls, inner);
        if (!res?.locator || res.used !== innerCalls.length) { skip(st, 'expect() target is not a simple locator'); continue; }
        if (!ASSERTIONS.has(call.name)) { skip(st, `${call.name} is not supported by the Live engine`); continue; }
        if (a.some(v => v?.dynamic)) { skip(st, 'expected value is computed at runtime'); continue; }
        push(st, {
          action: 'assert', locator: res.locator, assertion: call.name, negated,
          expected: a[0] || null, expected2: a[1] && isMatcher(a[1]) ? a[1] : null,
          label: `expect(${short(res.locator.raw.replace(/^page\./, ''), 46)})${negated ? '.not' : ''}.${call.name}(${short(call.args, 30)})`,
        });
        continue;
      }

      const calls = parseCalls(text);
      if (!calls || calls.length < 2) continue;

      // ---- page-level calls ----
      if (calls[0].name === 'page' && calls[0].args === null && !LOCATOR_METHODS.has(calls[1].name)) {
        const c = calls[1];
        const a = parseArgs(c.args);
        if (c.name === 'goto') {
          if (a[0]?.text == null) skip(st, 'URL is computed at runtime');
          else push(st, { action: 'goto', url: a[0].text, label: `goto ${short(a[0].text, 60)}` });
        } else if (c.name === 'keyboard' && calls[2]?.name === 'press') {
          const k = parseArgs(calls[2].args)[0]?.text;
          push(st, { action: 'press', locator: null, value: k, label: `keyboard.press('${k}')` });
        } else if (c.name === 'keyboard' && calls[2]?.name === 'type') {
          const t = parseArgs(calls[2].args)[0]?.text;
          push(st, { action: 'type', locator: null, value: t, label: `keyboard.type('${short(t || '', 40)}')` });
        } else if (c.name === 'waitForTimeout') {
          push(st, { action: 'wait', ms: a[0]?.num || 0, label: `waitForTimeout(${a[0]?.num || 0})` });
        } else if (c.name === 'waitForLoadState') {
          push(st, { action: 'waitLoad', label: 'waitForLoadState()' });
        } else if (c.name === 'waitForURL' && isMatcher(a[0])) {
          push(st, { action: 'assertURL', expected: a[0], negated: false, label: `waitForURL(${short(c.args, 40)})` });
        } else if (c.name === 'reload') push(st, { action: 'reload', label: 'reload()' });
        else if (c.name === 'goBack') push(st, { action: 'goBack', label: 'goBack()' });
        else if (c.name === 'goForward') push(st, { action: 'goForward', label: 'goForward()' });
        else if (hadAwait) skip(st, `page.${c.name}() is not supported by the Live engine`);
        continue;
      }

      // ---- <locator>.<action>(...) ----
      const res = locatorFrom(calls, text);
      if (res?.unsupported) { skip(st, 'locator uses options the Live engine does not support'); continue; }
      if (res?.locator) {
        const rest = calls.slice(res.used);
        const act = rest[0];
        if (rest.length !== 1 || act.args === null || !ACTIONS[act.name]) {
          if (hadAwait) skip(st, `.${rest.map(r => r.name).join('.')}() is not supported by the Live engine`);
          continue;
        }
        const a = parseArgs(act.args);
        const action = ACTIONS[act.name];
        const needsValue = ['fill', 'press', 'type', 'selectOption'].includes(action);
        if (needsValue && a[0]?.text == null) { skip(st, 'value is computed at runtime'); continue; }
        push(st, {
          action, locator: res.locator, value: needsValue ? a[0].text : undefined,
          label: `${short(res.locator.raw.replace(/^page\./, ''), 52)}.${act.name}(${needsValue ? short(act.args, 28) : ''})`,
        });
        continue;
      }

      // page objects, helpers, fixtures — report, don't fail
      if (hadAwait) skip(st, `${calls[0].name}.${calls[1].name}(...) — page-object / helper call, cannot run directly`);
    }
    return steps;
  },

  sendToContent(payload) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload }, resp => {
        resolve(resp || { error: chrome.runtime.lastError?.message || 'No response from page' });
      });
    });
  },

  getActiveTab() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, tab => resolve(tab));
    });
  },

  async waitForPageReady(timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = await this.sendToContent({ type: 'GET_PAGE_INFO' });
      if (info?.readyState === 'complete') return true;
      if (info?.fatal) return false;
      await sleep(300);
    }
    return false;
  },

  // Sends a step to the page. A navigation can tear the content script down
  // mid-step; in that case wait for the new page and send again.
  async execOnPage(step) {
    const deadline = Date.now() + 15000;
    for (;;) {
      const resp = await this.sendToContent({ type: 'RUN_STEP', step });
      if (resp && typeof resp.ok === 'boolean') return resp;
      if (resp?.fatal || Date.now() > deadline) return { ok: false, error: resp?.error || 'Page did not respond' };
      await sleep(400);
    }
  },

  async pollTab(test, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    let tab;
    for (;;) {
      tab = await this.getActiveTab();
      if (tab && test(tab)) return { ok: true, tab };
      if (Date.now() > deadline) return { ok: false, tab };
      await sleep(200);
    }
  },

  async exec(step) {
    const matches = (actual, m, tab) => {
      if (m.regex != null) return new RegExp(m.regex, m.flags || '').test(actual || '');
      if (!actual) return false;
      if (step.action === 'assertTitle') return actual === m.text;
      // toHaveURL('/inventory') resolves against the current origin, like baseURL
      let want = m.text;
      try { want = new URL(m.text, tab.url).href; } catch { /* keep as is */ }
      const strip = (u) => u.replace(/\/$/, '');
      return strip(actual) === strip(want) || (m.text.includes('*') && new RegExp('^' + m.text.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$').test(actual));
    };
    try {
      switch (step.action) {
        case 'goto': {
          const tab = await this.getActiveTab();
          if (!tab?.id) return { ok: false, error: 'No active tab' };
          let url = step.url;
          try { url = new URL(url, tab.url).href; } catch { return { ok: false, error: `Invalid URL: ${url}` }; }
          await chrome.tabs.update(tab.id, { url });
          await sleep(500);
          return (await this.waitForPageReady()) ? { ok: true } : { ok: false, error: `Page did not finish loading: ${url}` };
        }
        case 'reload': case 'goBack': case 'goForward': {
          const tab = await this.getActiveTab();
          if (!tab?.id) return { ok: false, error: 'No active tab' };
          await chrome.tabs[step.action](tab.id);
          await sleep(500);
          await this.waitForPageReady();
          return { ok: true };
        }
        case 'wait': await sleep(Math.min(step.ms, 30000)); return { ok: true };
        case 'waitLoad': await this.waitForPageReady(); return { ok: true };
        case 'assertURL': {
          const r = await this.pollTab(tab => matches(tab.url, step.expected, tab) !== step.negated);
          return r.ok ? { ok: true } : { ok: false, error: `URL is "${r.tab?.url}"` };
        }
        case 'assertTitle': {
          const r = await this.pollTab(tab => matches(tab.title, step.expected, tab) !== step.negated);
          return r.ok ? { ok: true } : { ok: false, error: `Title is "${r.tab?.title}"` };
        }
        default:
          return await this.execOnPage(step);
      }
    } catch (e) {
      return { ok: false, error: e.message };
    }
  },

  // Runs steps sequentially. onStep(index, status, detail, ms) fires per step:
  // status = 'running' | 'passed' | 'failed' | 'skipped' | 'stopped'
  async run(steps, onStep, controller = new RunController()) {
    const status = new Array(steps.length).fill(null);
    const set = (i, s, detail, ms) => { if (s !== 'running') status[i] = s; onStep(i, s, detail, ms); };

    for (let i = 0; i < steps.length; i++) {
      await controller.gate(i);
      if (controller.stopped) break;
      const step = steps[i];
      if (step.action === 'skip') { set(i, 'skipped', step.reason); controller.afterStep(); continue; }

      for (;;) {
        set(i, 'running');
        const t0 = Date.now();
        const res = await this.exec(steps[i]);
        const ms = Date.now() - t0;
        if (res.ok) { set(i, 'passed', null, ms); break; }
        set(i, 'failed', res.error, ms);
        if (controller.stopped || !controller.pauseOnFail) break;
        if (!(await controller.waitAfterFail(i))) break; // true = retry this step
      }
      if (controller.stopped) break;
      controller.afterStep();
    }
    for (let i = 0; i < steps.length; i++) if (status[i] === null) set(i, 'stopped');
    controller.finish();
    const count = (s) => status.filter(x => x === s).length;
    return { passed: count('passed'), failed: count('failed'), skipped: count('skipped') + count('stopped'), stopped: controller.stopped };
  }
};

// Debugger controls for TestRunner.run.
export class RunController {
  constructor({ startPaused = false, pauseOnFail = false } = {}) {
    this.paused = startPaused;
    this.pauseOnFail = pauseOnFail;
    this.stopped = false;
    this.finished = false;
    this.breakpoints = new Set();
    this.onPause = null;   // (index, { failed }) => void
    this.onResume = null;  // () => void
    this._stepOnce = false;
    this._retry = false;
    this._wake = null;
  }

  get waiting() { return !!this._wake; }

  pause() { if (!this.finished) this.paused = true; }
  resume() { this.paused = false; this._stepOnce = false; this._retry = false; this._release(); }
  step() { this.paused = false; this._stepOnce = true; this._retry = false; this._release(); }
  retry() { this._retry = true; this._release(); }
  stop() { this.stopped = true; this._release(); }
  toggleBreakpoint(i) {
    if (this.breakpoints.has(i)) this.breakpoints.delete(i); else this.breakpoints.add(i);
    return this.breakpoints.has(i);
  }

  _release() { const w = this._wake; this._wake = null; if (w) { this.onResume?.(); w(); } }
  _wait(i, info) {
    // register the waiter first so `waiting` is already true inside onPause
    const p = new Promise(r => { this._wake = r; });
    this.onPause?.(i, info);
    return p;
  }

  async gate(i) {
    if (this.breakpoints.has(i)) this.paused = true;
    if (this.paused && !this.stopped) await this._wait(i, { failed: false });
  }
  afterStep() { if (this._stepOnce) { this._stepOnce = false; this.paused = true; } }

  async waitAfterFail(i) {
    this._retry = false;
    await this._wait(i, { failed: true });
    const again = this._retry && !this.stopped;
    this._retry = false;
    return again;
  }
  finish() { this.finished = true; }
}
