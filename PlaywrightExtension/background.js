// MV3 Service Worker — opens side panel on action click, relays content-script messages

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// A tab opened from another tab (a link with target=_blank, window.open). The side panel
// knows whether the tab it came from is being recorded.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  chrome.runtime.sendMessage({ type: 'TAB_OPENED', tabId: tab.id, openerTabId: tab.openerTabId }).catch(() => {});
});

// Relay messages from sidepanel to active-tab content script.
// If the content script is missing (tab opened before extension load / reload),
// inject it once and retry — otherwise recording silently captures nothing.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'RELAY_TO_CONTENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { sendResponse({ error: 'No active tab' }); return; }
      if (/^(chrome|edge|about|chrome-extension):/.test(tab.url || '')) {
        sendResponse({ error: `Cannot run on "${tab.url}" — open a normal website tab first` });
        return;
      }
      chrome.tabs.sendMessage(tab.id, message.payload, (resp) => {
        if (!chrome.runtime.lastError && resp !== undefined) { sendResponse(resp); return; }
        // Content script not there — inject and retry once
        chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: ['content.js'] })
          .then(() => {
            chrome.tabs.sendMessage(tab.id, message.payload, (resp2) => {
              sendResponse(resp2 || { error: chrome.runtime.lastError?.message || 'Page did not respond' });
            });
          })
          .catch(e => sendResponse({ error: `Cannot access this page: ${e.message}` }));
      });
    });
    return true;
  }

  // The recorder reads a page's :hover rules to know which hover opens a menu. A page cannot
  // read the rules of a stylesheet served from another site, so its text is fetched here:
  // only for a content script, only over http(s), without cookies, and only what is served as CSS.
  if (message.type === 'FETCH_CSS') {
    if (!sender.tab || !/^https?:\/\//i.test(message.url || '')) { sendResponse({}); return; }
    fetch(message.url, { credentials: 'omit' })
      .then(async (response) => (response.ok && /text\/css/i.test(response.headers.get('content-type') || '')
        ? (await response.text()).slice(0, 2_000_000)
        : ''))
      .then((css) => sendResponse({ css }))
      .catch(() => sendResponse({}));
    return true;
  }

  if (message.type === 'GET_ACTIVE_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse(tabs[0] || null);
    });
    return true;
  }

  if (message.type === 'INJECT_INSPECTOR') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ error: 'No active tab' }); return; }
      chrome.scripting.executeScript({
        target: { tabId: tabs[0].id },
        files: ['content.js']
      }).then(() => sendResponse({ ok: true })).catch(e => sendResponse({ error: e.message }));
    });
    return true;
  }

  if (message.type === 'CAPTURE_NETWORK') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (!tabs[0]) { sendResponse({ error: 'No active tab' }); return; }
      const tabId = tabs[0].id;
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) { sendResponse({ error: chrome.runtime.lastError.message }); return; }
        chrome.debugger.sendCommand({ tabId }, 'Network.enable', {}, () => {
          sendResponse({ attached: true, tabId });
        });
      });
    });
    return true;
  }
});

// The platform session token is kept in chrome.storage.local. Content scripts run inside
// web pages and have no use for it, so storage is closed to them.
chrome.storage.local.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' });

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Playwright AI Studio] Installed v1.0.0');
});
