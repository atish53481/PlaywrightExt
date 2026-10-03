import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table users (
      id bigint generated always as identity primary key,
      email text not null,
      display_name text not null,
      password_hash text not null,
      role text not null check (role in ('ADMIN', 'USER', 'VIEWER')),
      status text not null default 'ACTIVE' check (status in ('ACTIVE', 'DISABLED')),
      last_login_at timestamptz,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    );
    create unique index users_email_lower_uq on users (lower(email));

    create table sessions (
      id bigint generated always as identity primary key,
      user_id bigint not null references users (id) on delete restrict,
      token_hash text not null unique,
      kind text not null check (kind in ('WEB', 'EXTENSION')),
      csrf_secret text not null,
      expires_at timestamptz not null,
      revoked_at timestamptz,
      last_used_at timestamptz,
      created_at timestamptz not null default now()
    );
    create index sessions_user_id_idx on sessions (user_id);

    create table audit_logs (
      id bigint generated always as identity primary key,
      user_id bigint references users (id) on delete restrict,
      user_email text,
      action text not null,
      resource text not null,
      resource_id text,
      result text not null check (result in ('SUCCESS', 'FAILURE')),
      ip text,
      details jsonb,
      created_at timestamptz not null default now()
    );
    create index audit_logs_resource_idx on audit_logs (resource, resource_id);
    create index audit_logs_created_at_idx on audit_logs (created_at);
    create index audit_logs_user_id_idx on audit_logs (user_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists audit_logs;
    drop table if exists sessions;
    drop table if exists users;
  `);
}
