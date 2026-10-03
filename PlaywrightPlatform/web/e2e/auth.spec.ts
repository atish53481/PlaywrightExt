import { expect, test } from '@playwright/test';
import { ADMIN, signIn } from './helpers';

test('an unauthenticated visitor is sent to the login page', async ({ page }) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('a wrong password shows the server message and stays on the login page', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('definitely-wrong');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password.');
  await expect(page).toHaveURL(/\/login$/);
});

test('an admin signs in, sees the shell, survives a reload, and signs out', async ({ page }) => {
  await signIn(page, ADMIN);
  await expect(page.getByText(ADMIN.email)).toBeVisible();
  await expect(page.getByText('ADMIN', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Settings' })).toBeVisible();

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/login$/);
});
