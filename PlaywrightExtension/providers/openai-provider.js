import { AIProvider } from './base-provider.js';

export class OpenAIProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'openai';
    this.model = config.model || 'gpt-4o';
    this.apiUrl = 'https://api.openai.com/v1/chat/completions';
  }

  async complete({ system, prompt, maxTokens = 4000 }) {
    if (!this.isConfigured()) throw new Error('OpenAI API key not configured');

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt }
        ]
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `OpenAI API error: ${response.status}`);
    }

    const data = await response.json();
    return data.choices[0].message.content;
  }

  isConfigured() { return this.apiKey?.startsWith('sk-'); }
}
