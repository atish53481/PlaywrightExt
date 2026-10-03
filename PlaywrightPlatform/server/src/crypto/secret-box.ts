import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export interface SecretBox {
  encrypt(text: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * AES-256-GCM. The stored form is `v1:<iv>:<tag>:<data>`, each part base64.
 * A changed ciphertext or a different key makes decrypt throw.
 */
export function createSecretBox(key: Buffer): SecretBox {
  return {
    encrypt(text) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
      return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
    },
    decrypt(ciphertext) {
      const [version, iv, tag, data] = ciphertext.split(':');
      if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Stored secret is not readable.');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
    },
  };
}
