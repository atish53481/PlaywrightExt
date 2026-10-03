import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table test_scripts (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      name text not null,
      description text not null default '',
      test_scenario text not null default '',
      script_content text not null,
      language text not null default 'TypeScript',
      framework text not null default 'Playwright',
      script_type text not null default 'E2E',
      version integer not null default 1 check (version >= 1),
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED', 'DELETED')),
      lifecycle_state text not null default 'DRAFT' check (lifecycle_state in
        ('DRAFT', 'GENERATED', 'SAVED', 'VALIDATED', 'READY', 'RUNNING', 'PASSED', 'FAILED', 'HEALING')),
      created_by bigint references users (id) on delete restrict,
      updated_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      deleted_by bigint references users (id) on delete restrict
    );
    create unique index test_scripts_live_name_uq
      on test_scripts (project_id, lower(name)) where status <> 'DELETED';
    create index test_scripts_project_status_idx on test_scripts (project_id, status);

    create table test_script_versions (
      id bigint generated always as identity primary key,
      script_id bigint not null references test_scripts (id) on delete restrict,
      version integer not null check (version >= 1),
      script_content text not null,
      change_summary text not null default '',
      source text not null default 'MANUAL' check (source in
        ('MANUAL', 'GENERATED', 'RECORDED', 'IMPORTED', 'HEALED', 'RESTORED')),
      created_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      unique (script_id, version)
    );

    create table tags (
      id bigint generated always as identity primary key,
      name text not null
    );
    create unique index tags_name_lower_uq on tags (lower(name));

    create table script_tags (
      script_id bigint not null references test_scripts (id) on delete restrict,
      tag_id bigint not null references tags (id) on delete restrict,
      primary key (script_id, tag_id)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists script_tags;
    drop table if exists tags;
    drop table if exists test_script_versions;
    drop table if exists test_scripts;
  `);
}
