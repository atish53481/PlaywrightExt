import { BaseAgent } from './base-agent.js';

export class ExportAgent extends BaseAgent {
  constructor(provider) {
    super('Export/Import', provider);
  }

  exportAsMarkdown(content, filename = 'export') {
    this._download(content, `${filename}.md`, 'text/markdown');
  }

  exportAsJSON(data, filename = 'export') {
    this._download(JSON.stringify(data, null, 2), `${filename}.json`, 'application/json');
  }

  exportAsCode(code, language = 'typescript', filename = 'test') {
    const extensions = { typescript: 'ts', javascript: 'js', python: 'py', java: 'java', csharp: 'cs' };
    const ext = extensions[language] || 'txt';
    this._download(code, `${filename}.${ext}`, 'text/plain');
  }

  exportAsCSV(rows, filename = 'test-cases') {
    if (!rows || rows.length === 0) return;
    const headers = Object.keys(rows[0]).join(',');
    const body = rows.map(r => Object.values(r).map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    this._download(`${headers}\n${body}`, `${filename}.csv`, 'text/csv');
  }

  async copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      return false;
    }
  }

  _download(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async run({ content, format = 'markdown', filename = 'playwright-export' }) {
    switch (format) {
      case 'markdown': this.exportAsMarkdown(content, filename); break;
      case 'json':     this.exportAsJSON(content, filename); break;
      case 'code':     this.exportAsCode(content, 'typescript', filename); break;
      default:         this._download(String(content), `${filename}.txt`, 'text/plain');
    }
    return `Exported as ${filename}.${format}`;
  }
}
