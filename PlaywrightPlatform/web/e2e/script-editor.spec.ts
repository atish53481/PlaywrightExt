import { expect, test } from '@playwright/test';
import {
  ADMIN,
  USER,
  VIEWER,
  apiCreateProject,
  apiCreateScript,
  apiHeaders,
  apiSaveContent,
  scriptRow,
  setEditorText,
  signIn,
} from './helpers';

const V1 = [
  "import { test, expect } from '@playwright/test';",
  '',
  "test('first-version-marker', async ({ page }) => {",
  "  await page.goto('/login');",
  '});',
  '',
].join('\n');
const V2 = V1.replace('first-version-marker', 'second-version-marker');

test('a user creates a script, saves a second version, and is asked before losing changes', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Editor ${Date.now()}`);
  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  await page.getByRole('link', { name: 'New Script' }).click();
  await expect(page.getByRole('heading', { name: 'New Script', level: 1 })).toBeVisible();

  // An empty script is refused before anything is sent.
  await page.getByLabel('Script Name').fill('Login Test');
  await page.getByRole('button', { name: 'Create Script' }).click();
  await expect(page.getByRole('alert')).toHaveText('Add the script content before saving.');

  await page.getByLabel('Description').fill('Signs in');
  await page.getByLabel('Tags', { exact: true }).fill('smoke');
  await page.getByLabel('Tags', { exact: true }).press('Enter');
  await expect(page.getByRole('button', { name: 'Remove tag smoke' })).toBeVisible();
  await setEditorText(page, V1);
  await page.getByRole('button', { name: 'Create Script' }).click();

  // The new script opens read-only.
  await expect(page.getByRole('heading', { name: 'Login Test', level: 1 })).toBeVisible();
  await expect(page.getByText('v1 ·')).toBeVisible();
  await expect(page.getByText('smoke', { exact: true })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('first-version-marker');
  await expect(editor).toHaveAttribute('contenteditable', 'false');

  // Edit mode: Save is offered only once something has changed.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page).toHaveURL(/\?edit=1$/);
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  const save = page.getByRole('button', { name: 'Save' });
  await expect(save).toBeDisabled();
  await setEditorText(page, V2);
  await page.getByLabel('Change summary (optional)').fill('Rename the test');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Saved as v2.');
  await expect(page.getByText('v2 ·')).toBeVisible();
  await expect(editor).toContainText('second-version-marker');
  await expect(save).toBeDisabled();

  // A metadata change saves without creating a version.
  await page.getByLabel('Description').fill('Signs in and out');
  await save.click();
  await expect(page.getByRole('status')).toHaveText('Saved.');
  await expect(page.getByText('v2 ·')).toBeVisible();

  // Leaving with unsaved text asks first.
  await setEditorText(page, '// throwaway-marker\n');
  await page.getByRole('link', { name: 'Back to scripts' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Discard unsaved changes?');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(editor).toContainText('throwaway-marker');
  await page.getByRole('link', { name: 'Back to scripts' }).click();
  await dialog.getByRole('button', { name: 'Discard changes' }).click();
  await expect(scriptRow(page, 'Login Test')).toContainText('v2');
});

test('an imported file fills the new-script form and is stored as IMPORTED', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Import ${Date.now()}`);
  await signIn(page, USER);
  await page.goto(`/projects/${projectId}?tab=scripts`);
  const picker = page.getByLabel('Import script file');

  await picker.setInputFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await expect(page.getByRole('alert')).toHaveText('Choose a .ts, .js, .mjs, or .cjs file.');
  await picker.setInputFiles({ name: 'empty.ts', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
  await expect(page.getByRole('alert')).toHaveText('That file is empty.');

  // Windows line endings, as a file saved on Windows has.
  await picker.setInputFiles({
    name: 'checkout.spec.js',
    mimeType: 'text/javascript',
    buffer: Buffer.from("// imported-marker\r\ntest('checkout', async () => {});\r\n"),
  });
  await expect(page.getByRole('heading', { name: 'Import Script', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Script Name')).toHaveValue('checkout');
  await expect(page.getByLabel('Language')).toHaveValue('JavaScript');
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('imported-marker');
  await page.getByRole('button', { name: 'Create Script' }).click();
  await expect(page.getByRole('heading', { name: 'checkout', level: 1 })).toBeVisible();

  // Opening it for editing shows no unsaved change: the line endings were normalised.
  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(editor).toHaveAttribute('contenteditable', 'true');
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();

  const scriptId = Number(/\/scripts\/(\d+)/.exec(page.url())?.[1]);
  const versions = await request.get(`/api/scripts/${scriptId}/versions`, {
    headers: await apiHeaders(request, USER),
  });
  expect((await versions.json()).items).toMatchObject([{ version: 1, source: 'IMPORTED' }]);
});

test('a viewer sees a script read-only with no way to change it', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `ReadOnly ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Visible', content: V1, tags: ['smoke'] });

  await signIn(page, VIEWER);
  await page.goto(`/scripts/${scriptId}?edit=1`); // asking for edit mode changes nothing for a viewer
  await expect(page.getByRole('heading', { name: 'Visible', level: 1 })).toBeVisible();
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('first-version-marker');
  await expect(editor).toHaveAttribute('contenteditable', 'false');
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  await expect(page.getByLabel('Script Name')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download' })).toBeVisible();

  // The new-script page sends a viewer back to the list.
  await page.goto(`/projects/${projectId}/scripts/new`);
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}\\?tab=scripts$`));
});

