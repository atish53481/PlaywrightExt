import { BaseAgent } from './base-agent.js';
import { PlaywrightCodegen } from '../utils/playwright-codegen.js';

export class RecorderAgent extends BaseAgent {
  constructor(provider) {
    super('Recorder', provider);
    this.recording = false;
    this.actions = [];
    this.language = 'typescript';
  }

  startRecording(language = 'typescript') {
    this.recording = true;
    this.actions = [];
    this.language = language;
    this.sendToContent({ type: 'START_RECORDING' });
  }

  pauseRecording() {
    this.recording = false;
    this.sendToContent({ type: 'PAUSE_RECORDING' });
  }

  resumeRecording() {
    this.recording = true;
    this.sendToContent({ type: 'RESUME_RECORDING' });
  }

  stopRecording() {
    this.recording = false;
    this.sendToContent({ type: 'STOP_RECORDING' });
    return this.actions;
  }

  addAction(action) {
    if (!this.recording) return;
    this.actions.push({ ...action, ts: Date.now() });
  }

  sendToContent(msg) {
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload: msg });
    }
  }

  // "AI Enhance": the recorded test, tidied by the model. What comes back is run by both
  // runners (Run on Page and Run via Playwright), so it must be one file, and it must hold
  // nothing the recording does not: an invented selector or assertion is a test that fails.
  // `code` is the test the code box holds when it is no longer the recording as written: one
  // that was edited, healed, or run and passed. It is then the test to tidy.
  async run({ actions, language = 'typescript', testName = 'Recorded Test', pageObjects = false, code = '' }) {
    if (!actions || actions.length === 0) {
      return '// No actions recorded yet. Start recording and interact with the page.';
    }

    const steps = PlaywrightCodegen.normalizeActions(actions);
    // The test the recorder itself writes: every step replays what was done, with a locator
    // that matched one element when it was recorded.
    const baseline = code.trim() || PlaywrightCodegen.actionsToTest(actions, testName, language === 'javascript' ? 'javascript' : 'typescript');
    // What the model needs of each step, without the element's HTML.
    const recorded = steps.map(({ type, selector, locator, value, key, url, target, files }) =>
      ({ type, selector, locator, value, key, files, target: target?.locator, pageUrl: url }));
    const shape = pageObjects
      ? `- Put the locators and actions in ONE page class defined in this same file, above the test, and have the test use it. Do not write separate files.`
      : `- Keep the steps as direct \`await page…\` calls inside one test(). No page objects, no helper functions, no test.step(): group the steps with short comments instead.`;

    const risky = PlaywrightCodegen.detectRiskyActions(actions);
    const riskyNote = risky.length
      ? `\n\n**Risk warnings (heuristic, verify against the app):**\n${risky.map(r => `- Action #${r.index}: ${r.reason}`).join('\n')}\nFor each warning, if the missing setup step is inferable from the surrounding actions, insert it; otherwise add a comment above that line flagging the risk.`
      : '';

    const prompt = `Tidy this recorded Playwright ${language} test. It must still pass when it is run exactly as you return it.

**Test Name:** ${testName}

**The test as it stands (it replays what the user did, and it works: where it differs from the recorded steps below, the test is right):**
\`\`\`
${baseline}
\`\`\`

**The recorded steps (pageUrl is the address of the page when the step happened):**
${JSON.stringify(recorded, null, 2)}${riskyNote}

Rules:
- Keep every step, in the same order, with the locator it was recorded with. Remove a step only when it repeats the one before it.
- Never use a selector, a URL, or a text that is not in the recording above. Do not guess at a "better" locator: you cannot see the page.
${shape}
- Add an assertion only where the recording proves it: \`await expect(page).toHaveURL(…)\` after a step whose next step has another pageUrl, and \`toHaveValue\` after a fill. Assert on nothing else.
- Web-first assertions only; never waitForTimeout.
- Return ONE complete, self-contained spec file in a single code block. It starts with the import from '@playwright/test' and imports no local file.`;

    const result = await this.provider.complete({
      system: `You are a Playwright codegen expert. You turn a recorded test into a clean ${language} test that passes, changing nothing about what it does.`,
      prompt,
      maxTokens: 4000
    });
    this.record({ actions }, result);
    return result;
  }

  generateCode(actions = this.actions) {
    const lines = [`import { test, expect } from '@playwright/test';`, '', `test('Recorded test', async ({ page }) => {`];
    for (const action of actions) {
      switch (action.type) {
        case 'navigate': lines.push(`  await page.goto('${action.url}');`); break;
        case 'click':    lines.push(`  await page.locator('${action.selector}').click();`); break;
        case 'fill':     lines.push(`  await page.locator('${action.selector}').fill('${action.value}');`); break;
        case 'press':    lines.push(`  await page.keyboard.press('${action.key}');`); break;
        case 'select':   lines.push(`  await page.locator('${action.selector}').selectOption('${action.value}');`); break;
        case 'check':    lines.push(`  await page.locator('${action.selector}').check();`); break;
        case 'screenshot': lines.push(`  await page.screenshot({ path: 'screenshot-${Date.now()}.png' });`); break;
        default: break;
      }
    }
    lines.push('});');
    return lines.join('\n');
  }
}
