import type { Db } from '../src/db';
import type { TestContext } from './helpers';

type Headers = Record<string, string>;

/** A small but realistic script body. */
export const SAMPLE = `import { test, expect } from '@playwright/test';

test('login', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveTitle(/Login/);
});
`;

export interface ScriptJson {
  id: number;
  projectId: number;
  name: string;
  version: number;
  content: string;
  tags: string[];
  [key: string]: unknown;
}

/** Creates a project through the API. `headers` must belong to an ADMIN. */
export async function newProject(ctx: TestContext, headers: Headers, name = 'Shop'): Promise<number> {
  const res = await ctx.app.inject({ method: 'POST', url: '/api/projects', headers, payload: { name } });
  if (res.statusCode !== 201) throw new Error(`project create failed: ${res.statusCode} ${res.body}`);
  return res.json().project.id;
}

/** POSTs a script with sensible defaults; `payload` overrides or adds fields. Returns the raw response. */
export function postScript(
  ctx: TestContext,
  headers: Headers,
  projectId: number,
  payload: Record<string, unknown> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/api/projects/${projectId}/scripts`,
    headers,
    payload: { name: 'Login Test', content: SAMPLE, ...payload },
  });
}

/** Like postScript, but throws unless the script was created, and returns it. */
export async function newScript(
  ctx: TestContext,
  headers: Headers,
  projectId: number,
  payload: Record<string, unknown> = {},
): Promise<ScriptJson> {
  const res = await postScript(ctx, headers, projectId, payload);
  if (res.statusCode !== 201) throw new Error(`script create failed: ${res.statusCode} ${res.body}`);
  return res.json().script;
}

/** Makes every audit insert fail, to prove that a change and its audit row commit together. */
export function breakAudit(db: Db) {
  return db.raw(`
    create or replace function test_fail_audit() returns trigger as $$
    begin raise exception 'audit store unavailable'; end; $$ language plpgsql;
    create trigger test_fail_audit before insert on audit_logs
      for each row execute function test_fail_audit();
  `);
}

export function repairAudit(db: Db) {
  return db.raw(`
    drop trigger if exists test_fail_audit on audit_logs;
    drop function if exists test_fail_audit();
  `);
}
