import { z } from 'zod';
import type { User } from '../types';

/** PostgreSQL text cannot hold a NUL byte; reject it here so it is a 400, not a database error. */
export function cleanText(schema: z.ZodString) {
  return schema.refine((v) => !v.includes('\u0000'), { message: 'must not contain null characters' });
}

export const roleSchema =z.enum(['ADMIN', 'USER', 'VIEWER']);
export const userStatusSchema = z.enum(['ACTIVE', 'DISABLED']);

/**
 * An id in an address: digits only, so "1e2", "0x10", and "01" are not other spellings of an
 * id. The length keeps absurd values from reaching PostgreSQL as out-of-range bigints.
 */
export const pathId = z
  .string()
  .regex(/^[1-9]\d{0,15}$/, 'must be a positive whole number')
  .transform(Number)
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));

export const idParams = z.object({ id: pathId });

export const userDto = z.object({
  id: z.number(),
  email: z.string(),
  displayName: z.string(),
  role: roleSchema,
  status: userStatusSchema,
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export function toUserDto(user: User): z.infer<typeof userDto> {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    lastLoginAt: user.lastLoginAt ? user.lastLoginAt.toISOString() : null,
    createdAt: user.createdAt.toISOString(),
  };
}
