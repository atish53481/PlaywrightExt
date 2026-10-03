import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table skills (
      id bigint generated always as identity primary key,
      name text not null,
      description text not null default '',
      scope text not null check (scope in ('GLOBAL', 'PROJECT')),
      project_id bigint references projects (id) on delete restrict,
      file_name text,
      content text not null,
      version integer not null default 1 check (version >= 1),
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ARCHIVED')),
      created_by bigint references users (id) on delete restrict,
      updated_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint skills_scope_project_check check (
        (scope = 'PROJECT' and project_id is not null) or (scope = 'GLOBAL' and project_id is null)
      )
    );
    create index skills_scope_status_idx on skills (scope, status);
    create index skills_project_id_idx on skills (project_id);

    create table skill_versions (
      id bigint generated always as identity primary key,
      skill_id bigint not null references skills (id) on delete restrict,
      version integer not null check (version >= 1),
      content text not null,
      change_summary text not null default '',
      created_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      unique (skill_id, version)
    );

    create table skill_tags (
      skill_id bigint not null references skills (id) on delete restrict,
      tag_id bigint not null references tags (id) on delete restrict,
      primary key (skill_id, tag_id)
    );

    create table project_skills (
      project_id bigint not null references projects (id) on delete restrict,
      skill_id bigint not null references skills (id) on delete restrict,
      enabled boolean not null default true,
      priority integer not null default 100,
      created_at timestamptz not null default now(),
      primary key (project_id, skill_id)
    );
    create index project_skills_priority_idx on project_skills (project_id, priority);

    create table script_skills (
      script_id bigint not null,
      script_version integer not null,
      skill_id bigint not null,
      skill_version integer not null,
      primary key (script_id, script_version, skill_id, skill_version),
      foreign key (script_id, script_version)
        references test_script_versions (script_id, version) on delete restrict,
      foreign key (skill_id, skill_version)
        references skill_versions (skill_id, version) on delete restrict
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists script_skills;
    drop table if exists project_skills;
    drop table if exists skill_tags;
    drop table if exists skill_versions;
    drop table if exists skills;
  `);
}
