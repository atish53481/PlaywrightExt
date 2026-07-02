// WebSocket client for the local Playwright Bridge (Atish/PlaywrightBridge).
// The bridge runs real Playwright tests (headed) and proxies LLM calls to the
// locally installed Claude Code CLI.

const BRIDGE_URL = 'ws://127.0.0.1:8787';

export const BridgeClient = {

  connect(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BRIDGE_URL);
      const t = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Bridge not running — start it: cd Atish/PlaywrightBridge && npm start'));
      }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(ws); };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error('Bridge not running — start it: cd Atish/PlaywrightBridge && npm start'));
      };
    });
  },

  async isAvailable() {
    try { const ws = await this.connect(800); ws.close(); return true; }
    catch { return false; }
  },

  // Runs generated code with the real Playwright runner. onEvent gets every
  // bridge message ({type:'status'|'output'|'done'}). Resolves with the done msg.
  async runCode(code, onEvent) {
    const ws = await this.connect();
    return new Promise((resolve, reject) => {
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        onEvent?.(msg);
        if (msg.type === 'done') { ws.close(); resolve(msg); }
        if (msg.type === 'error') { ws.close(); reject(new Error(msg.error)); }
      };
      ws.onclose = () => reject(new Error('Bridge connection closed'));
      ws.send(JSON.stringify({ id: Date.now(), cmd: 'runCode', payload: { code } }));
    });
  },

  // LLM completion via local Claude Code CLI
  async complete({ system, prompt }) {
    const ws = await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('Claude Code CLI timed out (120s)')); }, 120000);
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'completeResult') { clearTimeout(timer); ws.close(); resolve(msg.text); }
        if (msg.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.error)); }
      };
      ws.send(JSON.stringify({ id: Date.now(), cmd: 'complete', payload: { system, prompt } }));
    });
  }
};
