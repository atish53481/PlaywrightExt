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
});
