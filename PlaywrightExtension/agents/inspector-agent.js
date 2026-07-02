import { BaseAgent } from './base-agent.js';

export class InspectorAgent extends BaseAgent {
  constructor(provider) {
    super('Inspector', provider);
  }

  buildSystemPrompt() {
    return `You are a Playwright locator expert. Analyze DOM elements and generate optimal Playwright locators.
Priority: data-testid > ARIA role > aria-label > placeholder > text > id > name > CSS class (never CSS class unless last resort).
Always rank locators by quality score (0-100). Include accessibility analysis.`;
  }

  async run({ elementInfo, html = '', url = '' }) {
    if (elementInfo && elementInfo.locators) {
      return this._formatLocatorResults(elementInfo);
    }

    const prompt = `Analyze this DOM element and generate ranked Playwright locators.

**Element HTML:**
\`\`\`html
${html || '<element>No HTML provided</element>'}
\`\`\`

**Page URL:** ${url || 'Unknown'}

Generate:
1. Top 5 locator strategies ranked by quality (score 0-100)
2. Recommended Playwright code
3. Accessibility assessment
4. Suggested data-testid value if none exists`;

    const result = await this.provider.complete({ system: this.buildSystemPrompt(), prompt, maxTokens: 2000 });
    this.record({ html, url }, result);
    return result;
  }

  _formatLocatorResults(elementInfo) {
    const { locators = [], tag, text, id, ariaLabel } = elementInfo;
    const sorted = [...locators].sort((a, b) => b.score - a.score);

    let output = `## Element Inspector Results\n\n`;
    if (sorted[0]) {
      output += `### Best Locator (Recommended)\n\`\`\`javascript\npage.${sorted[0].locator}\n\`\`\`\n`;
      output += `**Score: ${sorted[0].score}/100** — ${this._scoreLabel(sorted[0].score)}\n\n`;
    }
    output += `### All Options (Ranked)\n| Rank | Strategy | Locator | Score |\n|------|----------|---------|-------|\n`;
    sorted.forEach((l, i) => {
      output += `| ${i+1} | ${l.strategy} | \`${l.locator}\` | ${l.score} |\n`;
    });
    output += `\n### Element Info\n- **Tag:** ${tag || 'Unknown'}\n- **Text:** ${text || '-'}\n`;
    if (id) output += `- **ID:** ${id}\n`;
    if (ariaLabel) output += `- **ARIA Label:** ${ariaLabel}\n`;
    return output;
  }

  _scoreLabel(score) {
    if (score >= 90) return 'Excellent — semantic, resilient';
    if (score >= 70) return 'Good — stable locator';
    if (score >= 50) return 'Fair — may break on minor changes';
    return 'Poor — brittle, avoid if possible';
  }
}
