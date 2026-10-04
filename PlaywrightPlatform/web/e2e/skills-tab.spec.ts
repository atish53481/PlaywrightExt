import { expect, test, type Page } from '@playwright/test';
import { ADMIN, USER, VIEWER, apiCreateProject, apiHeaders, signIn } from './helpers';

const RULES = '# Rules\n- Use getByRole().\n';

function skillRow(page: Page, name: string) {
  return page.getByRole('row').filter({ hasText: name });
}

test('a skill is created, switched off, edited into a new version, restored, and archived', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Skills ${Date.now()}`);
  await signIn(page, USER);
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('tab', { name: 'Skills' }).click();
  await expect(page).toHaveURL(/\?tab=skills$/);
  await expect(page.getByText('No skills yet.')).toBeVisible();

  await page.getByRole('button', { name: 'New Skill' }).click();
  await page.getByLabel('Skill name').fill('Login rules');
  await page.getByLabel('Skill text').fill(RULES);
  await page.getByLabel('Tags').fill('smoke, Auth');
  await page.getByRole('button', { name: 'Save skill' }).click();

  const row = skillRow(page, 'Login rules');
  await expect(row).toContainText('Project');
  await expect(row).toContainText('v1');
  await expect(row).toContainText('Auth');
  await expect(row).toContainText('smoke');

  // Switched on for the project from the start; switching it off survives a reload.
  const use = row.getByRole('checkbox', { name: 'Use Login rules in this project' });
  await expect(use).toBeChecked();
  await use.uncheck();
  await page.reload();
  await expect(skillRow(page, 'Login rules').getByRole('checkbox')).not.toBeChecked();

  // Search by tag, then by something that is not there.
  await page.getByLabel('Search skills').fill('auth');
  await expect(skillRow(page, 'Login rules')).toBeVisible();
  await page.getByLabel('Search skills').fill('no-such-skill');
  await expect(page.getByText('No skills match the search.')).toBeVisible();
  await page.getByLabel('Search skills').fill('');

  // New text is a new version.
  await skillRow(page, 'Login rules').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByRole('heading', { name: 'Login rules · v1' })).toBeVisible();
  await page.getByLabel('Skill text').fill(`${RULES}- No XPath.\n`);
  await page.getByLabel('What changed').fill('No XPath');
  await page.getByRole('button', { name: 'Save skill' }).click();
  await expect(page.getByRole('heading', { name: 'Login rules · v2' })).toBeVisible();
  await expect(page.getByText('No XPath', { exact: true })).toBeVisible();

  // Restoring writes the old text as a new version.
  await page.getByRole('button', { name: 'Restore v1' }).click();
  await expect(page.getByRole('heading', { name: 'Login rules · v3' })).toBeVisible();
  await expect(page.getByLabel('Skill text')).toHaveValue(RULES);

  // Archive asks once more.
  await page.getByRole('button', { name: 'Archive' }).click();
  await page.getByRole('button', { name: 'Confirm archive' }).click();
  await expect(page.getByText('No skills yet.')).toBeVisible();
});

test('a viewer reads skills but changes nothing, and a global skill is offered to every project', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Skills RO ${Date.now()}`);
  const globalName = `Standards ${Date.now()}`;
  const made = await request.post('/api/skills', {
    headers: await apiHeaders(request, ADMIN),
    data: { name: globalName, content: RULES },
  });
  expect(made.ok()).toBeTruthy();
  const own = await request.post(`/api/projects/${projectId}/skills`, {
    headers: await apiHeaders(request, USER),
    data: { name: 'Cart rules', content: RULES },
  });
  expect(own.ok()).toBeTruthy();

  await signIn(page, VIEWER);
  await page.goto(`/projects/${projectId}?tab=skills`);
  const global = skillRow(page, globalName);
  await expect(global).toContainText('Global');
  // Not in use until someone switches it on for this project.
  await expect(global.getByRole('checkbox')).not.toBeChecked();
  await expect(global.getByRole('checkbox')).toBeDisabled();
  await expect(skillRow(page, 'Cart rules').getByRole('checkbox')).toBeChecked();
  await expect(page.getByRole('button', { name: 'New Skill' })).toHaveCount(0);

  await skillRow(page, 'Cart rules').getByRole('button', { name: 'Open' }).click();
  await expect(page.getByLabel('Skill text')).toHaveValue(RULES);
  await expect(page.getByLabel('Skill text')).not.toBeEditable();
  await expect(page.getByRole('button', { name: 'Save skill' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Archive' })).toHaveCount(0);
});
