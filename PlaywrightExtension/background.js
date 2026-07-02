// MV3 Service Worker — opens side panel on action click, relays content-script messages

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

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
        chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
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

chrome.runtime.onInstalled.addListener(() => {
  console.log('[Playwright AI Studio] Installed v1.0.0');
});
