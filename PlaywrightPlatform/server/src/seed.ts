import type { Db } from './db';
import { UserRepository } from './repositories/user-repository';
import { hashPassword } from './security/passwords';

/** Creates the first ADMIN from ADMIN_EMAIL / ADMIN_PASSWORD. Safe to run repeatedly. */
export async function seedAdmin(
  db: Db,
  env: Record<string, string | undefined>,
): Promise<'created' | 'exists'> {
  const email = env.ADMIN_EMAIL?.trim();
  const password = env.ADMIN_PASSWORD;
  if (!email || !password) {
    throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD must be set in .env to seed the first admin.');
  }
  if (password.length < 8) {
    throw new Error('ADMIN_PASSWORD must be at least 8 characters.');
  }

  const users = new UserRepository(db);
  if (await users.findByEmail(email)) return 'exists';

  await users.create({
    email,
    displayName: 'Administrator',
    passwordHash: await hashPassword(password),
    role: 'ADMIN',
  });
  return 'created';
}
