export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(what: string): AppError {
  return new AppError(404, 'NOT_FOUND', `${what} not found.`);
}
