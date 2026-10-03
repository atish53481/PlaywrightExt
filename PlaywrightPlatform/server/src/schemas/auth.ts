import { z } from 'zod';
import { userDto } from './common';

export const loginBody = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(1).max(200),
  client: z.enum(['web', 'extension']),
});

export const webLoginResponse = z.object({ user: userDto, csrfToken: z.string() });
export const extensionLoginResponse = z.object({ user: userDto, token: z.string(), expiresAt: z.string() });
export const meResponse = z.object({ user: userDto, csrfToken: z.string().nullable() });
