import { z } from 'zod';
import type { User } from '../types';

export const roleSchema = z.enum(['ADMIN', 'USER', 'VIEWER']);
export const userStatusSchema = z.enum(['ACTIVE', 'DISABLED']);

/** Path ids. The upper bound keeps absurd values from reaching PostgreSQL as out-of-range bigints. */
export const idParams = z.object({
  id: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
});

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
