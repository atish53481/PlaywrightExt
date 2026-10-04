// Test Runner — parses generated Playwright code into steps and executes them
// on the active tab via the content script, so users can watch tests run live.

// A string literal ends at the quote it opened with: '[data-test="username"]' holds
// double quotes and is one string. A backslash escapes the character after it.
const STRING = `'(?:\\\\.|[^'\\\\])*'|"(?:\\\\.|[^"\\\\])*"|\`(?:\\\\.|[^\`\\\\])*\``;
// Call arguments: a bracket inside a string does not close the call.
const ARGS = `(?:${STRING}|[^)'"\`])*`;

function firstString(src) {
  const m = src.match(new RegExp(STRING));
  return m ? m[0].slice(1, -1).replace(/\\(.)/g, '$1') : null;
}

// Parses a locator expression like: page.getByRole('button', { name: 'Login' })
function parseLocator(expr) {
  // One part of a chain: the call, then .filter({ hasText }) and .first() / .last() / .nth(n) when they follow it.
  const PART = new RegExp(`\\.(getByRole|getByLabel|getByText|getByPlaceholder|getByAltText|getByTitle|getByTestId|locator)\\((${ARGS})\\)`
    + `(?:\\s*\\.filter\\(\\{\\s*hasText:\\s*(${STRING})\\s*\\}\\))?(?:\\s*\\.(first|last|nth)\\(\\s*(\\d*)\\s*\\))?`, 'g');
  const parts = [];
  for (const m of expr.matchAll(PART)) {
    const args = m[2];
    const value = firstString(args);
    if (value === null) return null;
    const nameMatch = args.match(new RegExp(`name:\\s*(${STRING})`));
    parts.push({
      method: m[1], value, name: nameMatch ? firstString(nameMatch[1]) : null,
      // getByRole('button', { name: 'Save', exact: true }) asks for the whole name, not a part of it.
      exact: /\bexact:\s*true\b/.test(args),
      hasText: m[3] ? firstString(m[3]) : null,
      // Which of several matches: null for the first there is, a number for .first() and .nth(n), 'last'.
      pick: !m[4] ? null : m[4] === 'last' ? 'last' : m[4] === 'nth' ? Number(m[5]) : 0,
    });
  }
  if (parts.length === 0) return null;
  // The first part, with the parts looked for inside it: page.getByRole('row').getByRole('button').
  return { ...parts[0], then: parts.slice(1), raw: expr.trim() };
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

      // A frame, a new tab, and the answer to a dialog are out of reach of a script in the page.
      if ((m = line.match(/\.(frameLocator|waitForEvent)\(|\b(page\d+)\.|\.once\('dialog'/))) {
        steps.push({ action: 'skip', label: `${line.slice(0, 70)} — runs only with the real Playwright runner (Run via Playwright)`, reason: 'needs-playwright' });
        continue;
      }

      // expect(page).toHaveURL(/\/dashboard/): the address is matched against the pattern.
      if ((m = line.match(/expect\(\s*page\s*\)\.(not\.)?toHaveURL\(\s*\/((?:\\.|[^/\\\n])+)\/([a-z]*)\s*\)/))) {
        steps.push({ action: 'assertURL', pattern: m[2], flags: m[3], url: m[2], negated: !!m[1], label: `Expect URL ${m[1] ? 'NOT ' : ''}to match /${m[2]}/` });
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
      if ((m = line.match(new RegExp(`expect\\(([^()]*\\(${ARGS}\\)[^()]*)\\)\\.(not\\.)?(toBeVisible|toBeHidden|toContainText|toHaveText|toHaveValue|toBeEnabled|toBeDisabled)\\((${ARGS})\\)`)))) {
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
      if ((m = line.match(new RegExp(`\\.(click|dblclick|fill|press|check|uncheck|selectOption|clear|hover)\\((${ARGS})\\)\\s*;?\\s*$`)))) {
        const locator = parseLocator(line);
        if (locator) {
          steps.push({
            action: m[1], locator, value: firstString(m[2] || ''),
            label: `${m[1]}${m[2] ? ` "${firstString(m[2]) ?? ''}"` : ''} → ${locator.raw.slice(0, 60)}`
          });
          continue;
        }
      }

      // A real drag, and choosing a file, cannot be done by a script in the page.
      if ((m = line.match(/\.(dragTo|setInputFiles)\(/))) {
        steps.push({ action: 'skip', label: `${m[1]}(...) — runs only with the real Playwright runner (Run via Playwright)`, reason: 'needs-playwright' });
        continue;
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
          // The page may still be on its way there: the address is looked at again for a few seconds.
          const holds = (url) => (step.pattern ? new RegExp(step.pattern, step.flags).test(url || '') : Boolean(url?.includes(step.url)));
          const deadline = Date.now() + 5000;
          let tab = await this.getActiveTab();
          while (holds(tab?.url) === step.negated && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 250));
            tab = await this.getActiveTab();
          }
          const matches = holds(tab?.url);
          if (step.negated ? matches : !matches) {
            throw new Error(`URL is "${tab?.url}", expected ${step.negated ? 'NOT ' : ''}to contain "${step.url}"`);
          }
        } else if (step.action === 'assertTitle') {
          const tab = await this.getActiveTab();
          if (!tab?.title?.includes(step.title)) throw new Error(`Title is "${tab?.title}", expected "${step.title}"`);
        } else {
          // The element may not be on the page yet (the step before opened a menu or a new view),
          // so a step that finds nothing is tried again for a few seconds, as Playwright does.
          const deadline = Date.now() + 5000;
          let resp = await this.sendToContent({ type: 'RUN_STEP', step });
          while (!resp?.ok && /^Element not found/.test(resp?.error || '') && Date.now() < deadline) {
            await new Promise(r => setTimeout(r, 250));
            resp = await this.sendToContent({ type: 'RUN_STEP', step });
          }
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
