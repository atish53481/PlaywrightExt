import type { Knex } from 'knex';
import * as m001 from './001_identity_audit';
import * as m002 from './002_projects';
import * as m003 from './003_scripts';
import * as m004 from './004_skills';
import * as m005 from './005_ci_execution';
import * as m006 from './006_healing';

export interface Migration {
  name: string;
  up(knex: Knex): Promise<void>;
  down(knex: Knex): Promise<void>;
}

/** Ordered list. Append new migrations; never edit or reorder shipped ones. */
export const migrations: Migration[] = [
  { name: '001_identity_audit', up: m001.up, down: m001.down },
  { name: '002_projects', up: m002.up, down: m002.down },
  { name: '003_scripts', up: m003.up, down: m003.down },
  { name: '004_skills', up: m004.up, down: m004.down },
  { name: '005_ci_execution', up: m005.up, down: m005.down },
  { name: '006_healing', up: m006.up, down: m006.down },
];

// Migrations are plain imports rather than files Knex discovers on disk, so the
// same code runs under tsx, Vitest, and the compiled build with no loader setup.
export const migrationSource: Knex.MigrationSource<Migration> = {
  getMigrations: async () => migrations,
  getMigrationName: (migration) => migration.name,
  getMigration: async (migration) => migration,
};
