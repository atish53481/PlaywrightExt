import knex, { type Knex } from 'knex';
import pg from 'pg';

// int8 (bigint ids, count(*)) arrives as a string by default. Ids here stay far
// below 2^53, so plain numbers are safe and simpler to work with.
pg.types.setTypeParser(20, (value) => Number(value));

export type Db = Knex;

export function createDb(databaseUrl: string, acquireTimeoutMs = 10_000): Db {
  return knex({
    client: 'pg',
    connection: databaseUrl,
    pool: { min: 0, max: 10 },
    acquireConnectionTimeout: acquireTimeoutMs,
  });
}

/** True for PostgreSQL error 23505 (unique_violation). */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
