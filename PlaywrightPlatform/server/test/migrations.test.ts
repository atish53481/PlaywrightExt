import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, type Db } from '../src/db';
import { migrateLatest, rollbackAll } from '../src/migrate';
import { PLATFORM_TABLES } from '../src/migrations/tables';
import { resetDb, testConfig } from './helpers';

async function existingTables(db: Db): Promise<string[]> {
  const rows = await db('information_schema.tables')
    .where({ table_schema: 'public' })
    .select('table_name');
  return rows.map((r: { table_name: string }) => r.table_name);
}

describe('migrations', () => {
  let db: Db;
  beforeAll(() => {
    db = createDb(testConfig().databaseUrl);
  });
  afterAll(async () => {
    await migrateLatest(db);
    await db.destroy();
  });

  it('declares exactly the 22 tables in the spec', () => {
    expect(PLATFORM_TABLES).toHaveLength(22);
    expect(new Set(PLATFORM_TABLES).size).toBe(22);
  });

  it('rollback removes every platform table and migrate recreates them', async () => {
    await rollbackAll(db);
    const afterRollback = await existingTables(db);
    for (const table of PLATFORM_TABLES) expect(afterRollback).not.toContain(table);

    await migrateLatest(db);
    const afterMigrate = await existingTables(db);
    for (const table of PLATFORM_TABLES) expect(afterMigrate).toContain(table);
  });

  describe('constraints', () => {
    beforeAll(async () => {
      await migrateLatest(db);
      await resetDb(db);
    });

    const user = { email: 'a@example.com', display_name: 'A', password_hash: 'x', role: 'ADMIN' };

    it('rejects an unknown role', async () => {
      await expect(db('users').insert({ ...user, email: 'b@example.com', role: 'ROOT' })).rejects.toThrow();
    });

    it('treats emails as case-insensitive unique', async () => {
      await db('users').insert(user);
      await expect(db('users').insert({ ...user, email: 'A@EXAMPLE.COM' })).rejects.toThrow();
    });

    it('allows a project name to be reused only after the first is deleted', async () => {
      const [first] = await db('projects').insert({ name: 'Shop' }).returning('id');
      await expect(db('projects').insert({ name: 'shop' })).rejects.toThrow();
      await db('projects').where({ id: first.id }).update({ status: 'DELETED' });
      await expect(db('projects').insert({ name: 'shop' })).resolves.toBeDefined();
    });

    it('requires project_id exactly when a skill is project-scoped', async () => {
      const base = { name: 'S', content: '# s' };
      await expect(db('skills').insert({ ...base, scope: 'PROJECT' })).rejects.toThrow();
      const project = await db('projects').where({ status: 'ACTIVE' }).first('id');
      await expect(
        db('skills').insert({ ...base, scope: 'GLOBAL', project_id: project.id }),
      ).rejects.toThrow();
      await expect(db('skills').insert({ ...base, scope: 'GLOBAL' })).resolves.toBeDefined();
    });

    it('refuses a Jenkins configuration with no credential source', async () => {
      const base = { name: 'local', base_url: 'http://localhost:8080', username: 'u' };
      await expect(db('jenkins_configurations').insert(base)).rejects.toThrow();
      await expect(
        db('jenkins_configurations').insert({ ...base, credential_reference: 'JENKINS_API_TOKEN' }),
      ).resolves.toBeDefined();
    });

    it('refuses to hard-delete a project that has scripts', async () => {
      const project = await db('projects').where({ status: 'ACTIVE' }).first('id');
      await db('test_scripts').insert({ project_id: project.id, name: 'Login', script_content: '// x' });
      await expect(db('projects').where({ id: project.id }).del()).rejects.toThrow();
    });
  });
});
