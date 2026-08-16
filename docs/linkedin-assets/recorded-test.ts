import { test, expect } from '@playwright/test';

test('Recorded Test', async ({ page }) => {
  await page.goto('https://www.saucedemo.com/');
  await page.getByPlaceholder('Username').fill('standard_user');
  await page.getByPlaceholder('Password').fill('secret_sauce');
  await page.locator('#login-button').click();
  await page.getByText('Add to cart').click();
  await page.getByText('Add to cart').click();
  await page.getByText('2').click();
  await page.getByText('Checkout').click();
  await page.getByPlaceholder('First Name').fill('QA');
  await page.getByPlaceholder('Last Name').fill('Manager');
  await page.getByPlaceholder('Zip/Postal Code').fill('560001');
  await page.locator('#continue').click();
  await page.getByText('Finish').click();
});