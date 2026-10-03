import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { USER, VIEWER, apiCreateProject, apiCreateScript, apiSaveContent, signIn } from './helpers';

const V1 = "// first-version-marker\ntest('one', async () => {});\n";
const V2 = "// second-version-marker\ntest('one', async () => {});\n";

test('a user compares versions, downloads one, and restores the first', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `History ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Checkout', content: V1 });
  await apiSaveContent(request, USER, scriptId, V2, 1, 'Second take');

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await page.getByRole('link', { name: 'Version History' }).click();
  await expect(page.getByRole('heading', { name: 'Version History', level: 1 })).toBeVisible();
  await expect(page.getByText('Checkout · currently v2')).toBeVisible();

  // Newest first.
  const rows = page.getByRole('row');
  await expect(rows).toHaveCount(3); // the header row and two versions
  await expect(rows.nth(1)).toContainText('v2');
  await expect(rows.nth(1)).toContainText('Second take');
  await expect(rows.nth(1)).toContainText('E2E User');
  await expect(rows.nth(2)).toContainText('v1');
  await expect(rows.nth(2)).toContainText('MANUAL');

  // The default comparison is the latest version against the one before it.
  await expect(page.getByLabel('Older')).toHaveValue('1');
  await expect(page.getByLabel('Newer')).toHaveValue('2');
  await expect(page.getByRole('textbox', { name: 'Version 1' })).toContainText('first-version-marker');
  await expect(page.getByRole('textbox', { name: 'Version 2' })).toContainText('second-version-marker');

  // An old version downloads under a name that says which version it is.
  const downloading = page.waitForEvent('download');
  await rows.nth(2).getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('checkout.v1.spec.ts');
  expect(await readFile(await download.path(), 'utf8')).toBe(V1);

  // Only an older version can be restored, and only after confirming.
  await expect(rows.nth(1).getByRole('button', { name: 'Restore' })).toHaveCount(0);
  await rows.nth(2).getByRole('button', { name: 'Restore' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('This creates v3 with the content of v1.');
  await dialog.getByRole('button', { name: 'Restore' }).click();

  await expect(page.getByRole('status')).toHaveText('Restored v1 as v3.');
  await expect(rows).toHaveCount(4);
  await expect(rows.nth(1)).toContainText('v3');
  await expect(rows.nth(1)).toContainText('RESTORED');
  await expect(rows.nth(1)).toContainText('Restored from v1');
  await expect(page.getByLabel('Newer')).toHaveValue('3');
  await expect(page.getByRole('textbox', { name: 'Version 3' })).toContainText('first-version-marker');

  // Any two versions can be compared.
  await page.getByLabel('Older').selectOption('1');
  await expect(page.getByRole('textbox', { name: 'Version 1' })).toContainText('first-version-marker');

  // The script itself now shows the restored content.
  await page.getByRole('link', { name: 'Back to script' }).click();
  await expect(page.getByText('v3 ·')).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('first-version-marker');
});

test('a viewer can read the history but cannot restore', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `ViewHistory ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Checkout', content: V1 });
  await apiSaveContent(request, USER, scriptId, V2, 1);

  await signIn(page, VIEWER);
  await page.goto(`/scripts/${scriptId}/versions`);
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(page.getByRole('textbox', { name: 'Version 2' })).toContainText('second-version-marker');
  await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toHaveCount(2);
});

test('a script with one version says there is nothing to compare', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `OneVersion ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Fresh', content: V1 });

  await signIn(page, USER);
  await page.goto(`/scripts/${scriptId}/versions`);
  await expect(page.getByRole('row')).toHaveCount(2);
  await expect(page.getByText('This script has one version, so there is nothing to compare yet.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore' })).toHaveCount(0);
});

test('an unknown script shows a clear message on its history page', async ({ page }) => {
  await signIn(page, USER);
  await page.goto('/scripts/99999999/versions');
  await expect(page.getByRole('alert')).toHaveText('Script not found.');
  await expect(page.getByRole('link', { name: 'Back to projects' })).toBeVisible();
});
