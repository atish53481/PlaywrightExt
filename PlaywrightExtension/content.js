// Content script — handles DOM recording, inspection, and element highlighting

(function() {
  'use strict';
  // Raised with every change to this file: after the extension is reloaded, a page still holds
  // the script it was given before, and that one no longer reaches the extension.
  const VERSION = 5;
  if (window.__pasContentLoaded === VERSION) return;
  window.__pasContentLoaded = VERSION;

  let isRecording = false;
  let isPaused = false;
  let isInspecting = false;
  let highlightOverlay = null;
  let recordedActions = [];
  // The element of the hover recorded last, so resting on it is recorded once.
  let lastHovered = null;
  // How many steps the recording held before this page loaded, for the count in the monitor.
  let earlierActions = 0;

  // The page itself, or a frame inside it. A frame records its own steps; the page shows the
  // monitor, answers the side panel, and records where the tab goes.
  const isTop = window === window.top;

  // Every element under `root` that the selector matches, those in shadow trees among them,
  // in the order of the page: Playwright's locators look inside a shadow tree too.
  function deepAll(root, selector) {
    const found = [...root.querySelectorAll(selector)];
    const hosts = [...root.querySelectorAll('*')].filter(e => e.shadowRoot);
    if (hosts.length === 0) return found;
    // An element in a shadow tree stands where its host stands.
    const lift = (e) => {
      const chain = [e];
      for (let tree = e.getRootNode(); tree instanceof ShadowRoot; tree = tree.host.getRootNode()) chain.unshift(tree.host);
      return chain;
    };
    return [...found, ...hosts.flatMap(host => deepAll(host.shadowRoot, selector))].sort((a, b) => {
      const x = lift(a), y = lift(b);
      for (let i = 0; ; i += 1) {
        if (x[i] === y[i]) continue;
        if (!x[i]) return -1;
        if (!y[i]) return 1;
        return x[i].compareDocumentPosition(y[i]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1;
      }
    });
  }

  // The element an event happened on: inside a shadow tree, the event names only the tree's host.
  function targetOf(e) {
    const first = e.composedPath?.()[0];
    return first instanceof Element ? first : e.target;
  }

  // The frameLocator(...) calls that lead from the page to this frame, '' in the page itself.
  function framePrefix() {
    const call = (selector) => `frameLocator('${selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}').`;
    const attr = (value) => value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let prefix = '';
    try {
      for (let win = window; win !== win.top; win = win.parent) {
        const frame = win.frameElement;
        const doc = frame.ownerDocument;
        const tag = frame.tagName.toLowerCase();
        const told = frame.id && /^[A-Za-z][\w-]*$/.test(frame.id) ? `#${frame.id}`
          : ['name', 'title', 'data-testid', 'src'].map(name => [name, frame.getAttribute(name)])
            .filter(([name, value]) => value && value.length <= 120 && doc.querySelectorAll(`${tag}[${name}="${attr(value)}"]`).length === 1)
            .map(([name, value]) => `${tag}[${name}="${attr(value)}"]`)[0];
        const same = [...doc.querySelectorAll(tag)];
        prefix = call(told || (same.length === 1 ? tag : `${tag} >> nth=${same.indexOf(frame)}`)) + prefix;
      }
    } catch {
      // A frame from another site cannot see the <iframe> it is in: it is told by its address.
      prefix = call(`iframe[src*="${attr(location.host + (location.pathname.length > 1 ? location.pathname : ''))}"]`) + prefix;
    }
    return prefix;
  }

  // --- Element Highlighting ---
  function createOverlay() {
    if (highlightOverlay) return;
    highlightOverlay = document.createElement('div');
    highlightOverlay.id = '__pas-highlight';
    Object.assign(highlightOverlay.style, {
      position: 'fixed', pointerEvents: 'none', zIndex: '2147483647',
      border: '2px solid #00d4aa', background: 'rgba(0,212,170,0.1)',
      borderRadius: '3px', transition: 'all 0.1s ease', display: 'none'
    });
    const label = document.createElement('div');
    label.id = '__pas-label';
    Object.assign(label.style, {
      position: 'absolute', top: '-24px', left: '0', background: '#00d4aa',
      color: '#000', fontSize: '11px', fontFamily: 'monospace', padding: '2px 6px',
      borderRadius: '3px 3px 0 0', whiteSpace: 'nowrap', maxWidth: '300px', overflow: 'hidden'
    });
    highlightOverlay.appendChild(label);
    document.body.appendChild(highlightOverlay);
  }

  function highlightElement(el) {
    if (!highlightOverlay) createOverlay();
    const rect = el.getBoundingClientRect();
    Object.assign(highlightOverlay.style, {
      display: 'block', top: rect.top + 'px', left: rect.left + 'px',
      width: rect.width + 'px', height: rect.height + 'px'
    });
    const label = document.getElementById('__pas-label');
    if (label) label.textContent = getBestLocatorText(el);
  }

  function hideHighlight() {
    if (highlightOverlay) highlightOverlay.style.display = 'none';
  }

  // --- Locator Generation ---
  function getBestLocatorText(el) {
    if (el.getAttribute('data-testid')) return `[data-testid="${el.getAttribute('data-testid')}"]`;
    if (el.getAttribute('aria-label')) return `[aria-label="${el.getAttribute('aria-label')}"]`;
    if (el.getAttribute('placeholder')) return `[placeholder="${el.getAttribute('placeholder')}"]`;
    if (el.id) return `#${el.id}`;
    if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;
    // text="..." matches the whole text, so it is used only when the whole text is short.
    const text = visibleText(el);
    if (text && text.length <= 40 && !/["\n]/.test(text)) return `text="${text}"`;
    return cssFor(el);
  }

  // The text a user sees. textContent also holds the source of <script> and <style> tags.
  function visibleText(el) {
    return (el.innerText ?? el.textContent ?? '').trim();
  }

  // A CSS path from the nearest ancestor with an id, for an element with nothing better to go by.
  function cssPath(el) {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && node !== document.documentElement; node = node.parentElement) {
      if (node.id && /^[A-Za-z][\w-]*$/.test(node.id)) { parts.unshift(`#${node.id}`); break; }
      const tag = node.tagName.toLowerCase();
      const sameTag = node.parentElement ? [...node.parentElement.children].filter(c => c.tagName === node.tagName) : [];
      parts.unshift(sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag);
    }
    return parts.join(' > ') || 'html';
  }

  // A class name that says what an element is. One with a number in it is often made by a
  // build, and one that tells the state of the element (active, open) is gone the next time.
  const STATE_CLASS = /(^|[-_])(active|focus(ed)?|hover(ed)?|selected|open(ed)?|show(n)?|hidden|hide|disabled|error|invalid|valid|visited|checked|current|loading|expanded|collapsed)($|[-_])/i;

  // The element by its tag and its own class names, or '' when it has none to go by.
  function classSelector(node) {
    const names = [...node.classList].filter(name => /^[A-Za-z][A-Za-z_-]*$/.test(name) && !STATE_CLASS.test(name)).slice(0, 2);
    return names.length ? `${node.tagName.toLowerCase()}.${names.join('.')}` : '';
  }

  // The CSS for an element with no role, label, or text to go by. It says what the element is
  // called, alone or inside a named part of the page, so it still finds the element after a
  // <div> is added or removed around it. The path of every step down is the last resort.
  function cssFor(el) {
    const only = (selector) => deepAll(document, selector).length === 1;
    const own = classSelector(el);
    if (own && only(own)) return own;
    const leaf = own || el.tagName.toLowerCase();
    for (let node = el.parentElement, depth = 0; node && node !== document.body && depth < 6; node = node.parentElement, depth += 1) {
      const around = node.id && /^[A-Za-z][\w-]*$/.test(node.id) ? `#${node.id}` : classSelector(node);
      if (around && only(`${around} ${leaf}`)) return `${around} ${leaf}`;
    }
    return cssPath(el);
  }

  // The parts of a page a person names to say where something is: a row, an item of a list,
  // a dialog, a card, a group of fields.
  const CONTAINERS = 'tr, li, [role="row"], [role="listitem"], [role="dialog"], dialog, article, [role="article"], fieldset, [role="group"], [role="region"], [role="tabpanel"], [role="menu"], [role="listbox"], section, form, nav, table, [role="table"], [role="grid"], ul, ol';

  // The locator of a row, an item, or a card that has no name of its own: its role or its tag,
  // and a short text that only it holds ("the row that says Ada Lovelace").
  function containerLocator(box, root = document) {
    const role = roleOf(box);
    const peers = role
      ? [...deepAll(root, '*')].filter(e => roleOf(e) === role && e.getClientRects().length > 0)
      : [...deepAll(root, box.tagName.toLowerCase())];
    const base = role ? `getByRole('${role}')` : `locator('${box.tagName.toLowerCase()}')`;
    if (peers.length === 1) return base;
    const texts = [...box.querySelectorAll('*')].filter(e => e.children.length === 0).map(e => tidy(visibleText(e)))
      .filter(text => text.length >= 2 && text.length <= 40)
      // A word is a better name than a number: a count or a date changes.
      .sort((a, b) => /\d/.test(a) - /\d/.test(b));
    const told = texts.find(text => peers.filter(p => tidy(visibleText(p)).toLowerCase().includes(text.toLowerCase())).length === 1);
    return told ? `${base}.filter({ hasText: '${told.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' })` : null;
  }

  // For an element that many others look like (the Delete button of every row): the part of
  // the page it is in, then the element inside it, as a tester would say it.
  function scopedLocator(el) {
    const own = (list) => list.filter(l => l.matches === 1 && !l.strategy.endsWith('-nth')).sort((a, b) => b.score - a.score)[0];
    const named = (box) => own(locatorsFor(box))?.locator || containerLocator(box);
    // A row that is told from the other rows of its own table only: the table, then the row.
    const within = (box) => {
      const around = box.parentElement?.closest(CONTAINERS);
      const outer = around && named(around);
      const inner = outer && containerLocator(box, around);
      return inner ? outer + "." + inner : null;
    };
    for (let box = el.parentElement?.closest(CONTAINERS), depth = 0; box && depth < 4; box = box.parentElement?.closest(CONTAINERS), depth += 1) {
      const inside = own(locatorsFor(el, box));
      if (!inside) continue;
      const outer = named(box) || within(box);
      if (outer) return `${outer}.${inside.locator}`;
    }
    return null;
  }

  // The locators of an element, each with the number of elements it finds inside `root`.
  function locatorsFor(el, root = document) {
    const locators = [];

    // How many elements on the page a locator would match. A recorded step must match one:
    // Playwright refuses to click a locator that matches several.
    const sameAttr = (attr) => {
      const value = el.getAttribute(attr);
      return [...deepAll(root, `[${attr}]`)].filter(e => e.getAttribute(attr) === value).length;
    };
    // The value sits inside '...' in the generated code, and inside "..." in an attribute selector.
    const quote = (value) => String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const attrLocator = (attr) => `locator('[${attr}="${quote(el.getAttribute(attr)).replace(/"/g, '\\\\"')}"]')`;

    // In Playwright's order of preference: role, label, placeholder, text, alt text, title,
    // test id, and CSS last.
    // A name is matched as Playwright matches it: anywhere in the text, whatever the case.
    const shown = (e) => e === el || e.getClientRects().length > 0;
    const ours = (e) => (monitorPanel && monitorPanel.contains(e)) || (highlightOverlay && highlightOverlay.contains(e));
    const holding = (elements, nameOf, name) => elements.filter(e => nameOf(e).toLowerCase().includes(name.toLowerCase()));

    // A locator and the elements it finds. One that finds several is offered again with the
    // place of this element among them (.first(), .nth(2)): less sure than a locator of its
    // own, but it still says what the element is, where a CSS path says only where it sits.
    // A text with a number of three digits or more in it (an order number, a total, a date) is
    // data: it is another one the next time, so a locator made of it counts for less.
    const steady = (words, score) => (/\d{3,}/.test(words) ? score - 45 : score);
    const add = (strategy, locator, score, found, at = found.indexOf(el)) => {
      locators.push({ strategy, locator, score, matches: found.length });
      if (found.length > 1 && at >= 0) {
        locators.push({ strategy: `${strategy}-nth`, locator: `${locator}${at === 0 ? '.first()' : `.nth(${at})`}`, score: 20 + score / 10, matches: 1 });
      }
    };

    // 1. getByRole: the role the element declares or its tag implies, with its accessible name.
    const role = roleOf(el);
    if (role) {
      const name = accessibleName(el, role);
      const peers = [...deepAll(root, '*')].filter(e => roleOf(e) === role && shown(e));
      const nameOf = (e) => accessibleName(e, role);
      if (!name) {
        // A role with no name says little: an id or a test attribute is surer.
        add('role', `getByRole('${quote(role)}')`, 45, peers);
      } else if (name.length <= 80) {
        const loose = holding(peers, nameOf, name);
        // A name that is part of another element's name ("Save" and "Save all") is asked for exactly.
        if (loose.length === 1) add('role', `getByRole('${quote(role)}', { name: '${quote(name)}' })`, steady(name, 100), loose);
        else add('role', `getByRole('${quote(role)}', { name: '${quote(name)}', exact: true })`, steady(name, 100), peers.filter(e => nameOf(e) === name));
      }
    }

    // 2. getByLabel: the text of the field's <label>, or its aria-label.
    const labelOf = (e) => tidy(e.labels?.length ? e.labels[0].textContent : e.getAttribute('aria-label'));
    const label = labelOf(el);
    if (label && label.length <= 80) {
      const labelled = [...deepAll(root, 'input, textarea, select, button, meter, output, progress, [aria-label]')].filter(shown);
      add('label', `getByLabel('${quote(label)}')`, 90, holding(labelled, labelOf, label));
    }

    // 3. getByPlaceholder
    const placeholder = tidy(el.getAttribute('placeholder'));
    if (placeholder) {
      const fields = [...deepAll(root, '[placeholder]')].filter(shown);
      add('placeholder', `getByPlaceholder('${quote(placeholder)}')`, 80, holding(fields, e => tidy(e.getAttribute('placeholder')), placeholder));
    }

    // 4. getByText: the element's own short text. getByText finds the innermost element that
    // holds the text: an element around another one that holds it is passed over, so the
    // <span> and the <li> around a <p> do not make its text ambiguous.
    const whole = tidy(visibleText(el));
    const text = tidy(visibleText(el).split('\n')[0].slice(0, 50));
    if (text && (['BUTTON','A','LABEL'].includes(el.tagName) || el.children.length === 0)) {
      const textFinds = (wanted, exact) => {
        const lower = wanted.toLowerCase();
        const holders = [...deepAll(root, '*:not(script):not(style)')].filter(e => {
          if (ours(e) || !shown(e) || !tidy(e.textContent).toLowerCase().includes(lower)) return false;
          const own = tidy(visibleText(e));
          return exact ? own === wanted : own.toLowerCase().includes(lower);
        });
        return holders.filter(e => !holders.some(other => other !== e && e.contains(other)));
      };
      const place = (found) => found.findIndex(e => e === el || el.contains(e));
      const loose = textFinds(text, false);
      // A text that is part of another element's text ("Log" and "Logout") is asked for exactly.
      const exact = loose.length !== 1 && whole === text ? textFinds(text, true) : [];
      if (exact.length > 0 && place(exact) >= 0) add('text', `getByText('${quote(text)}', { exact: true })`, steady(text, 70), exact, place(exact));
      else if (place(loose) >= 0) add('text', `getByText('${quote(text)}')`, steady(text, 70), loose, place(loose));
    }

    // 5. getByAltText, for an image, and getByTitle.
    const alt = el.matches('img, area, input[type="image"]') ? tidy(el.getAttribute('alt')) : '';
    if (alt) add('alt', `getByAltText('${quote(alt)}')`, 65, holding([...deepAll(root, '[alt]')].filter(shown), e => tidy(e.getAttribute('alt')), alt));
    const title = tidy(el.getAttribute('title'));
    if (title && title.length <= 80) add('title', `getByTitle('${quote(title)}')`, 62, holding([...deepAll(root, '[title]')].filter(shown), e => tidy(e.getAttribute('title')), title));

    // 6. getByTestId: data-testid is the attribute Playwright reads unless it is configured otherwise.
    // An attribute put there for tests is the surest of all: it is first when the element has one.
    if (el.getAttribute('data-testid')) locators.push({ strategy: 'data-testid', locator: `getByTestId('${quote(el.getAttribute('data-testid'))}')`, score: 110, matches: sameAttr('data-testid') });
    for (const attr of ['data-test', 'data-test-id', 'data-cy', 'data-qa', 'data-automation-id']) {
      if (el.getAttribute(attr)) locators.push({ strategy: attr, locator: attrLocator(attr), score: 105, matches: sameAttr(attr) });
    }

    // 7. CSS, the last resort: the id, the name, the address of a link with no name (an icon), and a short selector.
    const href = el.tagName === "A" ? el.getAttribute("href") : "";
    if (href && href.length > 1 && href.length <= 80 && !/^javascript:/i.test(href)) locators.push({ strategy: "href", locator: "locator('a" + attrLocator("href").slice(9), score: 47, matches: sameAttr("href") });
    if (el.id) {
      // An id with characters that mean something in a selector is matched as an attribute.
      const simple = /^[A-Za-z][\w-]*$/.test(el.id);
      locators.push({ strategy: 'id', locator: simple ? `locator('#${el.id}')` : attrLocator('id'), score: 50, matches: sameAttr('id') });
    }
    if (el.getAttribute('name')) locators.push({ strategy: 'name', locator: attrLocator('name'), score: 40, matches: sameAttr('name') });
    return locators;
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const locators = locatorsFor(el);
    if (!locators.some(l => l.matches === 1 && !l.strategy.endsWith('-nth'))) {
      const scoped = scopedLocator(el);
      if (scoped) locators.push({ strategy: 'scoped', locator: scoped, score: 48, matches: 1 });
    }
    // Last resort, so every recorded step has a locator that matches one element.
    locators.push({ strategy: 'css', locator: `locator('${cssFor(el).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}')`, score: 10, matches: 1 });

    return {
      tag: el.tagName,
      id: el.id,
      text: el.textContent?.trim().slice(0, 100),
      ariaLabel: el.getAttribute('aria-label'),
      role: el.getAttribute('role'),
      type: el.getAttribute('type'),
      placeholder: el.getAttribute('placeholder'),
      dataTestId: el.getAttribute('data-testid'),
      html: el.outerHTML.slice(0, 500),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
      // A locator that matches one element comes before any that matches several.
      locators: locators.sort((a, b) => (a.matches === 1 ? 0 : 1) - (b.matches === 1 ? 0 : 1) || b.score - a.score)
    };
  }

  // --- Recording Monitor (codegen-style floating panel, left side of page) ---
  let monitorPanel = null;

  function createMonitor() {
    if (monitorPanel || !isTop) return;
    monitorPanel = document.createElement('div');
    monitorPanel.id = '__pas-monitor';
    Object.assign(monitorPanel.style, {
      position: 'fixed', top: '80px', left: '12px', width: '300px', maxHeight: '50vh',
      zIndex: '2147483646', background: '#1a1d23', color: '#e6e6e6',
      border: '1px solid #00d4aa', borderRadius: '8px', fontFamily: 'monospace',
      fontSize: '11px', boxShadow: '0 4px 20px rgba(0,0,0,0.5)', overflow: 'hidden',
      display: 'flex', flexDirection: 'column'
    });
    monitorPanel.innerHTML = `
      <div id="__pas-monitor-head" style="padding:6px 10px;background:#00d4aa;color:#000;font-weight:bold;display:flex;justify-content:space-between;align-items:center;cursor:move">
        <span>🔴 Recording</span><span id="__pas-monitor-count">0 actions</span>
      </div>
      <div id="__pas-monitor-list" style="overflow-y:auto;padding:4px 8px;flex:1"></div>`;
    document.body.appendChild(monitorPanel);

    // Drag support so the panel never blocks what the user is testing
    const head = monitorPanel.querySelector('#__pas-monitor-head');
    let drag = null;
    head.addEventListener('mousedown', e => {
      drag = { x: e.clientX - monitorPanel.offsetLeft, y: e.clientY - monitorPanel.offsetTop };
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!drag) return;
      monitorPanel.style.left = (e.clientX - drag.x) + 'px';
      monitorPanel.style.top = (e.clientY - drag.y) + 'px';
    });
    document.addEventListener('mouseup', () => { drag = null; });
  }

  function monitorLog(action) {
    if (!monitorPanel) return;
    const list = monitorPanel.querySelector('#__pas-monitor-list');
    const count = monitorPanel.querySelector('#__pas-monitor-count');
    const row = document.createElement('div');
    row.style.cssText = 'padding:2px 0;border-bottom:1px solid #2a2e36;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
    const detail = action.selector || action.url || action.key || '';
    row.innerHTML = `<span style="color:#00d4aa">${action.type}</span> <span style="color:#9aa0aa">${detail.replace(/</g, '&lt;').slice(0, 60)}</span>`;
    list.appendChild(row);
    list.scrollTop = list.scrollHeight;
    if (count) count.textContent = `${earlierActions + recordedActions.length} actions`;
  }

  function setMonitorState(text) {
    const head = monitorPanel?.querySelector('#__pas-monitor-head span');
    if (head) head.textContent = text;
  }

  function removeMonitor() {
    monitorPanel?.remove();
    monitorPanel = null;
  }

  // --- Recording ---
  function recordAction(type, data) {
    if (!isRecording || isPaused) return;
    // Any other step ends the wait for the page to answer a click on a plain part of it.
    dropHeldClick();
    const action = { type, ...data, ts: Date.now(), url: location.href };
    if (!isTop) {
      // A step in a frame is found through the frame; the address of the tab is the page's to tell.
      const frame = framePrefix();
      if (action.locator) action.locator = frame + action.locator;
      if (action.selector) action.selector = `${frame}${action.selector}`;
      if (action.target?.locator) action.target = { ...action.target, locator: frame + action.target.locator };
      delete action.url;
    }
    recordedActions.push(action);
    monitorLog(action);
    chrome.runtime.sendMessage({ type: 'RECORDING_ACTION', action });
    // After any other step, resting on the same element again is a new hover.
    if (type !== 'hover') lastHovered = null;
  }

  // --- A click on a plain part of the page ---
  // A <div> that is not made to be clicked may still have a handler the recorder cannot see.
  // Its click is held for a moment, and is a step when the page answers it: something new is
  // shown, or the page is left. A click the page does not answer is dropped.
  const HELD_CLICK_MS = 700;
  let heldClick = null;

  function holdClick(target) {
    dropHeldClick();
    const info = getElementInfo(target);
    heldClick = {
      data: { selector: getBestLocatorText(target), locator: info.locators[0]?.locator, elementInfo: info },
      timer: setTimeout(dropHeldClick, HELD_CLICK_MS),
    };
  }

  function dropHeldClick() {
    clearTimeout(heldClick?.timer);
    heldClick = null;
  }

  function keepHeldClick() {
    if (!heldClick) return;
    const { data } = heldClick;
    dropHeldClick();
    recordAction('click', data);
  }

  // --- Dialogs ---
  // alert(), confirm(), and prompt() run in the page's own world, where page-hooks.js tells
  // what was shown and how it was answered. The step is the answer: Playwright gives it
  // before the step that brings the dialog up.
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.data?.__pas !== 'dialog') return;
    const { kind, message, result } = e.data;
    recordAction('dialog', {
      kind: String(kind), message: String(message ?? '').slice(0, 200),
      accept: result !== false && result !== null,
      text: kind === 'prompt' && typeof result === 'string' ? result.slice(0, 500) : undefined,
    });
  });

  // Where a recorded step happens: the selector and the best locator of the element.
  function where(el) {
    return { selector: getBestLocatorText(el), locator: getElementInfo(el).locators[0]?.locator };
  }

  // --- Hover recording ---
  // A hover is recorded only when it does something. Either the pointer rests on an element
  // whose :hover style shows or hides another element (a menu made with CSS), or the page
  // changes right after the pointer arrives (a menu or a popover opened by script). Every
  // other movement of the mouse is left out, or a recording would be nothing but hovers.
  const HOVER_REST_MS = 250;
  const HOVER_EFFECT_MS = 600;
  const SHOWN_BY = ['display', 'visibility', 'opacity', 'height', 'max-height', 'clip', 'clip-path', 'pointer-events'];
  // The :hover rules that show or hide another element, each { host, shown }: the selector of
  // the hovered element, and of what the rule styles, written from that element (":scope > .items").
  let hoverHosts = [];
  let hover = null;        // the element the pointer is on: { el, host, at, timer, done }
  let pageWatcher = null;

  // Adds to `into` the rules of a stylesheet that show or hide another element on :hover.
  function collectHoverHosts(rules, into) {
    for (const rule of rules) {
      if (rule.cssRules?.length) collectHoverHosts(rule.cssRules, into);
      const text = rule.selectorText;
      if (!text || !text.includes(':hover') || !SHOWN_BY.some(property => rule.style?.getPropertyValue(property))) continue;
      for (const selector of text.split(',')) {
        const at = selector.indexOf(':hover');
        if (at < 0) continue;
        // Only a rule that styles another element than the hovered one: ".menu:hover .items".
        const rest = /^([^\s>+~]*)(\s*[>+~]\s*|\s+)([\s\S]*\S)\s*$/.exec(selector.slice(at + 6));
        if (!rest) continue;
        const lead = selector.slice(0, at);
        const host = `${lead.trim()}${/[\s>+~]$/.test(lead) ? ' *' : lead.trim() ? '' : '*'}${rest[1]}`;
        const combinator = rest[2].trim();
        const target = rest[3].replace(/:hover/g, '');
        // What is shown is looked for inside the hovered element; next to it, it is taken as there.
        const shown = combinator === '+' || combinator === '~' ? null : `:scope ${combinator} ${target}`;
        // A selector cut out of a list may not be a selector on its own.
        try {
          document.querySelector(host);
          if (shown) document.documentElement.querySelector(shown);
        } catch { continue; }
        if (into.length < 500 && !into.some(entry => entry.host === host && entry.shown === shown)) into.push({ host, shown });
      }
    }
  }

  function findHoverHosts() {
    hoverHosts = [];
    for (const sheet of document.styleSheets) {
      try {
        collectHoverHosts(sheet.cssRules, hoverHosts);
      } catch {
        // The rules of a stylesheet from another site cannot be read in the page: the
        // extension fetches its text, and the rules are read from that.
        if (!/^https?:/i.test(sheet.href || '')) continue;
        chrome.runtime.sendMessage({ type: 'FETCH_CSS', url: sheet.href }, (answer) => {
          void chrome.runtime.lastError;
          if (!answer?.css || !isRecording) return;
          try {
            const copy = new CSSStyleSheet();
            copy.replaceSync(answer.css);
            collectHoverHosts(copy.cssRules, hoverHosts);
          } catch { /* not a stylesheet */ }
        });
      }
    }
  }

  // The innermost element around `el` whose :hover shows or hides something that is there, or null.
  function hoverHostOf(el) {
    let found = null;
    for (const { host, shown } of hoverHosts) {
      for (let candidate = el.closest(host); candidate; candidate = candidate.parentElement?.closest(host)) {
        if (shown ? !candidate.querySelector(shown) : !candidate.nextElementSibling) continue;
        if (!found || found.contains(candidate)) found = candidate;
        break;
      }
    }
    return found;
  }

  function recordHover() {
    if (!hover || hover.done) return;
    clearTimeout(hover.timer);
    hover.done = true;
    if (hover.el === lastHovered || !hover.el.isConnected) return;
    recordAction('hover', where(hover.el));
    lastHovered = hover.el;
  }

  // A click or a key ends the hover the pointer is in: what the page does next is not its doing.
  function endHover() {
    if (!hover) return;
    clearTimeout(hover.timer);
    hover.done = true;
  }

  function onMouseOver(e) {
    if (!isRecording || isPaused) return;
    const el = e.target;
    if (!(el instanceof Element) || el === document.documentElement || el === document.body) return;
    if (monitorPanel && monitorPanel.contains(el)) return;
    const host = hoverHostOf(el);
    // The pointer on an icon inside a button is on the button.
    const actionable = el.closest(HOVERABLE);
    const target = actionable && (!host || host.contains(actionable)) ? actionable : el;
    // Still inside the same hovered part of the page.
    if (hover && (host ? hover.host === host : hover.el === target)) return;
    clearTimeout(hover?.timer);
    hover = { el: target, host, at: Date.now(), timer: null, done: false };
    if (host) hover.timer = setTimeout(recordHover, HOVER_REST_MS);
  }

  // The page changed. When that happens right after the pointer came to rest on an element,
  // the hover caused it.
  function onPageChange(records) {
    // Something new is shown after a click on a plain part of the page: the click did it.
    if (heldClick && isRecording && !isPaused && records.some(record => [...record.addedNodes].some(node => node.nodeType === 1
      && node.getClientRects().length > 0 && !(monitorPanel && monitorPanel.contains(node)) && !(highlightOverlay && highlightOverlay.contains(node))))) keepHeldClick();
    if (!isRecording || isPaused || !hover || hover.done || hover.timer) return;
    // A page that is still loading changes under a pointer that only rests there: a hover
    // opens something only on an element made to be pointed at.
    if (!hover.el.matches(HOVERABLE) && getComputedStyle(hover.el).cursor !== 'pointer') return;
    if (Date.now() - hover.at > HOVER_EFFECT_MS) return;
    const ours = (node) => (monitorPanel && monitorPanel.contains(node)) || (highlightOverlay && highlightOverlay.contains(node));
    // What a page adds to its <head> when a link is hovered (a prefetch) shows nothing.
    // Nor does a class or a style set on the whole page, as scrolling does.
    const unseen = (node) => node === document.documentElement || node === document.body || document.head?.contains(node)
      || /^(LINK|SCRIPT|STYLE|META|TITLE|NOSCRIPT)$/.test(node.tagName);
    const shows = records.some(record => !ours(record.target) && !unseen(record.target)
      && (record.type === 'attributes' || [...record.addedNodes].some(node => node.nodeType === 1 && !ours(node) && !unseen(node))));
    if (!shows) return;
    // Recorded once the pointer has rested, so sweeping over the page records nothing.
    hover.timer = setTimeout(recordHover, Math.max(0, HOVER_REST_MS - (Date.now() - hover.at)));
  }

  function onMouseMove(e) {
    if (isInspecting) highlightElement(e.target);
  }

  function onClick(e) {
    if (monitorPanel && monitorPanel.contains(e.target)) return;
    if (isInspecting) {
      e.preventDefault();
      e.stopPropagation();
      const info = getElementInfo(e.target);
      chrome.runtime.sendMessage({ type: 'ELEMENT_INSPECTED', elementInfo: info });
      return;
    }
    if (isRecording && !isPaused) {
      // A click on an icon or a span inside a button is a click on the button.
      const target = targetOf(e).closest?.(ACTIONABLE) || targetOf(e);
      // A click on the page background does nothing a test could repeat.
      if (target === document.documentElement || target === document.body) return;
      // Nor does a click on a part of the page that is not there to be clicked: the gap
      // between two fields of a form, the padding of a panel.
      if (!isClickable(target)) { holdClick(target); return; }
      // A click on something a hover brought out: the hover comes first, even when the
      // pointer did not rest on it for long.
      if (hover && !hover.done && hover.el !== target && (hover.timer || hover.host?.contains(target))) recordHover();
      endHover();
      // Opening the file chooser is not a step: the files chosen are recorded when they are.
      if (target.matches('input[type="file"]')) return;
      // By the time the click is seen, a checkbox already has its new state.
      if (target.matches('input[type="checkbox"], input[type="radio"]')) {
        recordAction(target.checked ? 'check' : 'uncheck', where(target));
        return;
      }
      const info = getElementInfo(target);
      recordAction('click', { selector: getBestLocatorText(target), locator: info.locators[0]?.locator, elementInfo: info });
    }
  }

  const ACTIONABLE = 'button, a, input, select, textarea, label, summary, [role="button"], [role="link"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="radio"], [role="option"]';
  const HOVERABLE = `${ACTIONABLE}, [aria-haspopup]`;
  const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"]';

  // Whether a click on the element is a step. It is when the element is made to be clicked (a
  // control, an element with a role or a handler, one the page shows a hand over), or when it holds nothing but its own short text, like a row of a
  // menu. A <form> or a <div> that only holds other elements is clicked by accident.
  function isClickable(el) {
    if (el.matches(ACTIONABLE) || el.matches('[onclick], [tabindex]') || el.isContentEditable || INTERACTIVE_ROLES.includes(roleOf(el))) return true;
    if (getComputedStyle(el).cursor === 'pointer') return true;
    const text = tidy(visibleText(el));
    return el.children.length === 0 && text.length > 0 && text.length <= 80;
  }

  // The element a mouse step is recorded on, or null for the recorder's own panel and the page background.
  function stepTarget(e) {
    if (!isRecording || isPaused || !(targetOf(e) instanceof Element)) return null;
    if (monitorPanel && monitorPanel.contains(e.target)) return null;
    const target = targetOf(e).closest(ACTIONABLE) || targetOf(e);
    return target === document.documentElement || target === document.body ? null : target;
  }

  function onDblClick(e) {
    const target = stepTarget(e);
    if (target) recordAction('dblclick', where(target));
  }

  function onContextMenu(e) {
    const target = stepTarget(e);
    if (!target) return;
    endHover();
    recordAction('rightClick', where(target));
  }

  function onInput(e) {
    const el = targetOf(e);
    if (!isRecording || isPaused || !(el instanceof Element) || el.value === undefined) return;
    if (monitorPanel && monitorPanel.contains(el)) return;
    // A checkbox is recorded when it is clicked, a file when it is chosen: neither can be filled.
    if (el.matches('input[type="checkbox"], input[type="radio"], input[type="file"]')) return;
    endHover();
    recordAction(el.tagName === 'SELECT' ? 'select' : 'fill', { ...where(el), value: el.value });
  }

  function onChange(e) {
    const el = e.target;
    if (!isRecording || isPaused || !(el instanceof Element) || !el.matches('input[type="file"]')) return;
    if (el.files?.length) recordAction('upload', { ...where(el), files: [...el.files].map(file => file.name) });
  }

  // --- Drag and drop ---
  let dragged = null;

  function onDragStart(e) {
    dragged = isRecording && !isPaused && e.target instanceof Element ? e.target : null;
  }

  function onDrop(e) {
    const from = dragged;
    dragged = null;
    if (!from || !isRecording || isPaused || !(e.target instanceof Element) || e.target === from) return;
    recordAction('drag', { ...where(from), target: where(e.target) });
  }

  // The keys that are steps of their own. A letter typed in a field is part of the field's value.
  const STEP_KEYS = ['Enter', 'Tab', 'Escape', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown'];
  // These move the caret or change the text inside a field, and are steps only outside one.
  const CARET_KEYS = ['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Backspace', 'Delete'];

  function onKeyDown(e) {
    if (!isRecording || isPaused || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(e.key)) return;
    // AltGr is how some keyboards type a character.
    if (e.getModifierState?.('AltGraph')) return;
    const editable = e.target instanceof Element && e.target.matches(EDITABLE);
    const modifiers = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta'].filter(Boolean);
    let key = null;
    if (modifiers.length > 0) {
      // Copy, paste, select all, and undo inside a field end up in its value, recorded as a fill.
      if (!(editable && /^[acvxyz]$/i.test(e.key))) {
        key = [...modifiers, e.shiftKey && 'Shift', e.key.length === 1 ? e.key.toLowerCase() : e.key].filter(Boolean).join('+');
      }
    } else if (STEP_KEYS.includes(e.key) || (!editable && CARET_KEYS.includes(e.key))) {
      key = e.shiftKey ? `Shift+${e.key}` : e.key;
    }
    if (!key) return;
    endHover();
    recordAction('press', { key });
  }

  // What is listened to while recording, all before the page's own handlers.
  const RECORDED_EVENTS = [
    ['click', onClick], ['dblclick', onDblClick], ['contextmenu', onContextMenu], ['input', onInput], ['change', onChange],
    ['keydown', onKeyDown], ['mouseover', onMouseOver], ['dragstart', onDragStart], ['drop', onDrop],
  ];

  function listenForSteps() {
    for (const [name, handler] of RECORDED_EVENTS) document.addEventListener(name, handler, true);
    findHoverHosts();
    hover = null;
    lastHovered = null;
    pageWatcher = new MutationObserver(onPageChange);
    pageWatcher.observe(document.documentElement, {
      subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'style', 'hidden', 'open', 'aria-expanded', 'aria-hidden'],
    });
  }

  function stopListeningForSteps() {
    for (const [name, handler] of RECORDED_EVENTS) document.removeEventListener(name, handler, true);
    pageWatcher?.disconnect();
    pageWatcher = null;
    clearTimeout(hover?.timer);
    hover = null;
  }

  // --- Test Runner: locator resolution + step execution ---
  const IMPLICIT_ROLES = {
    button: 'button, input[type="button"], input[type="submit"], [role="button"]',
    link: 'a[href], [role="link"]',
    textbox: 'input:not([type]), input[type="text"], input[type="email"], input[type="password"], input[type="search"], input[type="tel"], input[type="url"], textarea, [role="textbox"]',
    checkbox: 'input[type="checkbox"], [role="checkbox"]',
    radio: 'input[type="radio"], [role="radio"]',
    combobox: 'select, [role="combobox"]',
    heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
    alert: '[role="alert"]',
    img: 'img, [role="img"]',
    list: 'ul, ol, [role="list"]',
    listitem: 'li, [role="listitem"]',
  };

  const tidy = (text) => String(text ?? '').replace(/\s+/g, ' ').trim();

  // The roles of the tags that give a page its structure.
  const STRUCTURE_ROLES = {
    LI: 'listitem', UL: 'list', OL: 'list', TABLE: 'table', TR: 'row', TD: 'cell', TH: 'columnheader',
    NAV: 'navigation', MAIN: 'main', ARTICLE: 'article', DIALOG: 'dialog', FIELDSET: 'group', PROGRESS: 'progressbar',
  };
  // The roles of what is there to be acted on.
  const INTERACTIVE_ROLES = ['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'option', 'tab',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'slider', 'spinbutton', 'treeitem', 'gridcell', 'row', 'cell'];

  // The ARIA role of an element: the one it declares, or the one its tag implies. '' for none.
  function roleOf(el) {
    const declared = tidy(el.getAttribute('role')).split(' ')[0];
    if (declared) return declared;
    const tag = el.tagName;
    if (tag === 'BUTTON') return 'button';
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : '';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'OPTION') return 'option';
    if (/^H[1-6]$/.test(tag)) return 'heading';
    if (tag === 'IMG') return el.getAttribute('alt') ? 'img' : '';
    if (STRUCTURE_ROLES[tag]) return STRUCTURE_ROLES[tag];
    // A form or a section is a landmark only when it has a name.
    if (tag === 'FORM' || tag === 'SECTION') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? (tag === 'FORM' ? 'form' : 'region') : '';
    if (tag !== 'INPUT') return '';
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    if (['button', 'submit', 'reset', 'image'].includes(type)) return 'button';
    if (type === 'checkbox' || type === 'radio') return type;
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    if (type === 'hidden' || type === 'file') return '';
    if (['text', 'email', 'tel', 'url'].includes(type) && el.hasAttribute('list')) return 'combobox';
    // Every other field is a text box to Playwright, a password or a date field among them.
    return 'textbox';
  }

  // The roles whose name is the text inside the element. A text box is not one of them: its
  // text is its value.
  const NAMED_BY_CONTENT = ['button', 'link', 'heading', 'checkbox', 'radio', 'option', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'switch', 'treeitem', 'cell', 'gridcell', 'columnheader', 'rowheader', 'tooltip'];

  // The name assistive technology, and getByRole, know an element by.
  function accessibleName(el, role = roleOf(el)) {
    const labelledBy = tidy(el.getAttribute('aria-labelledby')).split(' ').map(id => id && document.getElementById(id)).filter(Boolean);
    if (labelledBy.length) return tidy(labelledBy.map(node => node.textContent).join(' '));
    const label = tidy(el.getAttribute('aria-label'));
    if (label) return label;
    if (el.labels && el.labels.length) return tidy(el.labels[0].textContent);
    if (el.tagName === 'INPUT' && ['submit', 'button', 'reset'].includes(el.type)) return tidy(el.value) || (el.type === 'button' ? '' : el.type === 'submit' ? 'Submit' : 'Reset');
    if (el.tagName === 'IMG' || (el.tagName === 'INPUT' && el.type === 'image')) return tidy(el.getAttribute('alt'));
    const content = NAMED_BY_CONTENT.includes(role) ? tidy(visibleText(el)) : '';
    return content || tidy(el.getAttribute('title')) || tidy(el.getAttribute('placeholder'));
  }

  // Every element a locator finds, in the order of the page.
  function resolveAll(locator, root = document) {
    const { method, value, name, exact } = locator;
    const all = (selector) => [...deepAll(root, selector)];
    const has = (text) => exact ? tidy(text) === value : tidy(text).toLowerCase().includes(value.toLowerCase());
    const innermost = (found) => found.filter(el => !found.some(other => other !== el && el.contains(other)));
    // The elements that are shown, when any is: Playwright's engines pass over the rest.
    const seen = (found) => {
      const visible = found.filter(el => el.getClientRects().length > 0);
      return visible.length ? visible : found;
    };
    const nameMatches = (el) => {
      if (!name) return true;
      const own = accessibleName(el, value);
      return exact ? own === name : own.toLowerCase().includes(name.toLowerCase());
    };

    switch (method) {
      case 'locator': {
        // Playwright's text engine: text="Exact text" or text=part of the text
        const text = /^text=([\s\S]*)$/.exec(value);
        if (!text) return all(value);
        const whole = /^"([\s\S]*)"$/.exec(text[1]);
        const wanted = (whole ? whole[1] : text[1]).trim().toLowerCase();
        return innermost(all('*:not(script):not(style)').filter(el => {
          const own = visibleText(el).toLowerCase();
          return whole ? own === wanted : own.includes(wanted);
        }));
      }
      case 'getByTestId':
        return all('[data-testid]').filter(el => el.getAttribute('data-testid') === value);
      case 'getByPlaceholder': {
        const same = all('[placeholder]').filter(el => el.getAttribute('placeholder') === value);
        return same.length ? same : all('[placeholder]').filter(el => has(el.getAttribute('placeholder')));
      }
      case 'getByAltText':
        return seen(all('[alt]').filter(el => has(el.getAttribute('alt'))));
      case 'getByTitle':
        return seen(all('[title]').filter(el => has(el.getAttribute('title'))));
      case 'getByRole': {
        // The role as the recorder reads it, and the wider list kept for tests written by hand.
        const byRole = seen(all('*').filter(el => roleOf(el) === value)).filter(nameMatches);
        return byRole.length ? byRole : all(IMPLICIT_ROLES[value] || `[role="${value}"]`).filter(nameMatches);
      }
      case 'getByLabel': {
        const byAria = all('[aria-label]').filter(el => has(el.getAttribute('aria-label')));
        const byLabel = all('label').filter(l => has(l.textContent))
          .map(l => l.control || (l.htmlFor ? document.getElementById(l.htmlFor) : l.querySelector('input, textarea, select')))
          .filter(Boolean);
        return seen([...new Set([...byAria, ...byLabel])])
          .sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
      }
      case 'getByText':
        // The innermost element that holds the text, as Playwright finds it.
        return innermost(seen(all('*:not(script):not(style)').filter(el => has(el.textContent))));
      default:
        return [];
    }
  }

  // The element a step acts on: the first the locator finds, or the one .first(), .last(),
  // or .nth() asks for.
  // A chain (a row, then the button in it) is followed part by part: each part is looked for
  // inside what the part before it found.
  function resolveLocator(locator) {
    const narrow = (found, part) => {
      const kept = part.hasText ? found.filter(el => tidy(visibleText(el)).toLowerCase().includes(part.hasText.toLowerCase())) : found;
      if (part.pick === null || part.pick === undefined) return kept;
      return [kept[part.pick === 'last' ? kept.length - 1 : part.pick]].filter(Boolean);
    };
    let found = narrow(resolveAll(locator), locator);
    for (const part of locator.then || []) {
      found = narrow([...new Set(found.flatMap(root => resolveAll(part, root)))], part);
    }
    return found[0] || null;
  }

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function flashHighlight(el) {
    highlightElement(el);
    setTimeout(hideHighlight, 700);
  }

  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value); else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function runStep(step) {
    const el = resolveLocator(step.locator);
    if (!el) return { ok: false, error: `Element not found: ${step.locator.raw}` };

    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    flashHighlight(el);

    switch (step.action) {
      case 'click':
      case 'dblclick':
        // click({ button: 'right' }) opens the context menu and clicks nothing.
        if (step.value === 'right') {
          el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
          return { ok: true };
        }
        el.click();
        if (step.action === 'dblclick') el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return { ok: true };
      case 'hover':
        // What a script can do: it reaches the page's own handlers, but not a :hover style.
        for (const name of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove']) {
          el.dispatchEvent(new MouseEvent(name, { bubbles: !name.endsWith('enter') }));
        }
        return { ok: true };
      case 'fill':
        setNativeValue(el, step.value ?? '');
        return { ok: true };
      case 'clear':
        setNativeValue(el, '');
        return { ok: true };
      case 'press': {
        const key = step.value || 'Enter';
        el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        if (key === 'Enter' && el.form) el.form.requestSubmit();
        return { ok: true };
      }
      case 'check':
      case 'uncheck':
        if (el.checked !== (step.action === 'check')) el.click();
        return { ok: true };
      case 'selectOption':
        setNativeValue(el, step.value ?? '');
        return { ok: true };
      case 'assert': {
        const negated = step.negated;
        const fail = (msg) => ({ ok: false, error: msg });
        switch (step.assertion) {
          case 'toBeVisible':
            return isVisible(el) !== negated ? { ok: true } : fail(`Element ${negated ? 'visible but expected hidden' : 'not visible'}: ${step.locator.raw}`);
          case 'toBeHidden':
            return !isVisible(el) !== negated ? { ok: true } : fail(`Element visibility mismatch: ${step.locator.raw}`);
          case 'toContainText':
          case 'toHaveText': {
            const has = (el.textContent || '').toLowerCase().includes((step.expected || '').toLowerCase());
            return has !== negated ? { ok: true } : fail(`Text is "${(el.textContent || '').trim().slice(0, 80)}", expected ${negated ? 'NOT ' : ''}"${step.expected}"`);
          }
          case 'toHaveValue':
            return (el.value === step.expected) !== negated ? { ok: true } : fail(`Value is "${el.value}", expected "${step.expected}"`);
          case 'toBeEnabled':
            return !el.disabled !== negated ? { ok: true } : fail(`Element disabled state mismatch: ${step.locator.raw}`);
          case 'toBeDisabled':
            return !!el.disabled !== negated ? { ok: true } : fail(`Element disabled state mismatch: ${step.locator.raw}`);
          default:
            return fail(`Unsupported assertion: ${step.assertion}`);
        }
      }
      default:
        return { ok: false, error: `Unsupported action: ${step.action}` };
    }
  }

  // --- Message Handler ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    // A frame starts and stops recording with the page, and leaves every answer to the page.
    if (!isTop) {
      if (!['START_RECORDING', 'PAUSE_RECORDING', 'RESUME_RECORDING', 'STOP_RECORDING'].includes(msg.type)) return false;
      sendResponse = () => {};
    }
    switch (msg.type) {
      case 'START_RECORDING':
        isRecording = true; isPaused = false; recordedActions = []; earlierActions = 0;
        // Capture the starting URL — the generated test needs page.goto() as its first step
        if (isTop) recordAction('navigate', { url: location.href });
        listenForSteps();
        createMonitor();
        setMonitorState('🔴 Recording');
        sendResponse({ ok: true });
        break;

      case 'PAUSE_RECORDING':
        isPaused = true;
        setMonitorState('⏸ Paused');
        sendResponse({ ok: true, actions: recordedActions });
        break;

      case 'RESUME_RECORDING':
        isPaused = false;
        setMonitorState('🔴 Recording');
        sendResponse({ ok: true });
        break;

      case 'STOP_RECORDING':
        // Where the tab is when the recording ends: the last step is checked against it.
        if (isTop) recordAction('end', {});
        isRecording = false;
        stopListeningForSteps();
        removeMonitor();
        sendResponse({ ok: true, actions: recordedActions });
        recordedActions = [];
        break;

      case 'START_INSPECT':
        isInspecting = true;
        createOverlay();
        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('click', onClick, true);
        sendResponse({ ok: true });
        break;

      case 'STOP_INSPECT':
        isInspecting = false;
        hideHighlight();
        document.removeEventListener('mousemove', onMouseMove);
        document.removeEventListener('click', onClick, true);
        sendResponse({ ok: true });
        break;

      case 'GET_ELEMENT_AT':
        const el = document.elementFromPoint(msg.x, msg.y);
        sendResponse(el ? getElementInfo(el) : null);
        break;

      case 'GET_PAGE_INFO':
        sendResponse({ url: location.href, title: document.title, readyState: document.readyState });
        break;

      case 'RUN_STEP':
        try {
          sendResponse(runStep(msg.step));
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
        break;

      default:
        sendResponse({ error: `Unknown message: ${msg.type}` });
    }
    return isTop;
  });

  // A click that leaves the page is a step: the page did answer it.
  window.addEventListener('pagehide', keepHeldClick);

  // Track navigation
  const origPush = history.pushState;
  history.pushState = function(...args) {
    origPush.apply(this, args);
    if (isTop) recordAction('navigate', { url: location.href });
  };

  // A recording goes on when its tab loads another page: only the side panel knows that the
  // tab is being recorded, so a page asks it. `arrived` says how the page came to be shown.
  function carryOnRecording(arrived) {
    try {
      chrome.runtime.sendMessage({ type: 'RECORDER_STATE' }, (state) => {
        void chrome.runtime.lastError;
        if (!state?.recording) {
          // A page brought back by the Back button may still think it is being recorded.
          if (isRecording) { isRecording = false; stopListeningForSteps(); removeMonitor(); }
          return;
        }
        if (!isRecording) {
          isRecording = true; recordedActions = [];
          listenForSteps();
          createMonitor();
        }
        isPaused = Boolean(state.paused);
        earlierActions = Math.max(0, (state.count || 0) - recordedActions.length);
        setMonitorState(isPaused ? '⏸ Paused' : '🔴 Recording');
        // Reloading and going back are steps of their own. Arriving by a click or a form is
        // what that step does, and is not recorded again.
        if (!isTop) return;
        if (arrived === 'reload') recordAction('reload', {});
        else if (arrived === 'back_forward') recordAction('goBack', {});
      });
    } catch { /* the extension was reloaded under this page */ }
  }
  carryOnRecording(performance.getEntriesByType('navigation')[0]?.type);
  window.addEventListener('pageshow', (e) => { if (e.persisted) carryOnRecording('back_forward'); });

  console.log('[Playwright AI Studio] Content script loaded on', location.hostname);
})();
