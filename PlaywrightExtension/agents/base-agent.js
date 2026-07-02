// Base class for all AI agents

export class BaseAgent {
  constructor(name, provider) {
    this.name = name;
    this.provider = provider;
    this.history = [];
  }

  setProvider(provider) { this.provider = provider; }

  buildSystemPrompt() {
    return `You are a world-class QA automation expert specializing in Playwright testing.
You are part of Playwright AI Studio — an enterprise AI-powered QA platform.
Produce structured, production-ready, copy-paste-ready output.`;
  }

  async run(input) {
    throw new Error(`${this.name} must implement run()`);
  }

  record(input, output) {
    this.history.push({ input, output, ts: new Date().toISOString() });
    if (this.history.length > 20) this.history.shift();
  }

  getHistory() { return this.history; }
  clearHistory() { this.history = []; }
}
