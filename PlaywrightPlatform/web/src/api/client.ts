export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Kept in memory only. It is re-issued by /auth/me after a reload.
let csrfToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setCsrfToken(token: string | null): void {
  csrfToken = token;
}

/** Called when a request other than the auth probes comes back 401 (session ended). */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export interface ApiOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
}

/** Sends the request and returns the response, or throws an ApiError for anything but success. */
async function send(path: string, options: ApiOptions): Promise<Response> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken;

  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers,
      credentials: 'same-origin',
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
  } catch {
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server. Check that it is running and try again.', null);
  }

  if (!res.ok) {
    if (res.status === 401 && !path.startsWith('/auth/')) onUnauthorized?.();
    const data = await res.json().catch(() => null);
    const err = data?.error;
    throw new ApiError(
      res.status,
      err?.code ?? 'UNKNOWN',
      err?.message ?? `Request failed with status ${res.status}.`,
      err?.details ?? null,
    );
  }
  return res;
}

export async function api<T>(path: string, options: ApiOptions = {}): Promise<T> {
  const res = await send(path, options);
  if (res.status === 204) return undefined as T;
  return (await res.json().catch(() => null)) as T;
}

/** Fetches a file response and returns its text together with the file name the server chose. */
export async function apiDownload(path: string): Promise<{ fileName: string; text: string }> {
  const res = await send(path, {});
  const match = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '');
  return { fileName: match?.[1] ?? 'script.spec.ts', text: await res.text() };
}

/** Message suitable for showing to the user. A validation error shows its first specific problem. */
export function errorMessage(err: unknown): string {
  if (err instanceof ApiError && err.code === 'VALIDATION_ERROR' && Array.isArray(err.details)) {
    const first = (err.details as { message?: unknown }[])[0]?.message;
    if (typeof first === 'string') return first;
  }
  return err instanceof Error ? err.message : 'Unexpected error.';
}
