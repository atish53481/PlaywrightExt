// WebSocket client for the local Playwright Bridge (PlaywrightExt/PlaywrightBridge).
// The bridge runs real Playwright tests (headed), opens the real Playwright tools
// (UI Mode, Inspector, Codegen) and proxies LLM calls to the Claude Code CLI.

const BRIDGE_URL = 'ws://127.0.0.1:8787';
const NOT_RUNNING = 'Bridge not running — start it: cd PlaywrightExt/PlaywrightBridge && npm start';

export const BridgeClient = {

  connect(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BRIDGE_URL);
      const t = setTimeout(() => {
        try { ws.close(); } catch { /* ignore */ }
        reject(new Error(NOT_RUNNING));
      }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(ws); };
      ws.onerror = () => { clearTimeout(t); reject(new Error(NOT_RUNNING)); };
    });
  },

  async isAvailable() {
    try { const ws = await this.connect(800); ws.close(); return true; }
    catch { return false; }
  },

  // Sends one command and streams its events to onEvent until 'done' / 'error'.
  async _stream(cmd, payload, onEvent) {
    const ws = await this.connect();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (!settled) { settled = true; fn(v); } };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        onEvent?.(msg);
        if (msg.type === 'done') { finish(resolve, msg); ws.close(); }
        if (msg.type === 'error') { finish(reject, new Error(msg.error)); ws.close(); }
      };
      ws.onclose = () => finish(reject, new Error('Bridge connection closed'));
      ws.send(JSON.stringify({ id: Date.now(), cmd, payload }));
    });
  },

  // Runs code with the real Playwright runner. onEvent gets every bridge message
  // ({type:'status'|'output'|'done'}). Resolves with the done msg ({passed, exitCode}).
  runCode(code, onEvent) {
    return this._stream('runCode', { code }, onEvent);
  },

  // Opens a real Playwright tool. cmd: 'uiMode' {tests:[{name,code}]} |
  // 'debug' {code} | 'codegen' {url}. Resolves when the tool window is closed;
  // for codegen the done message carries the recorded test in `code`.
  launchTool(cmd, payload, onEvent) {
    return this._stream(cmd, payload, onEvent);
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
