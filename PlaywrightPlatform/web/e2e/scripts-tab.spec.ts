import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import {
  ADMIN,
  USER,
  VIEWER,
  apiCreateProject,
  apiCreateScript,
  apiHeaders,
  scriptRow,
  signIn,
} from './helpers';

const CHECKOUT = "// checkout\ntest('checkout', async () => {});\n";

function totalScripts(page: Page) {
  return page.locator('.card', { hasText: 'Total Scripts' }).locator('.stat-value');
}

test('scripts are listed, found by search and tag, duplicated, downloaded, and deleted', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Tab ${Date.now()}`);
  await apiCreateScript(request, USER, projectId, {
    name: 'Login Test',
    content: '// login\n',
    description: 'Signs in',
    tags: ['smoke'],
  });
  await apiCreateScript(request, USER, projectId, { name: 'Checkout Flow', content: CHECKOUT, tags: ['regression'] });

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}`);
  await expect(totalScripts(page)).toHaveText('2');

  await page.getByRole('tab', { name: 'Scripts' }).click();
  await expect(page).toHaveURL(/\?tab=scripts$/);
  const login = scriptRow(page, 'Login Test');
  const checkout = scriptRow(page, 'Checkout Flow');
  await expect(login).toContainText('v1');
  await expect(login).toContainText('SAVED');
  await expect(login).toContainText('smoke');
  await expect(login).toContainText('E2E User');
  await expect(login.getByRole('button', { name: 'Run' })).toBeDisabled();
  await expect(login.getByRole('button', { name: 'Heal' })).toBeDisabled();

  // The tab is part of the address, so it survives a reload.
  await page.reload();
  await expect(login).toBeVisible();

  // Search matches a description and a tag name.
  const search = page.getByPlaceholder('Search scripts...');
  await search.fill('signs in');
  await expect(checkout).toHaveCount(0);
  await expect(login).toBeVisible();
  await search.fill('regression');
  await expect(login).toHaveCount(0);
  await expect(checkout).toBeVisible();
  await search.fill('');

  // The tag filter matches one tag; clicking a tag in a row sets the same filter.
  const tagFilter = page.getByLabel('Tag', { exact: true });
  await tagFilter.selectOption('smoke');
  await expect(checkout).toHaveCount(0);
  await expect(login).toBeVisible();
  await tagFilter.selectOption('');
  await checkout.getByRole('button', { name: 'regression' }).click();
  await expect(tagFilter).toHaveValue('regression');
  await expect(login).toHaveCount(0);
  await tagFilter.selectOption('');

  // Duplicate offers the default name, and reports a taken name inside the dialog.
  const dialog = page.getByRole('dialog');
  await login.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dialog.getByLabel('Name')).toHaveValue('Login Test (copy)');
  await dialog.getByRole('button', { name: 'Duplicate' }).click();
  await expect(scriptRow(page, 'Login Test (copy)')).toBeVisible();
  await login.getByRole('button', { name: 'Duplicate' }).click();
  await dialog.getByRole('button', { name: 'Duplicate' }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists in this project');
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  // Download hands over the exact content under a safe file name.
  const downloading = page.waitForEvent('download');
  await checkout.getByRole('button', { name: 'Download' }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe('checkout-flow.spec.ts');
  expect(await readFile(await download.path(), 'utf8')).toBe(CHECKOUT);

  // Delete asks first.
  await checkout.getByRole('button', { name: 'Delete' }).click();
  await expect(dialog).toContainText('This will remove the script from the project.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(checkout).toBeVisible();
  await checkout.getByRole('button', { name: 'Delete' }).click();
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(checkout).toHaveCount(0);

  // The overview counts what is left: the original and its copy.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await expect(totalScripts(page)).toHaveText('2');
});

test('paging walks through a list longer than one page', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Paging ${Date.now()}`);
  for (let n = 1; n <= 27; n += 1) {
    await apiCreateScript(request, USER, projectId, { name: `Script ${String(n).padStart(2, '0')}`, content: '// x\n' });
  }

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await expect(page.getByText('1–25 of 27')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(26); // the header row and 25 scripts
  await expect(page.getByRole('button', { name: 'Previous' })).toBeDisabled();

  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByText('26–27 of 27')).toBeVisible();
  await expect(page.getByRole('row')).toHaveCount(3);
  await expect(scriptRow(page, 'Script 01')).toBeVisible(); // the least recently updated comes last
  await expect(page.getByRole('button', { name: 'Next' })).toBeDisabled();

  await page.getByRole('button', { name: 'Previous' }).click();
  await expect(page.getByText('1–25 of 27')).toBeVisible();
});

test('a viewer sees scripts but no way to change them', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Viewer ${Date.now()}`);
  await apiCreateScript(request, USER, projectId, { name: 'Visible', content: '// x\n' });

  await signIn(page, VIEWER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  const row = scriptRow(page, 'Visible');
  await expect(row).toBeVisible();
  await expect(row.getByRole('link', { name: 'View' })).toBeVisible();
  await expect(row.getByRole('link', { name: 'Version History' })).toBeVisible();
  await expect(row.getByRole('button', { name: 'Download' })).toBeVisible();

  for (const name of ['New Script', 'Edit']) {
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0);
  }
  for (const name of ['Import', 'Record', 'Generate', 'Duplicate', 'Delete']) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
});

test('an archived project shows its scripts read-only, even to a writer', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Archived ${Date.now()}`);
  await apiCreateScript(request, USER, projectId, { name: 'Frozen', content: '// x\n' });
  const archived = await request.put(`/api/projects/${projectId}`, {
    headers: await apiHeaders(request, ADMIN),
    data: { status: 'ARCHIVED' },
  });
  expect(archived.ok()).toBeTruthy();

  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await expect(scriptRow(page, 'Frozen')).toBeVisible();
  await expect(page.getByText('This project is archived, so its scripts cannot be changed.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'New Script' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete' })).toHaveCount(0);
});

test('Record and Generate explain the extension, and an empty project says it is empty', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Hints ${Date.now()}`);
  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await expect(page.getByText('No scripts yet.')).toBeVisible();

  const dialog = page.getByRole('dialog');
  await page.getByRole('button', { name: 'Record' }).click();
  await expect(dialog).toContainText('Recorder');
  await expect(dialog).toContainText('Save to Project');
  await dialog.getByRole('button', { name: 'Close' }).click();

  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(dialog).toContainText('Generator');
  await dialog.getByRole('button', { name: 'Close' }).click();
  await expect(dialog).toBeHidden();
});
