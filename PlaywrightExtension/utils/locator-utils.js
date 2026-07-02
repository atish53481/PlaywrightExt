export const LocatorUtils = {
  scoreLocator(locator) {
    let score = 0;
    if (locator.includes('data-testid') || locator.includes('data-test')) score += 100;
    else if (locator.includes('getByRole') || locator.includes("role='")) score += 90;
    else if (locator.includes('aria-label') || locator.includes('getByLabel')) score += 85;
    else if (locator.includes('placeholder') || locator.includes('getByPlaceholder')) score += 70;
    else if (locator.includes('getByText') || locator.includes("text='")) score += 60;
    else if (locator.match(/^#[a-z]/i)) score += 55;
    else if (locator.includes('[id=')) score += 50;
    else if (locator.includes('[name=')) score += 45;
    if (locator.includes('nth=') || locator.includes(':nth-')) score -= 30;
    if ((locator.match(/\s*>\s*/g) || []).length > 2) score -= 20;
    return Math.max(0, score);
  },

  generateLocators(el) {
    const locators = [];
    if (el.getAttribute?.('data-testid')) {
      locators.push({ strategy: 'data-testid', locator: `locator('[data-testid="${el.getAttribute('data-testid')}"]')`, score: 100 });
    }
    if (el.getAttribute?.('aria-label')) {
      locators.push({ strategy: 'aria-label', locator: `getByLabel('${el.getAttribute('aria-label')}')`, score: 85 });
    }
    if (el.getAttribute?.('placeholder')) {
      locators.push({ strategy: 'placeholder', locator: `getByPlaceholder('${el.getAttribute('placeholder')}')`, score: 70 });
    }
    if (el.getAttribute?.('role')) {
      const name = el.textContent?.trim().slice(0, 50);
      locators.push({ strategy: 'role', locator: name ? `getByRole('${el.getAttribute('role')}', { name: '${name}' })` : `getByRole('${el.getAttribute('role')}')`, score: 90 });
    }
    if (el.id) {
      locators.push({ strategy: 'id', locator: `locator('#${el.id}')`, score: 55 });
    }
    if (el.getAttribute?.('name')) {
      locators.push({ strategy: 'name', locator: `locator('[name="${el.getAttribute('name')}"]')`, score: 45 });
    }
    const text = el.textContent?.trim().slice(0, 50);
    if (text && ['BUTTON','A','LABEL','H1','H2','H3'].includes(el.tagName)) {
      locators.push({ strategy: 'text', locator: `getByText('${text.replace(/'/g, "\\'")}')`, score: 60 });
    }
    return locators.sort((a, b) => b.score - a.score);
  },

  bestLocator(el) {
    return this.generateLocators(el)[0] || { strategy: 'tag', locator: `locator('${el.tagName?.toLowerCase() || 'div'}')`, score: 0 };
  }
};
