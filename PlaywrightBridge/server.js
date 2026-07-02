// Playwright Bridge — local WebSocket server that lets the Playwright AI Studio
// Chrome extension:
//   1. execute generated tests with the REAL Playwright runner (headed browser)
//   2. use the locally installed Claude Code CLI as the LLM provider (no API key
//      pasted into the extension; published users configure their own LLM instead)
//
// Security: binds 127.0.0.1 only. It executes Playwright test code and prompts
// sent by local clients — do not expose this port beyond localhost.

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const testsDir = path.join(__dirname, 'tests');
mkdirSync(testsDir, { recursive: true });

const wss = new WebSocketServer({ host: '127.0.0.1', port: PORT });
console.log(`[bridge] Playwright bridge listening on ws://127.0.0.1:${PORT}`);
console.log('[bridge] Test runs: Generator panel → 🚀 Run via Playwright');
console.log('[bridge] LLM: select "Bridge (Claude Code)" provider in extension Settings');

function stripFences(code) {
  const fences = [...code.matchAll(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/g)];
  return fences.length ? fences.map(f => f[1]).join('\n\n') : code;
}

wss.on('connection', (ws) => {
  console.log('[bridge] extension connected');
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  let child = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, cmd, payload } = msg;

    if (cmd === 'ping') { send({ id, type: 'pong', version: '1.0.0' }); return; }

    if (cmd === 'stop') { child?.kill(); send({ id, type: 'status', message: 'Run stopped' }); return; }

    // Run generated Playwright code with the real runner (headed)
    if (cmd === 'runCode') {
      const file = path.join(testsDir, 'bridge.spec.ts');
      writeFileSync(file, stripFences(payload.code || ''), 'utf8');
      send({ id, type: 'status', message: 'Test file written → tests/bridge.spec.ts\nLaunching Playwright (headed browser)...\n' });

      child = spawn('npx', ['playwright', 'test', 'bridge.spec.ts'], { cwd: __dirname, shell: true });
      child.stdout.on('data', (d) => send({ id, type: 'output', line: d.toString() }));
      child.stderr.on('data', (d) => send({ id, type: 'output', line: d.toString() }));
      child.on('close', (exitCode) => {
        send({ id, type: 'done', exitCode, passed: exitCode === 0 });
        child = null;
      });
      return;
    }

    // LLM completion via local Claude Code CLI (claude -p reads prompt from stdin)
    if (cmd === 'complete') {
      const fullPrompt = `${payload.system ? payload.system + '\n\n---\n\n' : ''}${payload.prompt || ''}`;
      console.log('[bridge] claude -p completion requested...');
      const proc = spawn('claude', ['-p'], { shell: true });
      let out = '', err = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e) => send({ id, type: 'error', error: `Claude Code CLI not found: ${e.message}` }));
      proc.on('close', (code) => {
        if (code === 0 && out.trim()) send({ id, type: 'completeResult', text: out.trim() });
        else send({ id, type: 'error', error: err.trim() || `claude exited with code ${code}` });
      });
      proc.stdin.write(fullPrompt);
      proc.stdin.end();
      return;
    }
  });

  ws.on('close', () => { child?.kill(); console.log('[bridge] extension disconnected'); });
});
