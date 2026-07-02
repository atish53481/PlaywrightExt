import { AIProvider } from './base-provider.js';

export class ClaudeProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'claude';
    this.model = config.model || 'claude-sonnet-4-6';
    this.apiUrl = 'https://api.anthropic.com/v1/messages';
  }

  async complete({ system, prompt, maxTokens = 4000 }) {
    if (!this.isConfigured()) throw new Error('Claude API key not configured');

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        system: system,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Claude API error: ${response.status}`);
    }

    const data = await response.json();
    return data.content[0].text;
  }

  isConfigured() { return this.apiKey?.startsWith('sk-ant-'); }
}
