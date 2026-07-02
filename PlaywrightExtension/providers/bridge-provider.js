import { AIProvider } from './base-provider.js';
import { BridgeClient } from '../utils/bridge-client.js';

// LLM provider backed by the local Playwright Bridge, which shells out to the
// user's locally installed Claude Code CLI. No API key stored in the extension —
// ideal for local development; published users switch to their own key provider.
export class BridgeProvider extends AIProvider {
  constructor() {
    super({ apiKey: 'local-bridge', model: 'claude-code-local' });
    this.name = 'bridge';
  }

  async complete({ system, prompt, maxTokens = 8000 }) {
    try {
      return await BridgeClient.complete({ system, prompt });
    } catch (e) {
      throw new Error(`Bridge LLM failed: ${e.message}`);
    }
  }

  isConfigured() { return true; }
}
