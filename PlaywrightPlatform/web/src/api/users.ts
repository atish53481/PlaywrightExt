import { api } from './client';
import type { Role, User, UserStatus } from './types';

export const usersApi = {
  list: () => api<{ items: User[] }>('/users'),
  create: (input: { email: string; displayName: string; password: string; role: Role }) =>
    api<{ user: User }>('/users', { method: 'POST', body: input }),
  update: (id: number, patch: { displayName?: string; role?: Role; status?: UserStatus; password?: string }) =>
    api<{ user: User }>(`/users/${id}`, { method: 'PUT', body: patch }),
};
