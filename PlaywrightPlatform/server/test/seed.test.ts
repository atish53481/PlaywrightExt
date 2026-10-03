import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db';
import { seedAdmin } from '../src/seed';
import { verifyPassword } from '../src/security/passwords';
import { resetDb, testConfig } from './helpers';

describe('seedAdmin', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(testConfig().databaseUrl);
  });
  afterAll(() => db.destroy());
  beforeEach(() => resetDb(db));

  const env = { ADMIN_EMAIL: 'root@example.com', ADMIN_PASSWORD: 'a-long-admin-password' };

  it('creates one ADMIN with a hashed password', async () => {
    expect(await seedAdmin(db, env)).toBe('created');
    const rows = await db('users').select('*');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ email: 'root@example.com', role: 'ADMIN', status: 'ACTIVE' });
    expect(rows[0].password_hash).not.toContain(env.ADMIN_PASSWORD);
    expect(await verifyPassword(rows[0].password_hash, env.ADMIN_PASSWORD)).toBe(true);
  });

  it('does nothing when that user already exists', async () => {
    await seedAdmin(db, env);
    expect(await seedAdmin(db, { ...env, ADMIN_PASSWORD: 'a-different-password' })).toBe('exists');
    const rows = await db('users').select('password_hash');
    expect(rows).toHaveLength(1);
    expect(await verifyPassword(rows[0].password_hash, env.ADMIN_PASSWORD)).toBe(true);
  });

  it('fails clearly when the variables are missing or the password is short', async () => {
    await expect(seedAdmin(db, {})).rejects.toThrow(/ADMIN_EMAIL and ADMIN_PASSWORD/);
    await expect(seedAdmin(db, { ADMIN_EMAIL: 'a@example.com', ADMIN_PASSWORD: 'short' })).rejects.toThrow(
      /at least 8/,
    );
  });
});
