import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table projects (
      id bigint generated always as identity primary key,
      name text not null,
      description text not null default '',
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED', 'DELETED')),
      auto_use_skills boolean not null default true,
      created_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      deleted_at timestamptz,
      deleted_by bigint references users (id) on delete restrict
    );
    create unique index projects_live_name_uq on projects (lower(name)) where status <> 'DELETED';
    create index projects_status_idx on projects (status);

    create table project_environments (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      name text not null check (name in ('DEV', 'QA', 'UAT', 'STAGING', 'PRODUCTION')),
      base_url text not null,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      unique (project_id, name)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists project_environments;
    drop table if exists projects;
  `);
}
