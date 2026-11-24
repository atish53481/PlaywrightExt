import { test, expect } from '@playwright/test';
test('example', async ({ page }) => {
  await page.goto('https://example.com/');
  await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
});