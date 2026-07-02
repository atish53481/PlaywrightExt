// Test Runner — parses generated Playwright code into steps and executes them
// on the active tab via the content script, so users can watch tests run live.

function firstString(src) {
  const m = src.match(/['"`]([^'"`]*)['"`]/);
  return m ? m[1] : null;
}

// Parses a locator expression like: page.getByRole('button', { name: 'Login' })
function parseLocator(expr) {
  const m = expr.match(/\.(getByRole|getByLabel|getByText|getByPlaceholder|getByTestId|locator)\(([^)]*)\)/);
  if (!m) return null;
  const method = m[1];
  const args = m[2];
  const value = firstString(args);
  if (value === null) return null;
  const nameMatch = args.match(/name:\s*['"`]([^'"`]+)['"`]/);
  return { method, value, name: nameMatch ? nameMatch[1] : null, raw: expr.trim() };
}

export const TestRunner = {

  // Extracts executable steps from AI-generated Playwright code.
  // Lines it cannot execute (page-object calls, fixtures) become 'skipped' steps.
  parse(code) {
    // Prefer fenced code blocks if the output is markdown
    const fences = [...code.matchAll(/```(?:typescript|javascript|ts|js)?\n([\s\S]*?)```/g)];
    const source = fences.length ? fences.map(f => f[1]).join('\n') : code;

    const steps = [];
    for (const rawLine of source.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('//') || line.startsWith('import') || line.startsWith('*')) continue;

      let m;

      if ((m = line.match(/page\.goto\(\s*['"`]([^'"`]+)/))) {
        steps.push({ action: 'goto', url: m[1], label: `Navigate to ${m[1]}` });
        continue;
      }

      if ((m = line.match(/expect\(\s*page\s*\)\.(not\.)?toHaveURL\(\s*['"`]?([^'"`)]+)/))) {
        steps.push({ action: 'assertURL', url: m[2], negated: !!m[1], label: `Expect URL ${m[1] ? 'NOT ' : ''}to contain "${m[2]}"` });
        continue;
      }

      if ((m = line.match(/expect\(\s*page\s*\)\.toHaveTitle\(\s*['"`]([^'"`]+)/))) {
        steps.push({ action: 'assertTitle', title: m[1], label: `Expect title "${m[1]}"` });
        continue;
      }

      // expect(<locator>).<assertion>(...)
      if ((m = line.match(/expect\(([^)]*\([^)]*\)[^)]*)\)\.(not\.)?(toBeVisible|toBeHidden|toContainText|toHaveText|toHaveValue|toBeEnabled|toBeDisabled)\((.*?)\)/))) {
        const locator = parseLocator(m[1]);
        if (locator) {
          steps.push({
            action: 'assert', locator, assertion: m[3], negated: !!m[2],
            expected: firstString(m[4] || ''),
            label: `Expect ${locator.raw.slice(0, 60)} ${m[2] ? 'not.' : ''}${m[3]}${m[4] ? `(${m[4].slice(0, 30)})` : ''}`
          });
          continue;
        }
      }

      // <locator>.click() / .fill('x') / .press('Enter') / .check() / .selectOption('x')
      if ((m = line.match(/\.(click|dblclick|fill|press|check|uncheck|selectOption|clear|hover)\(([^)]*)\)\s*;?\s*$/))) {
        const locator = parseLocator(line);
        if (locator) {
          steps.push({
            action: m[1], locator, value: firstString(m[2] || ''),
            label: `${m[1]}${m[2] ? ` "${firstString(m[2]) ?? ''}"` : ''} → ${locator.raw.slice(0, 60)}`
          });
          continue;
        }
      }

      // Unresolvable calls (page objects like loginPage.login(...)) — report, don't fail
      if ((m = line.match(/await\s+(\w+)\.(\w+)\(/)) && m[1] !== 'page' && m[1] !== 'expect') {
        steps.push({ action: 'skip', label: `${m[1]}.${m[2]}(...) — page-object call, cannot run directly`, reason: 'page-object' });
      }
    }
    return steps;
  },

  sendToContent(payload) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'RELAY_TO_CONTENT', payload }, resp => {
        resolve(resp || { error: chrome.runtime.lastError?.message || 'No response from page' });
      });
    });
  },

  getActiveTab() {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type: 'GET_ACTIVE_TAB' }, tab => resolve(tab));
    });
  },

  async waitForPageReady(timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const info = await this.sendToContent({ type: 'GET_PAGE_INFO' });
      if (info?.readyState === 'complete') return true;
      await new Promise(r => setTimeout(r, 400));
    }
    return false;
  },

  // Runs steps sequentially. onStep(index, status, detail) fires per step:
  // status = 'running' | 'passed' | 'failed' | 'skipped'
  async run(steps, onStep) {
    const summary = { passed: 0, failed: 0, skipped: 0 };

    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      onStep(i, 'running');

      if (step.action === 'skip') {
        summary.skipped++;
        onStep(i, 'skipped', step.reason);
        continue;
      }

      try {
        if (step.action === 'goto') {
          const tab = await this.getActiveTab();
          if (!tab?.id) throw new Error('No active tab');
          let url = step.url;
          // Relative path from generated code — resolve against current tab origin
          if (url.startsWith('/')) url = new URL(url, tab.url).href;
          await chrome.tabs.update(tab.id, { url });
          await new Promise(r => setTimeout(r, 800));
          await this.waitForPageReady();
        } else if (step.action === 'assertURL') {
          const tab = await this.getActiveTab();
          const matches = tab?.url?.includes(step.url);
          if (step.negated ? matches : !matches) {
            throw new Error(`URL is "${tab?.url}", expected ${step.negated ? 'NOT ' : ''}to contain "${step.url}"`);
          }
        } else if (step.action === 'assertTitle') {
          const tab = await this.getActiveTab();
          if (!tab?.title?.includes(step.title)) throw new Error(`Title is "${tab?.title}", expected "${step.title}"`);
        } else {
          const resp = await this.sendToContent({ type: 'RUN_STEP', step });
          if (!resp?.ok) throw new Error(resp?.error || 'Step failed on page');
        }
        summary.passed++;
        onStep(i, 'passed');
      } catch (e) {
        summary.failed++;
        onStep(i, 'failed', e.message);
      }
    }
    return summary;
  }
};
