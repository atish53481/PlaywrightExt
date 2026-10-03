import { describe, expect, it } from 'vitest';
import { createSecretBox } from '../src/crypto/secret-box';
import { testConfig } from './helpers';

describe('secret box', () => {
  const box = createSecretBox(Buffer.alloc(32, 7));

  it('round-trips text and never stores it readable', () => {
    const sealed = box.encrypt('jenkins-token-123');
    expect(sealed).not.toContain('jenkins-token-123');
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(box.decrypt(sealed)).toBe('jenkins-token-123');
  });

  it('gives a different ciphertext each time', () => {
    expect(box.encrypt('same')).not.toBe(box.encrypt('same'));
  });

  it('rejects a changed ciphertext, a wrong key, and text that is not a ciphertext', () => {
    const sealed = box.encrypt('secret');
    const parts = sealed.split(':');
    const body = Buffer.from(parts[3], 'base64');
    body[0] ^= 1;
    const changed = [parts[0], parts[1], parts[2], body.toString('base64')].join(':');
    expect(() => box.decrypt(changed)).toThrow();
    expect(() => createSecretBox(Buffer.alloc(32, 8)).decrypt(sealed)).toThrow();
    expect(() => box.decrypt('plain text')).toThrow('Stored secret is not readable.');
  });
});

describe('config: public URL', () => {
  it('defaults to the loopback address and port', () => {
    expect(testConfig({ APP_PORT: '3456' }).publicUrl).toBe('http://127.0.0.1:3456');
  });

  it('uses PLATFORM_PUBLIC_URL without its trailing slash', () => {
    expect(testConfig({ PLATFORM_PUBLIC_URL: 'http://build-host:3000/' }).publicUrl).toBe('http://build-host:3000');
  });

  it('refuses a value that is not an http or https URL', () => {
    expect(() => testConfig({ PLATFORM_PUBLIC_URL: 'ftp://x' })).toThrow();
  });
});
