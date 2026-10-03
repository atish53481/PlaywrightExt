import { api } from './client';
import type { Project, ProjectListItem, ProjectOverview, ProjectStatus } from './types';

export interface ProjectList {
  items: ProjectListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export const projectsApi = {
  list(params: { search: string; status: ProjectStatus }) {
    const query = new URLSearchParams({ status: params.status, pageSize: '100' });
    if (params.search.trim()) query.set('search', params.search.trim());
    return api<ProjectList>(`/projects?${query.toString()}`);
  },
  get: (id: number) => api<{ project: Project; overview: ProjectOverview }>(`/projects/${id}`),
  create: (input: { name: string; description: string }) =>
    api<{ project: Project }>('/projects', { method: 'POST', body: input }),
  update: (id: number, patch: { name?: string; description?: string; status?: 'ACTIVE' | 'ARCHIVED' }) =>
    api<{ project: Project }>(`/projects/${id}`, { method: 'PUT', body: patch }),
  remove: (id: number) => api<void>(`/projects/${id}`, { method: 'DELETE' }),
};
