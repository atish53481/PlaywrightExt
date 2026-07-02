import { BaseAgent } from './base-agent.js';

export class FrameworkAgent extends BaseAgent {
  constructor(provider) {
    super('Framework', provider);
  }

  buildSystemPrompt() {
    return `You are a Playwright framework architect. Analyze automation frameworks and generate/improve them.
Evaluate: code quality, maintainability, test coverage, anti-patterns, duplicate code, locator quality, configuration, reporting, CI/CD readiness.
Provide actionable recommendations with code examples.`;
  }

  async run({ code = '', action = 'analyze', language = 'typescript', options = {} }) {
    const prompts = {
      analyze: `Analyze this Playwright framework and provide a detailed quality report with improvement recommendations:\n\n${code}`,
      generate: `Generate a complete, production-ready Playwright ${language} automation framework with:\n- Page Object Model\n- Fixtures\n- API layer\n- Utilities\n- Config\n- CI/CD pipeline\n${options.bdd ? '- BDD with Cucumber\n' : ''}${options.visual ? '- Visual testing\n' : ''}`,
      improve: `Improve this Playwright framework code. Fix anti-patterns, improve locators, add missing best practices:\n\n${code}`,
    };

    const result = await this.provider.complete({
      system: this.buildSystemPrompt(),
      prompt: prompts[action] || prompts.analyze,
      maxTokens: 8000
    });
    this.record({ action, language }, result);
    return result;
  }
}
