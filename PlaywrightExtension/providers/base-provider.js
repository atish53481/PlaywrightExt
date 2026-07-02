// Abstract AI provider interface

export class AIProvider {
  constructor(config = {}) {
    this.apiKey = config.apiKey || '';
    this.model = config.model || '';
    this.name = 'base';
  }

  async complete({ system, prompt, maxTokens = 4000 }) {
    throw new Error(`${this.constructor.name} must implement complete()`);
  }

  async *stream({ system, prompt, maxTokens = 4000 }) {
    const result = await this.complete({ system, prompt, maxTokens });
    yield result;
  }

  isConfigured() {
    return this.apiKey.length > 0;
  }

  getName() { return this.name; }
}
