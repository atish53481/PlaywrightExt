import { expect, test } from '@playwright/test';
import { ADMIN, signIn } from './helpers';

test('an admin creates a USER who can then sign in with limited rights', async ({ page }) => {
  const email = `tester${Date.now()}@e2e.test`;
  const password = 'Tester-e2e-pass1';

  await signIn(page, ADMIN);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Users', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Create User' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Display Name').fill('E2E Tester');
  await dialog.getByLabel('Password').fill(password);
  await dialog.getByLabel('Role').selectOption('USER');
  await dialog.getByRole('button', { name: 'Create User' }).click();

  const row = page.getByRole('row', { name: new RegExp(email) });
  await expect(row).toBeVisible();
  await expect(row.getByText('USER', { exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Sign out' }).click();
  await signIn(page, { email, password });
  await expect(page.getByRole('button', { name: 'Create Project' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
});

test('an admin can disable a user, and the last admin is protected', async ({ page }) => {
  const email = `temp${Date.now()}@e2e.test`;
  await signIn(page, ADMIN);
  await page.getByRole('link', { name: 'Settings' }).click();

  await page.getByRole('button', { name: 'Create User' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Email').fill(email);
  await dialog.getByLabel('Display Name').fill('Temp');
  await dialog.getByLabel('Password').fill('Temp-e2e-pass1');
  await dialog.getByRole('button', { name: 'Create User' }).click();

  const row = page.getByRole('row', { name: new RegExp(email) });
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Status').selectOption('DISABLED');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('DISABLED')).toBeVisible();

  const adminRow = page.getByRole('row', { name: new RegExp(ADMIN.email) });
  await adminRow.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Role').selectOption('VIEWER');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog.getByRole('alert')).toContainText('last active administrator');
});
