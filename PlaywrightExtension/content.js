// Content script — recorder (codegen-style toolbar with assertions), locator
// picker, element inspector, and the Live test runner's in-page step executor.

(function () {
  'use strict';
  if (window.__pasContentLoaded) return;
  window.__pasContentLoaded = true;

  // mode: 'idle' | 'inspect' | 'pick' | 'assertVisible' | 'assertText' | 'assertValue'
  const state = { recording: false, paused: false, mode: 'idle', count: 0 };

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const jsStr = (s) => `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, '\\n')}'`;
  const cssStr = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

  function send(msg) {
    try { chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError); } catch { /* extension reloaded */ }
  }

  // ------------------------------------------------------------------
  // Accessibility helpers (shared by locator generation and resolution)
  // ------------------------------------------------------------------
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox',
    text: 'textbox', email: 'textbox', tel: 'textbox', url: 'textbox',
  };
  const TAG_ROLES = {
    BUTTON: 'button', TEXTAREA: 'textbox', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading',
    H5: 'heading', H6: 'heading', LI: 'listitem', UL: 'list', OL: 'list', NAV: 'navigation', MAIN: 'main',
    TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader', OPTION: 'option', DIALOG: 'dialog',
    ARTICLE: 'article', PROGRESS: 'progressbar',
  };

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit.trim().split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'IMG') return el.getAttribute('alt') === '' ? null : 'img';
    if (tag === 'SELECT') return (el.multiple || el.size > 1) ? 'listbox' : 'combobox';
    if (tag === 'INPUT') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'text' && el.hasAttribute('list')) return 'combobox';
      return INPUT_ROLES[type] || null;
    }
    return TAG_ROLES[tag] || null;
  }

  function accName(el) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const t = norm(labelledBy.split(/\s+/).map(id => document.getElementById(id)?.textContent || '').join(' '));
      if (t) return t;
    }
    const aria = norm(el.getAttribute('aria-label'));
    if (aria) return aria;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (tag === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
        return norm(el.value) || (el.type === 'submit' ? 'Submit' : el.type === 'reset' ? 'Reset' : '');
      }
      if (tag === 'INPUT' && el.type === 'image') return norm(el.alt) || norm(el.title);
      if (el.labels && el.labels.length) {
        const t = norm([...el.labels].map(l => l.textContent).join(' '));
        if (t) return t;
      }
      return norm(el.getAttribute('title')) || norm(el.getAttribute('placeholder'));
    }
    if (tag === 'IMG') return norm(el.getAttribute('alt')) || norm(el.getAttribute('title'));
    return norm(el.textContent) || norm(el.getAttribute('title'));
  }

  // matcher: { text, exact } | { regex, flags }. Default text match mirrors
  // Playwright: case-insensitive substring; exact = case-sensitive full match.
  function textMatches(actual, m) {
    if (m == null) return true;
    const a = norm(actual);
    if (m.regex != null) {
      try { return new RegExp(m.regex, m.flags || '').test(a); } catch { return false; }
    }
    const want = norm(m.text);
    if (m.exact) return a === want;
    return a.toLowerCase().includes(want.toLowerCase());
  }

  // Assertion matching is stricter than locator matching (case-sensitive).
  function expectMatches(actual, m, full) {
    if (m == null) return false;
    const a = norm(actual);
    if (m.regex != null) {
      try { return new RegExp(m.regex, m.flags || '').test(a); } catch { return false; }
    }
    const want = norm(m.text);
    return full ? a === want : a.includes(want);
  }

  // ------------------------------------------------------------------
  // Locator resolution. A locator is { chain: [segment...], raw }.
  // ------------------------------------------------------------------
  function all(root, sel) {
    try { return [...root.querySelectorAll(sel)]; } catch { return []; }
  }

  const NON_TEXT_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'HEAD', 'HTML', 'BODY', 'TEMPLATE']);

  function byText(root, m) {
    const hits = all(root, '*').filter(e => !NON_TEXT_TAGS.has(e.tagName) && e.id !== '__pas-root' && textMatches(e.textContent, m));
    const set = new Set(hits);
    // keep the deepest matching elements only
    return hits.filter(e => ![...e.children].some(c => set.has(c)));
  }

  function byLabel(root, m) {
    const out = new Set();
    all(root, '[aria-label]').forEach(e => { if (textMatches(e.getAttribute('aria-label'), m)) out.add(e); });
    all(root, '[aria-labelledby]').forEach(e => { if (textMatches(accName(e), m)) out.add(e); });
    all(root, 'label').forEach(l => {
      if (!textMatches(l.textContent, m)) return;
      const c = l.control || l.querySelector('input, textarea, select');
      if (c) out.add(c);
    });
    return [...out].sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
  }

  function byXPath(root, xpath) {
    try {
      const res = document.evaluate(xpath, root, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
      return out.filter(n => n.nodeType === 1);
    } catch { return []; }
  }

  function queryAll(root, seg) {
    switch (seg.m) {
      case 'locator': {
        const s = seg.selector || '';
        if (s.startsWith('text=')) {
          const body = s.slice(5);
          const quoted = /^"(.*)"$/.exec(body);
          return byText(root, quoted ? { text: quoted[1], exact: true } : { text: body });
        }
        if (s.startsWith('xpath=')) return byXPath(root, s.slice(6));
        if (s.startsWith('//') || s.startsWith('(//')) return byXPath(root, s);
        return all(root, s.startsWith('css=') ? s.slice(4) : s);
      }
      case 'getByTestId': return all(root, `[data-testid=${cssStr(seg.id)}]`);
      case 'getByPlaceholder': return all(root, '[placeholder]').filter(e => textMatches(e.getAttribute('placeholder'), seg.text));
      case 'getByAltText': return all(root, '[alt]').filter(e => textMatches(e.getAttribute('alt'), seg.text));
      case 'getByTitle': return all(root, '[title]').filter(e => textMatches(e.getAttribute('title'), seg.text));
      case 'getByRole': return all(root, '*').filter(e => roleOf(e) === seg.role && (!seg.name || textMatches(accName(e), seg.name)));
      case 'getByLabel': return byLabel(root, seg.text);
      case 'getByText': return byText(root, seg.text);
      default: return [];
    }
  }

  function resolveAll(locator) {
    let cur = null; // null = whole document
    for (const seg of locator.chain || []) {
      if (seg.m === 'nth') {
        const list = cur || [];
        const i = seg.index < 0 ? list.length + seg.index : seg.index;
        cur = list[i] ? [list[i]] : [];
      } else if (seg.m === 'filter') {
        cur = (cur || []).filter(e => textMatches(e.textContent, seg.hasText));
      } else {
        const roots = cur === null ? [document] : cur;
        const seen = new Set();
        cur = [];
        for (const r of roots) for (const e of queryAll(r, seg)) if (!seen.has(e)) { seen.add(e); cur.push(e); }
      }
    }
    return cur || [];
  }

  // ------------------------------------------------------------------
  // Locator generation
  // ------------------------------------------------------------------
  function segToJs(seg) {
    const opt = (m) => (m && m.exact ? ', { exact: true }' : '');
    switch (seg.m) {
      case 'getByRole':
        return `getByRole(${jsStr(seg.role)}${seg.name ? `, { name: ${jsStr(seg.name.text)}${seg.name.exact ? ', exact: true' : ''} }` : ''})`;
      case 'getByTestId': return `getByTestId(${jsStr(seg.id)})`;
      case 'getByText': case 'getByLabel': case 'getByPlaceholder': case 'getByAltText': case 'getByTitle':
        return `${seg.m}(${jsStr(seg.text.text)}${opt(seg.text)})`;
      case 'locator': return `locator(${jsStr(seg.selector)})`;
      case 'nth': return seg.index === 0 ? 'first()' : seg.index === -1 ? 'last()' : `nth(${seg.index})`;
      default: return '';
    }
  }
  const chainToJs = (chain) => chain.map(segToJs).join('.');

  const NAMED_ROLES = new Set(['button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'heading', 'searchbox',
    'tab', 'menuitem', 'option', 'switch', 'slider', 'spinbutton', 'img', 'listbox']);
  const goodId = (id) => id && !/\d{4,}/.test(id) && !/^[0-9]/.test(id) && id.length < 50 && !/[:.]/.test(id);

  function cssPath(el) {
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== document.documentElement && parts.length < 6) {
      if (goodId(cur.id)) { parts.unshift('#' + CSS.escape(cur.id)); break; }
      let part = cur.tagName.toLowerCase();
      const p = cur.parentElement;
      if (p) {
        const same = [...p.children].filter(c => c.tagName === cur.tagName);
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      cur = p;
    }
    return parts.join(' > ');
  }

  // Make a candidate resolve to exactly `el`: try exact text, then .nth(i).
  function makeUnique(c, el) {
    let els = resolveAll(c);
    if (els.length === 1 && els[0] === el) return c;
    if (!els.includes(el)) return null;
    const last = c.chain[c.chain.length - 1];
    const key = last.name ? 'name' : last.text ? 'text' : null;
    if (key && !last[key].exact) {
      const chain = [...c.chain.slice(0, -1), { ...last, [key]: { ...last[key], exact: true } }];
      const els2 = resolveAll({ chain });
      if (els2.length === 1 && els2[0] === el) return { ...c, chain };
      if (els2.includes(el) && els2.length < els.length) { c = { ...c, chain }; els = els2; }
    }
    return { ...c, chain: [...c.chain, { m: 'nth', index: els.indexOf(el) }], score: c.score - 20 };
  }

  function buildLocators(el) {
    const raw = [];
    const add = (strategy, score, seg) => raw.push({ strategy, score, chain: [seg] });
    const tag = el.tagName;
    const isField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';

    const testId = el.getAttribute('data-testid');
    if (testId) add('data-testid', 100, { m: 'getByTestId', id: testId });
    for (const attr of ['data-test', 'data-test-id', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr);
      if (v) add(attr, 95, { m: 'locator', selector: `[${attr}=${cssStr(v)}]` });
    }

    const role = roleOf(el);
    const name = accName(el);
    if (role && NAMED_ROLES.has(role) && name && name.length <= 80) add('role', 90, { m: 'getByRole', role, name: { text: name } });

    if (isField) {
      const label = norm(el.getAttribute('aria-label')) || (el.labels && el.labels.length ? norm(el.labels[0].textContent) : '');
      if (label && label.length <= 80) add('label', 85, { m: 'getByLabel', text: { text: label } });
      const ph = norm(el.getAttribute('placeholder'));
      if (ph) add('placeholder', 80, { m: 'getByPlaceholder', text: { text: ph } });
    }
    const alt = norm(el.getAttribute('alt'));
    if (alt) add('alt', 75, { m: 'getByAltText', text: { text: alt } });

    const text = norm(el.textContent);
    if (!isField && text && text.length <= 60 && el.children.length <= 3) add('text', 70, { m: 'getByText', text: { text } });

    const title = norm(el.getAttribute('title'));
    if (title) add('title', 65, { m: 'getByTitle', text: { text: title } });
    if (goodId(el.id)) add('id', 60, { m: 'locator', selector: '#' + CSS.escape(el.id) });
    const nameAttr = el.getAttribute('name');
    if (nameAttr) add('name', 55, { m: 'locator', selector: `${tag.toLowerCase()}[name=${cssStr(nameAttr)}]` });
    add('css', 20, { m: 'locator', selector: cssPath(el) });

    const out = [];
    for (const c of raw) {
      const u = makeUnique(c, el);
      if (u) out.push({ strategy: u.strategy, score: Math.max(u.score, 1), chain: u.chain, locator: chainToJs(u.chain) });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  let locCache = { el: null, best: null, ts: 0 };
  function bestLocator(el) {
    if (locCache.el === el && Date.now() - locCache.ts < 3000) return locCache.best;
    const tag = el.tagName.toLowerCase();
    const best = buildLocators(el)[0] || { strategy: 'css', score: 1, chain: [{ m: 'locator', selector: tag }], locator: `locator('${tag}')` };
    locCache = { el, best, ts: Date.now() };
    return best;
  }

  // Clicks on an icon/span inside a button should target the button.
  function actionTarget(el) {
    if (!(el instanceof Element)) return document.body;
    return el.closest('button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="checkbox"], [role="radio"], [role="option"], [role="switch"]') || el;
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    return {
      tag: el.tagName,
      id: el.id,
      text: norm(el.textContent).slice(0, 100),
      ariaLabel: el.getAttribute('aria-label'),
      role: roleOf(el),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      dataTestId: el.getAttribute('data-testid'),
      html: el.outerHTML.slice(0, 500),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      locators: buildLocators(el).map(l => ({ strategy: l.strategy, locator: l.locator, score: l.score, chain: l.chain })),
    };
  }

  // ------------------------------------------------------------------
  // In-page UI (shadow DOM so page CSS cannot touch it)
  // ------------------------------------------------------------------
  const UI_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: ui-monospace, Menlo, Consolas, monospace; }
    .hl { position: fixed; pointer-events: none; border: 2px solid #00d4aa; background: rgba(0,212,170,.12); border-radius: 3px; display: none; }
    .hl.assert { border-color: #ffb400; background: rgba(255,180,0,.14); }
    .hl-label { position: absolute; left: -2px; bottom: 100%; background: #00d4aa; color: #000; font-size: 11px; padding: 2px 6px; border-radius: 3px 3px 0 0; white-space: nowrap; max-width: 60vw; overflow: hidden; text-overflow: ellipsis; }
    .hl.assert .hl-label { background: #ffb400; }
    .hl.below .hl-label { bottom: auto; top: 100%; border-radius: 0 0 3px 3px; }
    .mon { position: fixed; top: 80px; left: 12px; width: 310px; max-height: 55vh; background: #1a1d23; color: #e6e6e6; border: 1px solid #00d4aa; border-radius: 8px; font-size: 11px; box-shadow: 0 4px 20px rgba(0,0,0,.5); overflow: hidden; display: flex; flex-direction: column; }
    .mon[hidden], .pop[hidden], .picked[hidden], .toast[hidden] { display: none; }
    .head { padding: 6px 10px; background: #00d4aa; color: #000; font-weight: bold; display: flex; justify-content: space-between; gap: 8px; cursor: move; user-select: none; }
    .tools { display: flex; gap: 4px; padding: 6px; border-bottom: 1px solid #2a2e36; flex-wrap: wrap; }
    button { background: #2a2e36; color: #e6e6e6; border: 1px solid #3a3f4a; border-radius: 4px; font-size: 11px; padding: 3px 7px; cursor: pointer; }
    button:hover { border-color: #00d4aa; }
    button.on { background: #00d4aa; color: #000; border-color: #00d4aa; }
    .picked { padding: 6px; border-bottom: 1px solid #2a2e36; display: flex; gap: 6px; align-items: center; }
    .picked code { flex: 1; color: #7ee0c8; word-break: break-all; }
    .list { overflow-y: auto; padding: 4px 8px; flex: 1; min-height: 20px; }
    .row { padding: 2px 0; border-bottom: 1px solid #2a2e36; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .row b { color: #00d4aa; font-weight: normal; }
    .row.assert b { color: #ffb400; }
    .row span { color: #9aa0aa; }
    .pop { position: fixed; background: #1a1d23; border: 1px solid #ffb400; border-radius: 6px; padding: 8px; width: 300px; box-shadow: 0 4px 20px rgba(0,0,0,.5); color: #e6e6e6; font-size: 11px; }
    .pop textarea { width: 100%; height: 54px; margin: 6px 0; background: #0f1115; color: #e6e6e6; border: 1px solid #3a3f4a; border-radius: 4px; font-size: 12px; padding: 4px; resize: vertical; }
    .pop .btns { display: flex; gap: 6px; justify-content: flex-end; }
    .toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #1a1d23; color: #e6e6e6; border: 1px solid #00d4aa; border-radius: 6px; padding: 6px 12px; font-size: 12px; }
  `;
  const TOOLS = [
    ['pick', '🎯 Pick'], ['assertVisible', '👁 Visible'], ['assertText', '🔤 Text'], ['assertValue', '✏ Value'],
  ];
  const MODE_HINT = {
    inspect: 'Inspect', pick: 'Pick locator', assertVisible: 'Assert visibility', assertText: 'Assert text', assertValue: 'Assert value',
  };

  let ui = null;
  let popupCtx = null;
  let lastHover = null;

  function ensureUI() {
    if (ui && ui.host.isConnected) return ui;
    const host = document.createElement('div');
    host.id = '__pas-root';
    host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647';
    const root = host.attachShadow({ mode: 'open' });
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(UI_CSS);
      root.adoptedStyleSheets = [sheet];
    } catch {
      const st = document.createElement('style');
      st.textContent = UI_CSS;
      root.appendChild(st);
    }
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="hl"><div class="hl-label"></div></div>
      <div class="mon" hidden>
        <div class="head"><span class="status">🔴 Recording</span><span class="count">0 actions</span></div>
        <div class="tools">${TOOLS.map(([m, label]) => `<button data-mode="${m}">${label}</button>`).join('')}</div>
        <div class="picked" hidden><code></code><button class="copy">Copy</button></div>
        <div class="list"></div>
      </div>
      <div class="pop" hidden>
        <div class="pop-title">Assert that element contains text</div>
        <textarea></textarea>
        <div class="btns"><button class="cancel">✖ Cancel</button><button class="ok on">✔ Accept</button></div>
      </div>
      <div class="toast" hidden></div>`;
    root.appendChild(wrap);
    (document.documentElement || document.body).appendChild(host);

    const q = (s) => root.querySelector(s);
    ui = { host, root, hl: q('.hl'), hlLabel: q('.hl-label'), mon: q('.mon'), status: q('.status'), count: q('.count'),
      list: q('.list'), picked: q('.picked'), pickedCode: q('.picked code'), pop: q('.pop'), popText: q('.pop textarea'), toast: q('.toast') };

    root.querySelectorAll('.tools button').forEach(b => b.addEventListener('click', () => {
      const m = b.getAttribute('data-mode');
      setMode(state.mode === m ? 'idle' : m);
    }));
    q('.copy').addEventListener('click', () => copyText(ui.pickedCode.textContent));

    const accept = () => {
      const ctx = popupCtx;
      const value = norm(ui.popText.value);
      if (ctx && value) recordEl('assertText', ctx.el, { value }, true);
      setMode('idle');
    };
    q('.pop .ok').addEventListener('click', accept);
    q('.pop .cancel').addEventListener('click', () => setMode('idle'));
    ui.popText.addEventListener('keydown', ev => {
      ev.stopPropagation();
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); accept(); }
      if (ev.key === 'Escape') setMode('idle');
    });

    // drag the monitor so it never blocks what is being tested
    let drag = null;
    q('.head').addEventListener('mousedown', e => {
      drag = { x: e.clientX - ui.mon.offsetLeft, y: e.clientY - ui.mon.offsetTop };
      e.preventDefault();
    });
    window.addEventListener('mousemove', e => {
      if (!drag) return;
      ui.mon.style.left = (e.clientX - drag.x) + 'px';
      ui.mon.style.top = (e.clientY - drag.y) + 'px';
    }, true);
    window.addEventListener('mouseup', () => { drag = null; }, true);
    return ui;
  }

  const inOwnUI = (e) => !!ui && e.composedPath().includes(ui.host);

  function copyText(text) {
    const fallback = () => {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch { /* ignore */ }
      ta.remove();
    };
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(fallback); else fallback();
    toast('Copied');
  }

  let toastTimer = null;
  function toast(text) {
    ensureUI();
    ui.toast.textContent = text;
    ui.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (ui) ui.toast.hidden = true; }, 1800);
  }

  function highlightElement(el, label) {
    ensureUI();
    const rect = el.getBoundingClientRect();
    Object.assign(ui.hl.style, { display: 'block', top: rect.top + 'px', left: rect.left + 'px', width: rect.width + 'px', height: rect.height + 'px' });
    ui.hl.classList.toggle('assert', state.mode.startsWith('assert'));
    ui.hl.classList.toggle('below', rect.top < 24);
    ui.hlLabel.textContent = label || '';
    ui.hlLabel.style.display = label ? 'block' : 'none';
  }
  function hideHighlight() { if (ui) ui.hl.style.display = 'none'; }
  let flashTimer = null;
  function flashHighlight(el, label, ms = 700) {
    highlightElement(el, label);
    clearTimeout(flashTimer);
    flashTimer = setTimeout(hideHighlight, ms);
  }

  function renderMonitor() {
    if (!state.recording) { if (ui) ui.mon.hidden = true; return; }
    ensureUI();
    ui.mon.hidden = false;
    ui.status.textContent = state.mode !== 'idle' ? `🎯 ${MODE_HINT[state.mode]} — click element (Esc cancels)`
      : state.paused ? '⏸ Paused' : '🔴 Recording';
    ui.count.textContent = `${state.count} actions`;
    ui.root.querySelectorAll('.tools button').forEach(b => b.classList.toggle('on', b.getAttribute('data-mode') === state.mode));
  }

  function monitorLog(action) {
    if (!ui) return;
    const row = document.createElement('div');
    row.className = 'row' + (action.type.startsWith('assert') ? ' assert' : '');
    const b = document.createElement('b');
    b.textContent = action.type;
    const s = document.createElement('span');
    s.textContent = ' ' + String(action.locator || action.url || action.key || '').slice(0, 70);
    row.append(b, s);
    ui.list.appendChild(row);
    ui.list.scrollTop = ui.list.scrollHeight;
  }

  function closePopup() {
    if (ui) ui.pop.hidden = true;
    popupCtx = null;
  }

  function setMode(mode) {
    state.mode = mode;
    lastHover = null;
    clearTimeout(flashTimer);
    hideHighlight();
    closePopup();
    renderMonitor();
    send({ type: 'REC_MODE', mode });
  }

  // ------------------------------------------------------------------
  // Recording
  // ------------------------------------------------------------------
  const isRec = () => state.recording && !state.paused && state.mode === 'idle';

  function recordAction(type, data, force) {
    if (!state.recording || (!force && state.paused)) return;
    const action = { type, ...data, ts: Date.now(), url: data?.url || location.href };
    state.count++;
    monitorLog(action);
    renderMonitor();
    send({ type: 'RECORDING_ACTION', action });
  }

  function recordEl(type, el, extra, force) {
    const best = bestLocator(el);
    recordAction(type, { selector: best.locator, locator: best.locator, loc: best.chain, strategy: best.strategy,
      text: norm(el.textContent).slice(0, 80), ...extra }, force);
  }

  const TEXT_INPUT_TYPES = new Set(['text', 'email', 'password', 'search', 'tel', 'url', 'number', 'date', 'time', 'datetime-local', 'month', 'week', 'color', 'range']);
  let labelForward = { control: null, ts: 0 };
  let lastEnterTs = 0;

  function onClick(e) {
    if (inOwnUI(e)) return;
    if (state.mode !== 'idle') {
      e.preventDefault(); e.stopImmediatePropagation();
      handlePointerPick(e.target);
      return;
    }
    if (!isRec() || !(e.target instanceof Element)) return;

    // click forwarded from a <label> to its control — the label click was already handled
    if (labelForward.control === e.target && Date.now() - labelForward.ts < 100) return;
    // Enter in a form field synthesizes a click on the submit button — the key press is recorded instead
    if (e.detail === 0 && Date.now() - lastEnterTs < 300) return;

    const label = e.target.closest('label');
    if (label && label.control && label.control !== e.target) {
      labelForward = { control: label.control, ts: Date.now() };
      if (['checkbox', 'radio'].includes(label.control.type)) return; // recorded as check/uncheck on change
    }
    const el = actionTarget(e.target);
    if (el.tagName === 'SELECT' || el.tagName === 'OPTION') return;
    if (el.tagName === 'INPUT' && ['checkbox', 'radio', 'file'].includes(el.type)) return;
    recordEl('click', el);
  }

  function onInput(e) {
    if (inOwnUI(e) || !isRec()) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && TEXT_INPUT_TYPES.has((el.getAttribute('type') || 'text').toLowerCase()))) {
      recordEl('fill', el, { value: el.value });
    } else if (el.isContentEditable) {
      recordEl('fill', el, { value: el.innerText });
    }
  }

  function onChange(e) {
    if (inOwnUI(e) || !isRec()) return;
    const el = e.target;
    if (!(el instanceof Element)) return;
    if (el.tagName === 'INPUT' && el.type === 'checkbox') recordEl(el.checked ? 'check' : 'uncheck', el);
    else if (el.tagName === 'INPUT' && el.type === 'radio') recordEl('check', el);
    else if (el.tagName === 'SELECT') recordEl('select', el, { value: el.value });
  }

  function onKeyDown(e) {
    if (inOwnUI(e)) return;
    if (state.mode !== 'idle' && e.key === 'Escape') {
      e.preventDefault(); e.stopImmediatePropagation();
      setMode('idle');
      return;
    }
    if (!isRec() || !['Enter', 'Tab', 'Escape'].includes(e.key)) return;
    const el = e.target instanceof Element ? e.target : null;
    if (e.key === 'Enter' && el?.tagName === 'TEXTAREA') return; // newline is part of the fill value
    if (e.key === 'Enter') lastEnterTs = Date.now();
    if (el && el !== document.body && el !== document.documentElement) recordEl('press', el, { key: e.key });
    else recordAction('press', { key: e.key });
  }

  // In pick/assert modes the page must not react to the pointer at all.
  // A checkbox/radio is pre-toggled while its click event is dispatched (and only
  // restored after preventDefault), so its real state is captured on pointer down.
  let preCheck = { el: null, checked: false };
  function blockPointer(e) {
    if (state.mode === 'idle' || inOwnUI(e)) return;
    if ((e.type === 'pointerdown' || e.type === 'mousedown') && e.target instanceof Element) {
      const el = actionTarget(e.target);
      const control = el.tagName === 'INPUT' ? el : e.target.closest('label')?.control;
      if (control && 'checked' in control) preCheck = { el: control, checked: control.checked };
    }
    e.preventDefault(); e.stopImmediatePropagation();
  }

  function onMouseMove(e) {
    if (state.mode === 'idle' || inOwnUI(e) || !(e.target instanceof Element)) return;
    if (ui && !ui.pop.hidden) return;
    const el = actionTarget(e.target);
    if (el === lastHover) return;
    lastHover = el;
    highlightElement(el, bestLocator(el).locator);
  }

  function openTextPopup(el, initial) {
    ensureUI();
    popupCtx = { el };
    ui.popText.value = initial;
    const rect = el.getBoundingClientRect();
    ui.pop.style.top = Math.max(8, Math.min(rect.bottom + 8, window.innerHeight - 150)) + 'px';
    ui.pop.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - 310)) + 'px';
    ui.pop.hidden = false;
    ui.popText.focus();
    ui.popText.select();
  }

  function handlePointerPick(rawTarget) {
    if (!(rawTarget instanceof Element)) return;
    const el = actionTarget(rawTarget);
    const mode = state.mode;

    if (mode === 'inspect') {
      send({ type: 'ELEMENT_INSPECTED', elementInfo: getElementInfo(el) });
      return; // inspector keeps inspecting until stopped
    }
    const best = bestLocator(el);
    if (mode === 'pick') {
      send({ type: 'LOCATOR_PICKED', locator: best.locator, loc: best.chain, elementInfo: getElementInfo(el) });
      setMode('idle');
      if (state.recording) {
        ui.pickedCode.textContent = `page.${best.locator}`;
        ui.picked.hidden = false;
      }
      flashHighlight(el, best.locator, 1200);
      return;
    }
    if (!state.recording) { setMode('idle'); return; }

    if (mode === 'assertVisible') {
      recordEl('assertVisible', el, {}, true);
      setMode('idle');
    } else if (mode === 'assertText') {
      const isField = ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
      const text = norm(isField ? '' : el.textContent);
      if (!text) { toast('Element has no text — use ✏ Value for inputs'); return; }
      highlightElement(el, best.locator);
      openTextPopup(el, text.slice(0, 200));
    } else if (mode === 'assertValue') {
      if (el.tagName === 'INPUT' && ['checkbox', 'radio'].includes(el.type)) {
        recordEl('assertChecked', el, { checked: preCheck.el === el ? preCheck.checked : el.checked }, true);
      } else if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
        recordEl('assertValue', el, { value: el.value }, true);
      } else {
        toast('Not an input — use 🔤 Text for this element');
        return;
      }
      setMode('idle');
    }
  }

  // Listeners live for the page lifetime and check state — cheaper and safer
  // than add/remove bookkeeping across modes.
  window.addEventListener('click', onClick, true);
  window.addEventListener('input', onInput, true);
  window.addEventListener('change', onChange, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('mousemove', onMouseMove, true);
  for (const type of ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'auxclick', 'contextmenu']) {
    window.addEventListener(type, blockPointer, true);
  }

  function startRecording({ resume = false, paused = false, count = 0 } = {}) {
    state.recording = true;
    state.paused = paused;
    state.mode = 'idle';
    state.count = count;
    ensureUI();
    if (!resume) {
      ui.list.textContent = '';
      ui.picked.hidden = true;
      // the generated test needs page.goto() as its first step
      recordAction('navigate', { url: location.href });
    }
    renderMonitor();
  }

  function stopRecording() {
    state.recording = false;
    state.paused = false;
    state.mode = 'idle';
    hideHighlight();
    closePopup();
    renderMonitor();
  }

  // ------------------------------------------------------------------
  // Live runner: step execution with auto-wait and strict mode
  // ------------------------------------------------------------------
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }
  const isDisabled = (el) => !!el.disabled || el.getAttribute('aria-disabled') === 'true';

  function setNativeValue(el, value) {
    if (el.isContentEditable) {
      el.textContent = value;
    } else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
        : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value); else el.value = value;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function mouseSequence(el, types) {
    const r = el.getBoundingClientRect();
    const init = { bubbles: true, cancelable: true, composed: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 };
    for (const t of types) {
      const Ctor = t.startsWith('pointer') && window.PointerEvent ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(t, init));
    }
  }

  function pressKey(el, key) {
    const init = { key, code: key.length === 1 ? `Key${key.toUpperCase()}` : key, bubbles: true, cancelable: true, composed: true };
    const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
    if (proceed) {
      if (key === 'Enter') {
        if (el.tagName === 'INPUT' && el.form) {
          const submit = el.form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
          if (submit) submit.click(); else el.form.requestSubmit();
        } else if (el.tagName === 'BUTTON' || el.tagName === 'A' || el.getAttribute('role') === 'button') {
          el.click();
        }
      } else if (key === 'Tab') {
        const focusable = all(document, 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])')
          .filter(x => !isDisabled(x) && isVisible(x));
        const next = focusable[focusable.indexOf(el) + 1] || focusable[0];
        next?.focus();
      }
    }
    el.dispatchEvent(new KeyboardEvent('keyup', init));
  }

  const strictError = (locator, n) =>
    `strict mode violation: ${locator.raw} resolved to ${n} elements — make it unique or add .first()`;

  async function runAction(step, timeout) {
    let el = null;
    if (step.locator) {
      const deadline = Date.now() + timeout;
      let reason = '';
      for (;;) {
        const els = resolveAll(step.locator);
        if (els.length > 1) return { ok: false, error: strictError(step.locator, els.length) };
        el = els[0] || null;
        const needsEnabled = !['hover', 'focus', 'waitFor', 'scrollIntoView'].includes(step.action);
        if (!el) reason = 'Element not found';
        else if (!isVisible(el)) reason = 'Element not visible';
        else if (needsEnabled && isDisabled(el)) reason = 'Element is disabled';
        else break;
        if (Date.now() > deadline) return { ok: false, error: `${reason}: ${step.locator.raw} (waited ${timeout}ms)` };
        await sleep(100);
      }
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
      flashHighlight(el, null);
    } else {
      el = document.activeElement || document.body;
    }

    switch (step.action) {
      case 'click':
        mouseSequence(el, ['pointerdown', 'mousedown']);
        if (typeof el.focus === 'function') el.focus();
        mouseSequence(el, ['pointerup', 'mouseup']);
        el.click();
        return { ok: true };
      case 'dblclick':
        el.click(); el.click();
        mouseSequence(el, ['dblclick']);
        return { ok: true };
      case 'hover':
        mouseSequence(el, ['pointerover', 'mouseover', 'mouseenter', 'mousemove']);
        return { ok: true };
      case 'focus':
        el.focus();
        return { ok: true };
      case 'waitFor':
      case 'scrollIntoView':
        return { ok: true };
      case 'fill':
      case 'clear':
        if (el.tagName === 'SELECT') return { ok: false, error: 'fill() cannot be used on a <select> — use selectOption()' };
        if (!('value' in el) && !el.isContentEditable) return { ok: false, error: `Element is not an input, textarea or contenteditable: ${step.locator.raw}` };
        el.focus();
        setNativeValue(el, step.action === 'clear' ? '' : (step.value ?? ''));
        return { ok: true };
      case 'type':
        if (typeof el.focus === 'function') el.focus();
        if ('value' in el) setNativeValue(el, (el.value || '') + (step.value ?? ''));
        else if (el.isContentEditable) setNativeValue(el, (el.textContent || '') + (step.value ?? ''));
        else return { ok: false, error: 'No editable element is focused' };
        return { ok: true };
      case 'press':
        if (typeof el.focus === 'function' && step.locator) el.focus();
        pressKey(el, step.value || 'Enter');
        return { ok: true };
      case 'check':
      case 'uncheck': {
        const want = step.action === 'check';
        const cur = 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true';
        if (cur !== want) el.click();
        return { ok: true };
      }
      case 'selectOption': {
        if (el.tagName !== 'SELECT') return { ok: false, error: `Element is not a <select>: ${step.locator.raw}` };
        const opt = [...el.options].find(o => o.value === step.value) || [...el.options].find(o => norm(o.textContent) === norm(step.value));
        if (!opt) return { ok: false, error: `Option "${step.value}" not found in ${step.locator.raw}` };
        setNativeValue(el, opt.value);
        return { ok: true };
      }
      default:
        return { ok: false, error: `Unsupported action: ${step.action}` };
    }
  }

  function evalAssert(step) {
    const els = resolveAll(step.locator);
    const a = step.assertion;
    if (a === 'toHaveCount') {
      return { pass: els.length === Number(step.expected?.text), msg: `Expected ${step.expected?.text} elements, found ${els.length}` };
    }
    if (els.length > 1) return { pass: false, hard: true, msg: strictError(step.locator, els.length) };
    const el = els[0];
    if (a === 'toBeVisible') return { pass: !!el && isVisible(el), msg: el ? 'Element is not visible' : 'Element not found' };
    if (a === 'toBeHidden') return { pass: !el || !isVisible(el), msg: 'Element is visible' };
    if (a === 'toBeAttached') return { pass: !!el, msg: 'Element not found' };
    if (!el) return { pass: false, hard: true, msg: 'Element not found' };

    const text = norm(el.textContent);
    const show = (s) => `"${String(s).slice(0, 80)}"`;
    const want = step.expected?.regex != null ? `/${step.expected.regex}/${step.expected.flags || ''}` : show(step.expected?.text ?? '');
    switch (a) {
      case 'toContainText': return { pass: expectMatches(text, step.expected, false), msg: `Text is ${show(text)}, expected to contain ${want}` };
      case 'toHaveText': return { pass: expectMatches(text, step.expected, true), msg: `Text is ${show(text)}, expected ${want}` };
      case 'toHaveValue': {
        const v = el.value ?? '';
        const pass = step.expected?.regex != null ? expectMatches(v, step.expected, true) : v === (step.expected?.text ?? '');
        return { pass, msg: `Value is ${show(v)}, expected ${want}` };
      }
      case 'toBeEnabled': return { pass: !isDisabled(el), msg: 'Element is disabled' };
      case 'toBeDisabled': return { pass: isDisabled(el), msg: 'Element is enabled' };
      case 'toBeChecked': {
        const checked = 'checked' in el ? !!el.checked : el.getAttribute('aria-checked') === 'true';
        return { pass: checked, msg: `Element is ${checked ? 'checked' : 'not checked'}` };
      }
      case 'toBeFocused': return { pass: document.activeElement === el, msg: 'Element is not focused' };
      case 'toBeEditable': return { pass: !isDisabled(el) && !el.readOnly, msg: 'Element is not editable' };
      case 'toBeEmpty': return { pass: 'value' in el ? !el.value : !text, msg: 'Element is not empty' };
      case 'toHaveAttribute': {
        const attr = step.expected?.text;
        const actual = el.getAttribute(attr);
        if (actual === null) return { pass: false, msg: `Attribute "${attr}" is missing` };
        if (!step.expected2) return { pass: true, msg: `Attribute "${attr}" is present` };
        const pass = step.expected2.regex != null ? expectMatches(actual, step.expected2, true) : actual === step.expected2.text;
        return { pass, msg: `Attribute "${attr}" is ${show(actual)}` };
      }
      default: return { pass: false, hard: true, fatal: true, msg: `Unsupported assertion: ${a}` };
    }
  }

  async function runAssert(step, timeout) {
    const deadline = Date.now() + timeout;
    let res;
    for (;;) {
      res = evalAssert(step);
      if (res.fatal) break;
      // a missing/ambiguous element fails whether or not the assertion is negated
      const ok = res.hard ? false : res.pass !== !!step.negated;
      if (ok) {
        const el = resolveAll(step.locator)[0];
        if (el && isVisible(el)) flashHighlight(el, null);
        return { ok: true };
      }
      if (Date.now() > deadline) break;
      await sleep(100);
    }
    const prefix = step.negated && !res.hard ? `Expected NOT ${step.assertion}, but it held` : res.msg;
    return { ok: false, error: `${prefix} — ${step.locator.raw}` };
  }

  async function runStep(step) {
    const timeout = step.timeout ?? 5000;
    return step.action === 'assert' ? runAssert(step, timeout) : runAction(step, timeout);
  }

  // ------------------------------------------------------------------
  // Messages
  // ------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'START_RECORDING':
        startRecording(msg);
        sendResponse({ ok: true });
        break;
      case 'PAUSE_RECORDING':
        state.paused = true;
        if (state.mode !== 'idle') setMode('idle'); else renderMonitor();
        sendResponse({ ok: true });
        break;
      case 'RESUME_RECORDING':
        state.paused = false; renderMonitor();
        sendResponse({ ok: true });
        break;
      case 'STOP_RECORDING':
        stopRecording();
        sendResponse({ ok: true });
        break;

      case 'SET_MODE': // recorder tools driven from the side panel
        if (msg.mode !== 'idle' && msg.mode !== 'pick' && !state.recording) {
          sendResponse({ ok: false, error: 'Start recording first' });
        } else {
          setMode(msg.mode);
          sendResponse({ ok: true });
        }
        break;
      case 'START_PICK':
        setMode('pick');
        sendResponse({ ok: true });
        break;
      case 'STOP_PICK':
        if (state.mode === 'pick') setMode('idle');
        sendResponse({ ok: true });
        break;
      case 'START_INSPECT':
        setMode('inspect');
        sendResponse({ ok: true });
        break;
      case 'STOP_INSPECT':
        if (state.mode === 'inspect') setMode('idle');
        sendResponse({ ok: true });
        break;

      case 'HIGHLIGHT': {
        const els = resolveAll(msg.locator);
        if (els[0]) {
          els[0].scrollIntoView({ block: 'center', behavior: 'instant' });
          flashHighlight(els[0], msg.locator.raw || '', 1500);
        }
        sendResponse({ ok: true, count: els.length });
        break;
      }
      case 'GET_ELEMENT_AT': {
        const el = document.elementFromPoint(msg.x, msg.y);
        sendResponse(el ? getElementInfo(el) : null);
        break;
      }
      case 'GET_PAGE_INFO':
        sendResponse({ url: location.href, title: document.title, readyState: document.readyState });
        break;

      case 'RUN_STEP':
        runStep(msg.step).then(sendResponse, e => sendResponse({ ok: false, error: e.message }));
        break;

      default:
        sendResponse({ error: `Unknown message: ${msg.type}` });
    }
    return true;
  });

  // A full page navigation wipes this script's state. Ask the service worker
  // whether this tab is mid-recording and pick up where the last page left off.
  try {
    chrome.runtime.sendMessage({ type: 'CONTENT_READY' }, (resp) => {
      if (chrome.runtime.lastError || !resp?.recording) return;
      startRecording({ resume: true, paused: resp.paused, count: resp.count });
    });
  } catch { /* extension reloaded */ }
})();
