// WebSocket client for the local Playwright Bridge (PlaywrightExt/PlaywrightBridge).
// The bridge runs real Playwright tests (headed) and proxies LLM calls to the
// locally installed Claude Code CLI.

const BRIDGE_URL = 'ws://127.0.0.1:8787';

export const BridgeClient = {

  connect(timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(BRIDGE_URL);
      const t = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Bridge not running — start it: cd PlaywrightExt/PlaywrightBridge && npm start'));
      }, timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(ws); };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error('Bridge not running — start it: cd PlaywrightExt/PlaywrightBridge && npm start'));
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

  // Whether the bridge has Playwright's test agents and MCP server installed (see its README).
  async hasAgents() {
    const ws = await this.connect(800);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { ws.close(); resolve(false); }, 1500);
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'pong') { clearTimeout(timer); ws.close(); resolve(Boolean(msg.agents)); }
      };
      ws.send(JSON.stringify({ id: Date.now(), cmd: 'ping' }));
    });
  },

  // Has the Playwright healer agent fix a failing test: it runs the test in a real browser
  // through Playwright MCP and edits it until it passes. Resolves with { code, summary }:
  // the test as the agent left it, and what it says it changed. onEvent gets the status lines.
  async agentHeal(code, onEvent) {
    const ws = await this.connect();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { ws.close(); reject(new Error('The healer agent timed out (10 min)')); }, 600000);
      const end = (settle, value) => { clearTimeout(timer); ws.onclose = null; ws.close(); settle(value); };
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        onEvent?.(msg);
        if (msg.type === 'agentHealResult') end(resolve, { code: msg.code, summary: msg.summary || '' });
        if (msg.type === 'error') end(reject, new Error(msg.error));
      };
      ws.onclose = () => { clearTimeout(timer); reject(new Error('Bridge connection closed')); };
      ws.send(JSON.stringify({ id: Date.now(), cmd: 'agentHeal', payload: { code } }));
    });
  },

  // LLM completion via local Claude Code CLI
  // `attachments` are uploaded files Claude Code reads itself (a PDF, an image), each
  // { name, mediaType, base64 }; the bridge saves them where the CLI can read them.
  async complete({ system, prompt, attachments = [] }) {
    const ws = await this.connect();
    return new Promise((resolve, reject) => {
      // Reading a file takes the CLI longer than answering from text.
      const seconds = attachments.length > 0 ? 300 : 120;
      const timer = setTimeout(() => { ws.close(); reject(new Error(`Claude Code CLI timed out (${seconds}s)`)); }, seconds * 1000);
      ws.onmessage = (e) => {
        let msg; try { msg = JSON.parse(e.data); } catch { return; }
        if (msg.type === 'completeResult') { clearTimeout(timer); ws.close(); resolve(msg.text); }
        if (msg.type === 'error') { clearTimeout(timer); ws.close(); reject(new Error(msg.error)); }
      };
      ws.send(JSON.stringify({ id: Date.now(), cmd: 'complete', payload: { system, prompt, attachments } }));
    });
  }
};
