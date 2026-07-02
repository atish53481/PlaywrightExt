import { AIProvider } from './base-provider.js';

export class GeminiProvider extends AIProvider {
  constructor(config = {}) {
    super(config);
    this.name = 'gemini';
    this.model = config.model || 'gemini-1.5-pro';
  }

  get apiUrl() {
    return `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
  }

  async complete({ system, prompt, maxTokens = 4000 }) {
    if (!this.isConfigured()) throw new Error('Gemini API key not configured');

    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{
          parts: [{ text: `${system}\n\n${prompt}` }]
        }],
        generationConfig: { maxOutputTokens: maxTokens }
      })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.error?.message || `Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    return data.candidates[0].content.parts[0].text;
  }

  isConfigured() { return this.apiKey?.length > 20; }
}
