// Runs in the page's own world (content.js runs apart from it and cannot see these calls).
// Tells the recorder what alert(), confirm(), and prompt() showed and how each was answered,
// so the recorded test can answer the dialog the same way. Nothing is changed about what
// the page gets back.

(() => {
  if (window.__pasDialogHooks) return;
  window.__pasDialogHooks = true;

  const tell = (kind, message, result) => {
    try { window.postMessage({ __pas: 'dialog', kind, message: String(message ?? ''), result }, '*'); } catch { /* the page is going away */ }
  };
  const { alert, confirm, prompt } = window;

  window.alert = function (message) {
    tell('alert', message, true);
    return alert.call(this, message);
  };
  window.confirm = function (message) {
    const result = confirm.call(this, message);
    tell('confirm', message, result);
    return result;
  };
  window.prompt = function (message, value) {
    const result = prompt.call(this, message, value);
    tell('prompt', message, result);
    return result;
  };
})();