test('a save that collides with a newer version keeps the text and can reload the latest', async ({ page, request }) => {
  const projectId = await apiCreateProject(request, `Conflict ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Shared', content: V1 });

  await signIn(page, USER);
  await page.goto(`/scripts/${scriptId}?edit=1`);
  const editor = page.getByRole('textbox', { name: 'Script content' });
  await expect(editor).toContainText('first-version-marker');
  await setEditorText(page, '// my-marker\n');

  await apiSaveContent(request, ADMIN, scriptId, '// their-marker\n', 1);

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('E2E Admin saved v2 while you were editing.');
  await expect(editor).toContainText('my-marker');

  await page.getByRole('button', { name: 'Reload latest' }).click();
  await expect(editor).toContainText('their-marker');
  await expect(page.getByText('v2 ·')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
});

test('after a conflict from another browser, the two texts can be compared and mine kept', async ({ page, browser, request }) => {
  const projectId = await apiCreateProject(request, `Compare ${Date.now()}`);
  const scriptId = await apiCreateScript(request, USER, projectId, { name: 'Shared', content: V1 });

  await signIn(page, USER);
  await page.goto(`/scripts/${scriptId}?edit=1`);
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('first-version-marker');
  await setEditorText(page, '// my-marker\n');

  // Someone else saves first, in a separate browser session.
  const otherContext = await browser.newContext();
  const other = await otherContext.newPage();
  await signIn(other, ADMIN);
  await other.goto(`/scripts/${scriptId}?edit=1`);
  await expect(other.getByRole('textbox', { name: 'Script content' })).toContainText('first-version-marker');
  await setEditorText(other, '// their-marker\n');
  await other.getByRole('button', { name: 'Save' }).click();
  await expect(other.getByRole('status')).toHaveText('Saved as v2.');
  await otherContext.close();

  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('alert')).toContainText('E2E Admin saved v2 while you were editing.');
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('my-marker');

  await page.getByRole('button', { name: 'Compare with latest' }).click();
  await expect(page.getByRole('textbox', { name: 'Latest version' })).toContainText('their-marker');
  await expect(page.getByRole('textbox', { name: 'Your text' })).toContainText('my-marker');

  await page.getByRole('button', { name: 'Keep my text' }).click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByRole('status')).toHaveText('Saved as v3.');
  await expect(page.getByRole('textbox', { name: 'Script content' })).toContainText('my-marker');
});
