import { BaseAgent } from './base-agent.js';

export class BrowserSessionAgent extends BaseAgent {
  constructor(provider) {
    super('Browser Session', provider);
    this.capturing = false;
    this.networkRequests = [];
    this.consoleLogs = [];
    this.sessionData = null;
  }

  buildSystemPrompt() {
    return `You are a browser session analysis expert. Convert captured browser sessions (network, console, DOM interactions) into Playwright tests.
Generate clean, idiomatic Playwright code that accurately reproduces the session.`;
  }

  async startCapture() {
    this.capturing = true;
    this.networkRequests = [];
    this.consoleLogs = [];

    const response = await new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'CAPTURE_NETWORK' }, resolve);
    });
    return response;
  }

  stopCapture() {
    this.capturing = false;
    return {
      networkRequests: this.networkRequests,
      consoleLogs: this.consoleLogs
    };
  }

  addNetworkRequest(req) { this.networkRequests.push(req); }
  addConsoleLog(log) { this.consoleLogs.push(log); }

  async run({ sessionData, actions = [] }) {
    const prompt = `Convert this browser session into a complete Playwright test.

**Session Data:**
${JSON.stringify(sessionData || {}, null, 2)}

**Recorded Actions:**
${JSON.stringify(actions, null, 2)}

**Network Requests (relevant):**
${JSON.stringify(this.networkRequests.slice(0, 20), null, 2)}

Generate a complete Playwright test that reproduces this session with:
1. Proper page navigation
2. Realistic user interactions
3. API interception if needed
4. Assertions that validate the key flows`;

    const result = await this.provider.complete({ system: this.buildSystemPrompt(), prompt, maxTokens: 4000 });
    this.record({ actions }, result);
    return result;
  }
}
