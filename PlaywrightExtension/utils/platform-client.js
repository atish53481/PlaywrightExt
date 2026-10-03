// HTTP client for the Playwright Platform backend (PlaywrightPlatform/server).
// The only extension file that knows the platform API. The password is sent
// once at sign-in and never stored; only the bearer token is kept.

import { Storage } from './storage.js';

function normalizeUrl(url) {
  const trimmed = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) {
    throw new Error('Platform URL must start with http:// or https://');
  }
  return trimmed;
}

export function createPlatformClient({ fetchFn, storage }) {
  async function request(baseUrl, path, { method = 'GET', token = '', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;

    let res;
    try {
      res = await fetchFn(`${baseUrl}/api${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new Error(`Cannot reach the platform at ${baseUrl}. Is the server running?`);
    }

    if (res.status === 204) return { status: 204, data: null };
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Platform request failed (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return { status: res.status, data };
  }

  async function signedIn() {
    const platform = await storage.getPlatform();
    if (!platform.url || !platform.token) throw new Error('Sign in to the platform first (Settings → Platform).');
    return platform;
  }

  return {
    async login(url, email, password) {
      const baseUrl = normalizeUrl(url);
      const { data } = await request(baseUrl, '/auth/login', {
        method: 'POST',
        body: { email, password, client: 'extension' },
      });
      await storage.savePlatform({ url: baseUrl, token: data.token, user: data.user });
      return data.user;
    },

    async logout() {
      const platform = await storage.getPlatform();
      if (platform.url && platform.token) {
        try {
          await request(platform.url, '/auth/logout', { method: 'POST', token: platform.token });
        } catch {
          // The local token is dropped regardless; a dead server must not trap the user signed in.
        }
      }
      await storage.savePlatform({ url: platform.url, token: '', user: null });
    },

    // Returns the current user, or null when not signed in or the session has ended.
    async me() {
      const platform = await storage.getPlatform();
      if (!platform.url || !platform.token) return null;
      try {
        const { data } = await request(platform.url, '/auth/me', { token: platform.token });
        return data.user;
      } catch (err) {
        if (err.status === 401) {
          await storage.savePlatform({ url: platform.url, token: '', user: null });
          return null;
        }
        throw err;
      }
    },

    async listProjects() {
      const platform = await signedIn();
      const { data } = await request(platform.url, '/projects?pageSize=100', { token: platform.token });
      return data.items;
    },
  };
}

export const PlatformClient = createPlatformClient({
  fetchFn: (url, init) => fetch(url, init),
  storage: Storage,
});
