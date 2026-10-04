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
import { writeFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, existsSync } from 'fs';
import { rm } from 'fs/promises';
import { fileURLToPath } from 'url';
import os from 'os';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 8787;
const testsDir = path.join(__dirname, 'tests');
mkdirSync(testsDir, { recursive: true });

// A web page may open a WebSocket to this machine too, and this server runs code and starts
// an agent that edits files. So a connection is taken from the extension, or from a program
// on this machine (which sends no Origin), and never from a page on a website.
const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  verifyClient: ({ origin }) => !origin || origin.startsWith('chrome-extension://'),
});

// Playwright's own test agents for Claude Code, and the Playwright MCP server they work
// through: installed in this folder by `npx playwright init-agents --loop=claude`.
const agentsInstalled = () =>
  existsSync(path.join(__dirname, '.claude', 'agents', 'playwright-test-healer.md')) && existsSync(path.join(__dirname, '.mcp.json'));

// What the healer agent is asked. It may read this folder, edit files under tests/, and use
// the Playwright MCP tools (run and debug a test, look at the page); it is given no shell.
const HEALER_TOOLS = 'mcp__playwright-test,Read,Glob,Grep,LS,Edit(tests/**)';
const HEALER_TASK = `Fix the failing Playwright test in tests/bridge.spec.ts so that it passes. Run only that file. Change no other file.
Keep it one self-contained file that imports only from '@playwright/test'.
Never delete or weaken an assertion to make the test pass. If the application itself is broken, mark the test test.fixme() with a comment that says why.
When you are done, answer in two lines: what was wrong, and what you changed.`;
console.log(`[bridge] Playwright bridge listening on ws://127.0.0.1:${PORT}`);
console.log('[bridge] Test runs: Generator panel → 🚀 Run via Playwright');
console.log('[bridge] LLM: select "Bridge (Claude Code)" provider in extension Settings');

function stripFences(code) {
  const fences = [...code.matchAll(/```(?:typescript|ts|javascript|js)?\n([\s\S]*?)```/g)];
  return fences.length ? fences.map(f => f[1]).join('\n\n') : code;
}

// What Playwright writes for each test that failed (test-results/<test>/error-context.md): the
// error, and a snapshot of the page at that moment. The extension's healer is given it, so it
// fixes a locator from what was really on the page. Empty when the run left none.
function errorContext() {
  const dir = path.join(__dirname, 'test-results');
  try {
    return readdirSync(dir, { recursive: true })
      .filter((file) => String(file).endsWith('error-context.md'))
      .slice(0, 3)
      .map((file) => readFileSync(path.join(dir, String(file)), 'utf8').slice(0, 14_000))
      .join('\n\n');
  } catch {
    return '';
  }
}

// The files a completion may carry, by media type: the ones Claude Code reads itself.
const ATTACHMENT_EXT = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// Saves the attached files in a new temporary folder and returns { dir, names }, or null when
// there is none. A file is named here, never by the client, so nothing is written elsewhere.
function saveAttachments(attachments) {
  const files = (Array.isArray(attachments) ? attachments : [])
    .filter((file) => ATTACHMENT_EXT[file?.mediaType] && typeof file.base64 === 'string')
    .slice(0, 5);
  if (files.length === 0) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'pw-bridge-'));
  const names = files.map((file, index) => {
    const name = `attachment-${index + 1}.${ATTACHMENT_EXT[file.mediaType]}`;
    writeFileSync(path.join(dir, name), Buffer.from(file.base64, 'base64'));
    return name;
  });
  return { dir, names };
}

wss.on('connection', (ws) => {
  console.log('[bridge] extension connected');
  const send = (obj) => { try { ws.send(JSON.stringify(obj)); } catch {} };
  let child = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    const { id, cmd, payload } = msg;

    if (cmd === 'ping') { send({ id, type: 'pong', version: '1.1.0', agents: agentsInstalled() }); return; }

    // The Playwright healer agent: Claude Code, working through the Playwright MCP server,
    // runs the test in a real browser, looks at the page where it fails, and edits the test
    // until it passes. The answer is the file as the agent left it.
    if (cmd === 'agentHeal') {
      if (!agentsInstalled()) {
        send({ id, type: 'error', error: 'The Playwright agents are not installed. In PlaywrightBridge, run: npx playwright init-agents --loop=claude' });
        return;
      }
      const file = path.join(testsDir, 'bridge.spec.ts');
      writeFileSync(file, stripFences(payload.code || ''), 'utf8');
      console.log('[bridge] Playwright healer agent started...');
      const started = Date.now();
      // The agent says nothing until it is done; the panel is told that it is still at work.
      const beat = setInterval(() => send({ id, type: 'status', message: `… healer agent still working (${Math.round((Date.now() - started) / 1000)}s)\n` }), 15000);
      child = spawn(
        'claude',
        ['-p', '--agent', 'playwright-test-healer', '--mcp-config', '.mcp.json', '--strict-mcp-config', '--allowedTools', `"${HEALER_TOOLS}"`],
        { shell: true, cwd: __dirname },
      );
      const agent = child;
      let out = '', err = '';
      agent.stdout.on('data', (d) => { out += d.toString(); });
      agent.stderr.on('data', (d) => { err += d.toString(); });
      agent.on('error', (e) => { clearInterval(beat); send({ id, type: 'error', error: `Claude Code CLI not found: ${e.message}` }); });
      agent.on('close', (code) => {
        clearInterval(beat);
        if (child === agent) child = null;
        if (code !== 0) { send({ id, type: 'error', error: err.trim() || out.trim() || `The healer agent ended with code ${code}` }); return; }
        send({ id, type: 'agentHealResult', code: readFileSync(file, 'utf8'), summary: out.trim() });
      });
      agent.stdin.write(HEALER_TASK);
      agent.stdin.end();
      return;
    }

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
        send({ id, type: 'done', exitCode, passed: exitCode === 0, errorContext: exitCode === 0 ? '' : errorContext() });
        child = null;
      });
      return;
    }

    // LLM completion via local Claude Code CLI (claude -p reads prompt from stdin)
    if (cmd === 'complete') {
      // Attached files are saved in a folder of their own, and the CLI is started there: it may
      // read the files of its working folder without being asked. The folder is removed afterwards.
      let saved = null;
      try {
        saved = saveAttachments(payload.attachments);
      } catch (e) {
        send({ id, type: 'error', error: `The attached file could not be saved: ${e.message}` });
        return;
      }
      // On Windows the folder stays locked for a moment after the CLI ends, so removing it is
      // tried again; a folder that cannot be removed must not stop the answer or the bridge.
      const cleanUp = () => {
        if (saved) rm(saved.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }).catch(() => {});
      };
      const filesNote = saved
        ? `\n\nThe attached files are saved in the current directory. Read each one in full with the Read tool before answering:\n${saved.names.map((name) => `- ${name}`).join('\n')}`
        : '';
      const fullPrompt = `${payload.system ? payload.system + '\n\n---\n\n' : ''}${payload.prompt || ''}${filesNote}`;
      console.log(`[bridge] claude -p completion requested${saved ? ` with ${saved.names.length} attached file(s)` : ''}...`);
      const proc = spawn('claude', ['-p'], { shell: true, ...(saved ? { cwd: saved.dir } : {}) });
      let out = '', err = '';
      proc.stdout.on('data', (d) => { out += d.toString(); });
      proc.stderr.on('data', (d) => { err += d.toString(); });
      proc.on('error', (e) => { cleanUp(); send({ id, type: 'error', error: `Claude Code CLI not found: ${e.message}` }); });
      proc.on('close', (code) => {
        cleanUp();
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
