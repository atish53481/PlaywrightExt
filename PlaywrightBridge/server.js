// Playwright Bridge — local WebSocket server that lets the Playwright AI Studio
// Chrome extension:
//   1. execute tests with the REAL Playwright runner (headed browser)
//   2. open the real Playwright tools: UI Mode, Inspector (--debug), Codegen
//   3. use the locally installed Claude Code CLI as the LLM provider (no API key
//      pasted into the extension; published users configure their own LLM instead)
//
// Security: binds 127.0.0.1 only AND rejects connections coming from web pages
// (any site can open a WebSocket to localhost, so the Origin header is checked).
// It executes Playwright test code and prompts sent by local clients — do not
// expose this port beyond localhost.

import { WebSocketServer } from 'ws';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const VERSION = '1.1.0';
const testsDir = path.join(__dirname, 'tests');
const explorerDir = path.join(testsDir, 'explorer');
const PW_CLI = path.join(__dirname, 'node_modules', '@playwright', 'test', 'cli.js');
mkdirSync(testsDir, { recursive: true });

// Only extensions and non-browser local clients may connect. Browsers always
// send Origin, so an http(s) page trying to reach the bridge is refused.
const originAllowed = (origin) => !origin || /^(chrome|moz)-extension:\/\//.test(origin);

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: ({ origin }) => {
    const ok = originAllowed(origin);
    if (!ok) console.warn(`[bridge] refused connection from origin ${origin}`);
    return ok;
  },
});
console.log(`[bridge] Playwright bridge v${VERSION} listening on ws://127.0.0.1:${PORT}`);
console.log('[bridge] Test runs: 🚀 Run via Playwright  |  Tools: Test Explorer → UI Mode / Inspector / Codegen');
console.log('[bridge] LLM: select "Bridge (Claude Code)" provider in extension Settings');
if (!existsSync(PW_CLI)) console.warn('[bridge] @playwright/test is not installed — run: npm run setup');

function stripFences(code) {
  const fences = [...code.matchAll(/```(?:typescript|ts|javascript|js)?\r?\n([\s\S]*?)```/g)];
  return fences.length ? fences.map(f => f[1]).join('\n\n') : code;
}

// Spec files here are ES modules — rewrite the CommonJS header the extension
// emits for "JavaScript" so the same code runs.
function prepare(code) {
  return stripFences(code || '').replace(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"]@playwright\/test['"]\s*\)\s*;?/g,
    (_, names) => `import {${names}} from '@playwright/test';`
  );
}

// Runs the Playwright CLI with node directly — no shell, so nothing from the
// client is ever interpreted by one.
const playwright = (args, env) => spawn(process.execPath, [PW_CLI, ...args], { cwd: __dirname, env: { ...process.env, ...env } });

const slug = (s) => (String(s || 'test').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || 'test');

// Tools (UI Mode, Codegen) outlive the side panel; they are not killed on disconnect.
const tools = new Set();
process.on('exit', () => tools.forEach(t => t.kill()));

wss.on('connection', (ws) => {
  console.log('[bridge] extension connected');
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* client gone */ } };
  let child = null;

  const stream = (id, proc, onClose) => {
    proc.stdout.on('data', (d) => send({ id, type: 'output', line: d.toString() }));
    proc.stderr.on('data', (d) => send({ id, type: 'output', line: d.toString() }));
    proc.on('error', (e) => send({ id, type: 'error', error: `Could not start Playwright: ${e.message}` }));
    proc.on('close', (exitCode) => send({ id, type: 'done', exitCode, passed: exitCode === 0, ...(onClose?.() || {}) }));
  };

  const startTool = (id, proc, label, onClose) => {
    tools.add(proc);
    proc.on('close', () => tools.delete(proc));
    send({ id, type: 'status', message: `${label}\n` });
    stream(id, proc, onClose);
  };

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, cmd, payload = {} } = msg;

    if (cmd === 'ping') { send({ id, type: 'pong', version: VERSION }); return; }

    if (cmd === 'stop') { child?.kill(); send({ id, type: 'status', message: 'Run stopped' }); return; }

    if (['runCode', 'debug', 'uiMode', 'codegen'].includes(cmd) && !existsSync(PW_CLI)) {
      send({ id, type: 'error', error: 'Playwright is not installed in the bridge — run: npm run setup' });
      return;
    }

    // Run Playwright code with the real runner (headed)
    if (cmd === 'runCode' || cmd === 'debug') {
      writeFileSync(path.join(testsDir, 'bridge.spec.ts'), prepare(payload.code), 'utf8');
      const debug = cmd === 'debug';
      send({ id, type: 'status', message: `Test file written → tests/bridge.spec.ts\nLaunching Playwright (${debug ? 'Inspector — step through the test there' : 'headed browser'})...\n` });
      child?.kill();
      child = playwright(['test', 'bridge.spec.ts', ...(debug ? ['--debug'] : [])]);
      const mine = child;
      stream(id, mine, () => { if (child === mine) child = null; });
      return;
    }

    // npx playwright test --ui  (with the tests saved in the extension's Test Explorer)
    if (cmd === 'uiMode') {
      const tests = Array.isArray(payload.tests) ? payload.tests : [];
      if (!tests.length) { send({ id, type: 'error', error: 'No tests to open — save a test to the Explorer first' }); return; }
      rmSync(explorerDir, { recursive: true, force: true });
      mkdirSync(explorerDir, { recursive: true });
      tests.forEach((t, i) => {
        writeFileSync(path.join(explorerDir, `${String(i + 1).padStart(2, '0')}-${slug(t.name)}.spec.ts`), prepare(t.code), 'utf8');
      });
      startTool(id, playwright(['test', 'tests/explorer', '--ui']), `${tests.length} test(s) written → tests/explorer/\nOpening Playwright UI Mode...`);
      return;
    }

    // npx playwright codegen <url> — the recorded test comes back in the 'done' message
    if (cmd === 'codegen') {
      let url = '';
      if (payload.url) {
        try {
          const u = new URL(payload.url);
          if (!['http:', 'https:'].includes(u.protocol)) throw new Error('only http(s) URLs');
          url = u.href;
        } catch (e) { send({ id, type: 'error', error: `Invalid URL: ${e.message}` }); return; }
      }
      const out = path.join(testsDir, 'codegen.spec.ts');
      rmSync(out, { force: true });
      startTool(id, playwright(['codegen', '--target', 'playwright-test', '-o', out, ...(url ? [url] : [])]),
        'Opening Playwright Codegen — close its window when done to import the recording...',
        () => ({ code: existsSync(out) ? readFileSync(out, 'utf8') : '' }));
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

    send({ id, type: 'error', error: `Unknown command: ${cmd}` });
  });

  ws.on('close', () => { child?.kill(); console.log('[bridge] extension disconnected'); });
});
