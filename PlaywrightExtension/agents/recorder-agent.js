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

  async run({ actions, language = 'typescript', testName = 'Recorded Test' }) {
    if (!actions || actions.length === 0) {
      return '// No actions recorded yet. Start recording and interact with the page.';
    }

    const risky = PlaywrightCodegen.detectRiskyActions(actions);
    const riskyNote = risky.length
      ? `\n\n**Risk warnings (heuristic, verify against the app):**\n${risky.map(r => `- Action #${r.index}: ${r.reason}`).join('\n')}\nFor each warning, if the missing setup step is inferable from the surrounding actions, insert it; otherwise add a comment above that line flagging the risk.`
      : '';

    const prompt = `Convert these recorded browser actions into a complete Playwright ${language} test.

**Test Name:** ${testName}
**Recorded Actions:**
${JSON.stringify(actions, null, 2)}${riskyNote}

Generate:
1. Clean Playwright ${language} test with proper locators (prefer getByRole, getByLabel, getByTestId)
2. Page Object class if there are 5+ interactions
3. Proper assertions and wait strategies
4. Remove redundant actions`;

    const result = await this.provider.complete({
      system: `You are a Playwright codegen expert. Convert recorded actions to clean, production-ready Playwright ${language} tests.`,
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
