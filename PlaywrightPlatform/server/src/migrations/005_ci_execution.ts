import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    create table jenkins_configurations (
      id bigint generated always as identity primary key,
      name text not null unique,
      base_url text not null,
      username text not null,
      credential_reference text,
      secret_ciphertext text,
      job_name text,
      folder text,
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now(),
      constraint jenkins_credential_source_check check (
        credential_reference is not null or secret_ciphertext is not null
      )
    );

    create table project_ci_jobs (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      jenkins_configuration_id bigint not null references jenkins_configurations (id) on delete restrict,
      job_name text not null,
      folder text not null default '',
      enabled boolean not null default true,
      created_at timestamptz not null default now(),
      unique (project_id, jenkins_configuration_id, job_name, folder)
    );

    create table test_executions (
      id bigint generated always as identity primary key,
      project_id bigint not null references projects (id) on delete restrict,
      script_id bigint references test_scripts (id) on delete restrict,
      script_version integer,
      jenkins_job_id bigint references project_ci_jobs (id) on delete restrict,
      jenkins_build_number integer,
      jenkins_queue_id bigint,
      ci_provider text not null default 'JENKINS',
      trigger_type text not null check (trigger_type in ('MANUAL', 'JENKINS', 'SCHEDULED', 'API')),
      status text not null default 'QUEUED' check (status in
        ('QUEUED', 'RUNNING', 'PASSED', 'FAILED', 'ABORTED', 'ERROR')),
      stage text not null default 'QUEUED' check (stage in
        ('QUEUED', 'STARTING', 'RUNNING', 'TEST_EXECUTION', 'GENERATING_REPORT', 'COMPLETED')),
      environment text,
      browser text,
      tags text[] not null default '{}',
      total_tests integer not null default 0,
      passed_tests integer not null default 0,
      failed_tests integer not null default 0,
      skipped_tests integer not null default 0,
      report_url text,
      error_message text,
      callback_token_hash text,
      triggered_by bigint references users (id) on delete restrict,
      started_at timestamptz,
      completed_at timestamptz,
      duration bigint,
      created_at timestamptz not null default now()
    );
    create index test_executions_project_created_idx on test_executions (project_id, created_at desc);
    create index test_executions_status_idx on test_executions (status);
    create index test_executions_script_id_idx on test_executions (script_id);

    create table execution_scripts (
      execution_id bigint not null references test_executions (id) on delete restrict,
      script_id bigint not null references test_scripts (id) on delete restrict,
      script_version integer not null,
      primary key (execution_id, script_id, script_version)
    );

    create table execution_results (
      id bigint generated always as identity primary key,
      execution_id bigint not null references test_executions (id) on delete restrict,
      script_id bigint references test_scripts (id) on delete restrict,
      test_name text not null,
      status text not null check (status in ('PASSED', 'FAILED', 'SKIPPED')),
      duration bigint,
      error_message text,
      stack_trace text,
      screenshot_path text,
      video_path text,
      trace_path text,
      created_at timestamptz not null default now()
    );
    create index execution_results_execution_id_idx on execution_results (execution_id);

    create table execution_logs (
      id bigint generated always as identity primary key,
      execution_id bigint not null references test_executions (id) on delete restrict,
      level text not null default 'info',
      message text not null,
      created_at timestamptz not null default now()
    );
    create index execution_logs_execution_created_idx on execution_logs (execution_id, created_at);

    create table execution_skill_snapshots (
      execution_id bigint not null references test_executions (id) on delete restrict,
      skill_id bigint not null references skills (id) on delete restrict,
      skill_version integer not null,
      skill_name text not null,
      primary key (execution_id, skill_id)
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    drop table if exists execution_skill_snapshots;
    drop table if exists execution_logs;
    drop table if exists execution_results;
    drop table if exists execution_scripts;
    drop table if exists test_executions;
    drop table if exists project_ci_jobs;
    drop table if exists jenkins_configurations;
  `);
}
