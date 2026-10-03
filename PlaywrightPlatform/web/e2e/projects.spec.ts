import { expect, test } from '@playwright/test';
import { ADMIN, VIEWER, signIn } from './helpers';

test('an admin creates, opens, finds, edits, and archives a project', async ({ page }) => {
  const name = `Shop ${Date.now()}`;
  await signIn(page, ADMIN);

  await page.getByRole('button', { name: 'Create Project' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(dialog.getByLabel('Project Name')).toBeFocused(); // required field blocks an empty submit

  await dialog.getByLabel('Project Name').fill(name);
  await dialog.getByLabel('Description').fill('E2E automation');
  await dialog.getByRole('button', { name: 'Create Project' }).click();

  // Lands on the project dashboard.
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
  await expect(page.getByText('Total Scripts')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Scripts' })).toBeVisible();
  await page.getByRole('tab', { name: 'CI/CD' }).click();
  await expect(page.getByText('CI/CD is not available yet.')).toBeVisible();

  // Found by search in the list.
  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByPlaceholder('Search projects...').fill(name);
  const row = page.getByRole('row', { name: new RegExp(name) });
  await expect(row).toBeVisible();
  await expect(row.getByText('ACTIVE')).toBeVisible();

  // A duplicate name shows the server's message inside the dialog.
  await page.getByRole('button', { name: 'Create Project' }).click();
  await dialog.getByLabel('Project Name').fill(name.toUpperCase());
  await dialog.getByRole('button', { name: 'Create Project' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Edit.
  await row.getByRole('button', { name: 'Edit' }).click();
  await dialog.getByLabel('Description').fill('Edited description');
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();

  // Archive needs confirmation, then the project leaves the ACTIVE list.
  await row.getByRole('button', { name: 'Archive' }).click();
  await expect(dialog).toContainText(`Archive "${name}"?`);
  await dialog.getByRole('button', { name: 'Archive' }).click();
  await expect(row).toHaveCount(0);

  await page.getByLabel('Status').selectOption('ARCHIVED');
  await expect(page.getByRole('row', { name: new RegExp(name) })).toBeVisible();
});

test('an admin deletes a project after confirming', async ({ page }) => {
  const name = `Doomed ${Date.now()}`;
  await signIn(page, ADMIN);
  await page.getByRole('button', { name: 'Create Project' }).click();
  await page.getByRole('dialog').getByLabel('Project Name').fill(name);
  await page.getByRole('dialog').getByRole('button', { name: 'Create Project' }).click();
  await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();

  await page.getByRole('link', { name: 'Projects' }).click();
  const row = page.getByRole('row', { name: new RegExp(name) });
  await row.getByRole('button', { name: 'Delete' }).click();
  await expect(page.getByRole('dialog')).toContainText('This will remove the project');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Delete' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(row).toHaveCount(0);
});

test('a viewer can browse but sees no way to change anything', async ({ page }) => {
  await signIn(page, VIEWER);
  await expect(page.getByRole('button', { name: 'Refresh' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create Project' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: 'Settings' })).toHaveCount(0);
});

test('when the session ends, the next action returns the user to the login page', async ({ page, context }) => {
  await signIn(page, ADMIN);
  await context.clearCookies();
  await page.getByRole('button', { name: 'Refresh' }).click();
  await expect(page).toHaveURL(/\/login$/);
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
});

test('an unknown project id shows a clear message', async ({ page }) => {
  await signIn(page, ADMIN);
  await page.goto('/projects/99999999');
  await expect(page.getByRole('alert')).toHaveText('Project not found.');
  await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
});
