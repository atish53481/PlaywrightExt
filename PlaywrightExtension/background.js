// MV3 Service Worker — opens side panel on action click, relays content-script messages

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// Relay messages from sidepanel to active-tab content script.
// If the content script is missing (tab opened before extension load / reload),
// inject it once and retry — otherwise recording silently captures nothing.
// ---- Recording state ----
// A full page navigation wipes the content script, so the recording state lives
// here (storage.session survives service-worker restarts). A freshly loaded
// content script sends CONTENT_READY and resumes if its tab is mid-recording.
const REC_KEY = 'pas_rec';
let recCache; // undefined = not loaded yet, null = not recording

async function getRec() {
  if (recCache === undefined) recCache = (await chrome.storage.session.get(REC_KEY))[REC_KEY] || null;
  return recCache;
}
async function setRec(rec) {
  recCache = rec;
  if (rec) await chrome.storage.session.set({ [REC_KEY]: rec });
  else await chrome.storage.session.remove(REC_KEY);
}

// Serializes read-modify-write updates so rapid actions never lose a count.
let recQueue = Promise.resolve();
function updateRec(fn) {
  recQueue = recQueue.then(async () => {
    const next = fn(await getRec());
    if (next !== undefined) await setRec(next);
  }).catch(() => {});
  return recQueue;
}

// START is registered BEFORE the page is told to start: the page reports its
// first action (the initial navigate) before its START response arrives.
function beforeRelay(tabId, payload) {
  if (payload.type !== 'START_RECORDING') return Promise.resolve();
  return updateRec(() => ({ tabId, paused: false, count: 0 }));
}

function trackRecording(tabId, payload, resp) {
  const ok = !!resp?.ok;
  switch (payload.type) {
    case 'START_RECORDING': return ok ? Promise.resolve() : updateRec(() => null);
    case 'STOP_RECORDING': return updateRec(() => null);
    case 'PAUSE_RECORDING': return updateRec(rec => (ok && rec ? { ...rec, paused: true } : undefined));
    case 'RESUME_RECORDING': return updateRec(rec => (ok && rec ? { ...rec, paused: false } : undefined));
    default: return Promise.resolve();
  }
}

chrome.tabs.onRemoved.addListener(async (tabId) => {
  const rec = await getRec();
  if (rec?.tabId === tabId) await setRec(null);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'CONTENT_READY') {
    getRec().then(rec => {
      const mine = rec && sender.tab?.id === rec.tabId;
      sendResponse(mine ? { recording: true, paused: rec.paused, count: rec.count } : { recording: false });
    });
    return true;
  }

  if (message.type === 'RECORDING_ACTION') {
    updateRec(rec => (rec && sender.tab?.id === rec.tabId ? { ...rec, count: rec.count + 1 } : undefined));
    return false;
  }

  if (message.type === 'RELAY_TO_CONTENT') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab) { sendResponse({ error: 'No active tab' }); return; }
      if (/^(chrome|edge|about|chrome-extension|devtools|view-source):/.test(tab.url || '')) {
        sendResponse({ error: `Cannot run on "${tab.url}" — open a normal website tab first`, fatal: true });
        return;
      }
      const reply = (resp) => {
        trackRecording(tab.id, message.payload, resp).finally(() => sendResponse(resp));
      };
      beforeRelay(tab.id, message.payload).then(() => {
        chrome.tabs.sendMessage(tab.id, message.payload, (resp) => {
          if (!chrome.runtime.lastError && resp !== undefined) { reply(resp); return; }
          // Content script not there — inject and retry once
          chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content.js'] })
            .then(() => {
              chrome.tabs.sendMessage(tab.id, message.payload, (resp2) => {
                reply(resp2 || { error: chrome.runtime.lastError?.message || 'Page did not respond' });
              });
            })
            .catch(e => reply({ error: `Cannot access this page: ${e.message}` }));
        });
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
