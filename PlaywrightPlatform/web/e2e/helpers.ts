import { expect, type Page } from '@playwright/test';

export interface Credentials {
  email: string;
  password: string;
}

// Must match E2E_USERS in server/src/scripts/e2e-serve.ts.
export const ADMIN: Credentials = { email: 'admin@e2e.test', password: 'Admin-e2e-pass1' };
export const VIEWER: Credentials = { email: 'viewer@e2e.test', password: 'Viewer-e2e-pass1' };

export async function signIn(page: Page, creds: Credentials): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(creds.email);
  await page.getByLabel('Password').fill(creds.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Projects', level: 1 })).toBeVisible();
}
