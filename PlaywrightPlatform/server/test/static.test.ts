import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app';
import { createDb, type Db } from '../src/db';
import { testConfig } from './helpers';

const SENTINEL = 'TOP-SECRET-SENTINEL-outside-web-root';

describe('serving the built web app', () => {
  let base: string;
  let webRoot: string;
  let app: FastifyInstance;
  let db: Db;

  beforeAll(async () => {
    // A file beside (not inside) the web root. No request may ever return it.
    base = mkdtempSync(path.join(os.tmpdir(), 'pw-web-'));
    writeFileSync(path.join(base, 'secret.txt'), SENTINEL);
    webRoot = path.join(base, 'web');
    mkdirSync(webRoot);
    writeFileSync(path.join(webRoot, 'index.html'), '<!doctype html><title>Platform</title>');
    mkdirSync(path.join(webRoot, 'assets'));
    writeFileSync(path.join(webRoot, 'assets', 'app.js'), 'console.log("app")');

    const config = testConfig();
    db = createDb(config.databaseUrl);
    app = await buildApp({ config, db, webRoot });
  });
  afterAll(async () => {
    await app.close();
    await db.destroy();
    rmSync(base, { recursive: true, force: true });
  });

  it('serves index.html at the root and real asset files', async () => {
    const index = await app.inject({ method: 'GET', url: '/' });
    expect(index.statusCode).toBe(200);
    expect(index.body).toContain('<title>Platform</title>');

    const asset = await app.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset.statusCode).toBe(200);
    expect(asset.body).toContain('console.log');
  });

  it('falls back to index.html for client-side routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/projects/5' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<title>Platform</title>');
  });

  it('still answers unknown API routes and non-GET requests with JSON 404', async () => {
    const api = await app.inject({ method: 'GET', url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error.code).toBe('NOT_FOUND');

    const post = await app.inject({ method: 'POST', url: '/projects/5' });
    expect(post.statusCode).toBe(404);
    expect(post.json().error.code).toBe('NOT_FOUND');
  });

  it.each([
    '/../secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e/secret.txt',
    '/%2e%2e%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets/../../secret.txt',
    '/assets/..%2f..%2fsecret.txt',
  ])('never returns a file from outside the web root (%s)', async (url) => {
    const res = await app.inject({ method: 'GET', url });
    expect(res.body).not.toContain(SENTINEL);
  });
});
