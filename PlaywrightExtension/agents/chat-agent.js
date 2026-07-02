import { BaseAgent } from './base-agent.js';

export class ChatAgent extends BaseAgent {
  constructor(provider) {
    super('AI Chat', provider);
    this.conversationHistory = [];
  }

  buildSystemPrompt() {
    return `You are PlaywrightBot — an expert QA automation AI assistant embedded in Playwright AI Studio.
You specialize in:
- Playwright (TypeScript, JavaScript, Python, Java, C#)
- Page Object Model, BDD, Component Object Model
- API Testing, Performance Testing, Visual Testing, Accessibility Testing
- CI/CD (GitHub Actions, Jenkins, Azure DevOps, Docker)
- Framework architecture, best practices, anti-patterns

Always provide working code examples. Be concise and practical. Format code in markdown code blocks with language tags.`;
  }

  async run({ message, language = 'typescript' }) {
    this.conversationHistory.push({ role: 'user', content: message });

    const historyContext = this.conversationHistory.slice(-6)
      .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
      .join('\n\n');

    const prompt = `${historyContext}\n\nUser: ${message}\n\nProvide a helpful, accurate response with code examples where relevant.`;

    const result = await this.provider.complete({ system: this.buildSystemPrompt(), prompt, maxTokens: 4000 });
    this.conversationHistory.push({ role: 'assistant', content: result });
    if (this.conversationHistory.length > 20) this.conversationHistory.splice(0, 2);
    return result;
  }

  clearConversation() {
    this.conversationHistory = [];
  }
}
