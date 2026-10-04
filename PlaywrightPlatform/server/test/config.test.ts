import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../src/config';

const key = Buffer.alloc(32, 1).toString('base64');

describe('loadConfig', () => {
  it('parses a valid environment and applies defaults', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost:5432/db',
      SECRETS_ENCRYPTION_KEY: key,
      CORS_ORIGINS: 'http://localhost:5173, http://localhost:3000 ',
    });
    expect(config.databaseUrl).toBe('postgresql://u:p@localhost:5432/db');
    expect(config.port).toBe(3000);
    expect(config.host).toBe('127.0.0.1');
    expect(config.nodeEnv).toBe('development');
    expect(config.loginRateLimitMax).toBe(10);
    expect(config.corsOrigins).toEqual(['http://localhost:5173', 'http://localhost:3000']);
    expect(config.secretsKey).toHaveLength(32);
  });

  it('reports every missing variable in one error', () => {
    let caught: unknown;
    try {
      loadConfig({});
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems.join('\n');
    expect(problems).toContain('DATABASE_URL');
    expect(problems).toContain('SECRETS_ENCRYPTION_KEY');
  });

  it('rejects an encryption key that is not 32 bytes', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: 'c2hvcnQ=' }),
    ).toThrow(/32 bytes/);
  });

  it('rejects an empty encryption key', () => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: '' }),
    ).toThrow(ConfigError);
  });

  it('defaults the Playwright Docker image to the current stable tag', () => {
    const config = loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: key });
    expect(config.playwrightDockerImage).toBe('mcr.microsoft.com/playwright:v1.63.0-noble');
  });

  it('reads a custom Playwright Docker image', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgresql://u:p@localhost/db',
      SECRETS_ENCRYPTION_KEY: key,
      PLAYWRIGHT_DOCKER_IMAGE: 'registry.example.com/team/playwright:v1.62.1-jammy',
    });
    expect(config.playwrightDockerImage).toBe('registry.example.com/team/playwright:v1.62.1-jammy');
  });

  it.each([
    ['a space', 'mcr.microsoft.com/playwright: v1.63.0'],
    ['a shell metacharacter', 'mcr.microsoft.com/playwright:v1.63.0;rm'],
    ['no tag', 'mcr.microsoft.com/playwright'],
    ['a bare name', 'playwright'],
    ['an empty tag', 'mcr.microsoft.com/playwright:'],
    ['a tag that names no version', 'mcr.microsoft.com/playwright:latest'],
    ['a quote', 'mcr.microsoft.com/playwright:v1.63.0"'],
    ['a percent sign', 'mcr.microsoft.com/playwright:v1.63.0%PATH%'],
  ])('rejects a Playwright Docker image with %s', (_label, image) => {
    expect(() =>
      loadConfig({ DATABASE_URL: 'postgresql://u:p@localhost/db', SECRETS_ENCRYPTION_KEY: key, PLAYWRIGHT_DOCKER_IMAGE: image }),
    ).toThrow(ConfigError);
  });
});
