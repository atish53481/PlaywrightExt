import type { z } from 'zod';
import { AppError } from './errors';

/** Validates request input. Throws a 400 AppError listing each problem. */
export function parse<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new AppError(
      400,
      'VALIDATION_ERROR',
      'Request validation failed.',
      result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
    );
  }
  return result.data;
}

/** Validates a response. A failure is a server bug, so it surfaces as a 500. */
export function shape<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`Response validation failed: ${JSON.stringify(result.error.issues)}`);
  }
  return result.data;
}
