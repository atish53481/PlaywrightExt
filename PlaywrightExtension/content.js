// Content script — handles DOM recording, inspection, and element highlighting

(function() {
  'use strict';
  if (window.__pasContentLoaded) return;
  window.__pasContentLoaded = true;

  let isRecording = false;
  let isPaused = false;
  let isInspecting = false;
  let highlightOverlay = null;
  let recordedActions = [];

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
    if (el.getAttribute('placeholder')) return `placeholder: "${el.getAttribute('placeholder')}"`;
    if (el.id) return `#${el.id}`;
    if (el.getAttribute('name')) return `[name="${el.getAttribute('name')}"]`;
    const text = el.textContent?.trim().slice(0, 40);
    if (text) return `text: "${text}"`;
    return el.tagName.toLowerCase();
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    const locators = [];

    if (el.getAttribute('data-testid')) locators.push({ strategy: 'data-testid', locator: `locator('[data-testid="${el.getAttribute('data-testid')}"]')`, score: 100 });
    if (el.getAttribute('aria-label')) locators.push({ strategy: 'aria-label', locator: `getByLabel('${el.getAttribute('aria-label')}')`, score: 85 });
    if (el.getAttribute('placeholder')) locators.push({ strategy: 'placeholder', locator: `getByPlaceholder('${el.getAttribute('placeholder')}')`, score: 70 });
    if (el.getAttribute('role')) {
      const name = el.textContent?.trim().slice(0, 50);
      locators.push({ strategy: 'role', locator: name ? `getByRole('${el.getAttribute('role')}', { name: '${name}' })` : `getByRole('${el.getAttribute('role')}')`, score: 90 });
    }
    if (el.id) locators.push({ strategy: 'id', locator: `locator('#${el.id}')`, score: 55 });
    if (el.getAttribute('name')) locators.push({ strategy: 'name', locator: `locator('[name="${el.getAttribute('name')}"]')`, score: 45 });
    const text = el.textContent?.trim().slice(0, 50);
    if (text && ['BUTTON','A','LABEL'].includes(el.tagName)) locators.push({ strategy: 'text', locator: `getByText('${text}')`, score: 60 });

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
      locators: locators.sort((a, b) => b.score - a.score)
    };
  }

  // --- Recording Monitor (codegen-style floating panel, left side of page) ---
  let monitorPanel = null;

  function createMonitor() {
    if (monitorPanel) return;
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
    if (count) count.textContent = `${recordedActions.length} actions`;
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
    const action = { type, ...data, ts: Date.now(), url: location.href };
    recordedActions.push(action);
    monitorLog(action);
    chrome.runtime.sendMessage({ type: 'RECORDING_ACTION', action });
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
      const info = getElementInfo(e.target);
      recordAction('click', { selector: getBestLocatorText(e.target), locator: info.locators[0]?.locator, elementInfo: info });
    }
  }

  function onInput(e) {
    if (monitorPanel && monitorPanel.contains(e.target)) return;
    if (isRecording && !isPaused && e.target.value !== undefined) {
      recordAction('fill', { selector: getBestLocatorText(e.target), locator: getElementInfo(e.target).locators[0]?.locator, value: e.target.value });
    }
  }

  function onKeyDown(e) {
    if (isRecording && !isPaused && ['Enter', 'Tab', 'Escape'].includes(e.key)) {
      recordAction('press', { key: e.key });
    }
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

  function accessibleName(el) {
    const label = el.getAttribute('aria-label');
    if (label) return label;
    if (el.labels && el.labels.length) return el.labels[0].textContent.trim();
    if (el.getAttribute('placeholder')) return el.getAttribute('placeholder');
    if (el.tagName === 'INPUT' && ['submit', 'button'].includes(el.type)) return el.value;
    return (el.textContent || '').trim();
  }

  function resolveLocator(locator) {
    const { method, value, name } = locator;
    const nameMatches = (el) => {
      if (!name) return true;
      return accessibleName(el).toLowerCase().includes(name.toLowerCase());
    };

    switch (method) {
      case 'locator':
        return document.querySelector(value);
      case 'getByTestId':
        return document.querySelector(`[data-testid="${value}"]`);
      case 'getByPlaceholder':
        return document.querySelector(`[placeholder="${value}"]`) || document.querySelector(`[placeholder*="${value}"]`);
      case 'getByRole': {
        const selector = IMPLICIT_ROLES[value] || `[role="${value}"]`;
        return [...document.querySelectorAll(selector)].find(nameMatches) || null;
      }
      case 'getByLabel': {
        const byAria = [...document.querySelectorAll('[aria-label]')]
          .find(el => el.getAttribute('aria-label').toLowerCase().includes(value.toLowerCase()));
        if (byAria) return byAria;
        const label = [...document.querySelectorAll('label')]
          .find(l => l.textContent.trim().toLowerCase().includes(value.toLowerCase()));
        if (!label) return null;
        return label.control || (label.htmlFor ? document.getElementById(label.htmlFor) : label.querySelector('input, textarea, select'));
      }
      case 'getByText': {
        const walker = [...document.querySelectorAll('button, a, span, p, div, label, td, th, li, h1, h2, h3, h4, h5, h6')];
        return walker.find(el =>
          el.children.length === 0 && el.textContent.trim().toLowerCase().includes(value.toLowerCase())
        ) || null;
      }
      default:
        return null;
    }
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
        el.click();
        if (step.action === 'dblclick') el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        return { ok: true };
      case 'hover':
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
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
    switch (msg.type) {
      case 'START_RECORDING':
        isRecording = true; isPaused = false; recordedActions = [];
        document.addEventListener('click', onClick, true);
        document.addEventListener('input', onInput, true);
        document.addEventListener('keydown', onKeyDown, true);
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
        isRecording = false;
        document.removeEventListener('click', onClick, true);
        document.removeEventListener('input', onInput, true);
        document.removeEventListener('keydown', onKeyDown, true);
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
    return true;
  });

  // Track navigation
  const origPush = history.pushState;
  history.pushState = function(...args) {
    origPush.apply(this, args);
    recordAction('navigate', { url: location.href });
  };

  console.log('[Playwright AI Studio] Content script loaded on', location.hostname);
})();
