import { z } from 'zod';
import { cleanText, roleSchema, userDto, userStatusSchema } from './common';

const displayName = cleanText(z.string().trim().min(1, 'Display name is required.').max(120));
const password = z.string().min(8, 'Password must be at least 8 characters.').max(200);

export const createUserBody = z.object({
  email: z.string().trim().email().max(254),
  displayName,
  password,
  role: roleSchema,
});

export const updateUserBody = z
  .object({
    displayName: displayName.optional(),
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
    password: password.optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Provide at least one field to change.',
  });

export const userResponse = z.object({ user: userDto });
export const userListResponse = z.object({ items: z.array(userDto) });
