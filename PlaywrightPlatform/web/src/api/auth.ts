import { api } from './client';
import type { User } from './types';

export const authApi = {
  login: (email: string, password: string) =>
    api<{ user: User; csrfToken: string }>('/auth/login', {
      method: 'POST',
      body: { email, password, client: 'web' },
    }),
  logout: () => api<void>('/auth/logout', { method: 'POST' }),
  me: () => api<{ user: User; csrfToken: string | null }>('/auth/me'),
};
