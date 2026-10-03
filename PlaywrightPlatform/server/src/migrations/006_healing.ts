import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table healing_proposals (
      id bigint generated always as identity primary key,
      script_id bigint not null references test_scripts (id) on delete restrict,
      base_version integer not null,
      execution_id bigint references test_executions (id) on delete restrict,
      proposed_content text not null,
      summary text not null default '',
      status text not null default 'PENDING' check (status in ('PENDING', 'ACCEPTED', 'REJECTED')),
      resulting_version integer,
      created_by bigint references users (id) on delete restrict,
      reviewed_by bigint references users (id) on delete restrict,
      created_at timestamptz not null default now(),
      reviewed_at timestamptz
    );
    create index healing_proposals_script_status_idx on healing_proposals (script_id, status);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`drop table if exists healing_proposals;`);
}
