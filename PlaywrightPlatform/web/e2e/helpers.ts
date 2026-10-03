import { expect, type APIRequestContext, type Locator, type Page } from '@playwright/test';

export interface Credentials {
  email: string;
  password: string;
}

// Must match E2E_USERS in server/src/scripts/e2e-serve.ts.
export const ADMIN: Credentials = { email: 'admin@e2e.test', password: 'Admin-e2e-pass1' };
export const USER: Credentials = { email: 'user@e2e.test', password: 'User-e2e-pass1' };
export const VIEWER: Credentials = { email: 'viewer@e2e.test', password: 'Viewer-e2e-pass1' };

export async function signIn(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}

type Headers = Record<string, string>;

// One API token per account for the whole run: the test database lives exactly as long as the run.
const tokens = new Map<string, Headers>();

/** Signs in through the API, as the extension does, and returns the request headers to use. */
export async function apiHeaders(request: APIRequestContext, creds: Credentials): Promise<Headers> {
  const cached = tokens.get(creds.email);
  if (cached) return cached;
  const res = await request.post('/api/auth/login', {
    data: { email: creds.email, password: creds.password, client: 'extension' },
  });
  expect(res.ok(), `API sign-in as ${creds.email}`).toBeTruthy();
  const headers = { Authorization: `Bearer ${(await res.json()).token}` };
  tokens.set(creds.email, headers);
  return headers;
}

/** Creates a project as the administrator and returns its id. */
export async function apiCreateProject(request: APIRequestContext, name: string): Promise<number> {
  const res = await request.post('/api/projects', { headers: await apiHeaders(request, ADMIN), data: { name } });
  expect(res.ok(), `API create project ${name}`).toBeTruthy();
  return (await res.json()).project.id;
}

export interface NewScript {
  name: string;
  content: string;
  description?: string;
  tags?: string[];
}

/** Creates a script as `creds` and returns its id. */
export async function apiCreateScript(
  request: APIRequestContext,
  creds: Credentials,
  projectId: number,
  script: NewScript,
): Promise<number> {
  const res = await request.post(`/api/projects/${projectId}/scripts`, {
    headers: await apiHeaders(request, creds),
    data: script,
  });
  expect(res.ok(), `API create script ${script.name}`).toBeTruthy();
  return (await res.json()).script.id;
}

/** Saves new content as `creds`, which creates the next version. */
export async function apiSaveContent(
  request: APIRequestContext,
  creds: Credentials,
  scriptId: number,
  content: string,
  baseVersion: number,
  changeSummary = '',
): Promise<void> {
  const res = await request.put(`/api/scripts/${scriptId}`, {
    headers: await apiHeaders(request, creds),
    data: { content, baseVersion, changeSummary },
  });
  expect(res.ok(), `API save script ${scriptId}`).toBeTruthy();
}

/** The table row of the script with exactly this name. */
export function scriptRow(page: Page, name: string): Locator {
  return page.getByRole('row').filter({ has: page.getByRole('link', { name, exact: true }) });
}

/** Replaces the whole text of the script editor, the way select-all followed by a paste does. */
export async function setEditorText(page: Page, text: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Script content' }).click();
  await page.keyboard.press('ControlOrMeta+A');
  await page.keyboard.insertText(text);
}
