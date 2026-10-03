import { api, apiDownload } from './client';
import type { Script, ScriptLanguage, ScriptListItem, ScriptType, ScriptVersion, ScriptVersionItem } from './types';

export const SCRIPTS_PAGE_SIZE = 25;

export interface ScriptList {
  items: ScriptListItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NewScript {
  name: string;
  description: string;
  testScenario: string;
  content: string;
  language: ScriptLanguage;
  scriptType: ScriptType;
  tags: string[];
  source: 'MANUAL' | 'IMPORTED';
}

export interface ScriptPatch {
  name?: string;
  description?: string;
  testScenario?: string;
  tags?: string[];
  content?: string;
  changeSummary?: string;
  /** The version the content was based on. Required whenever `content` is sent. */
  baseVersion?: number;
}

/** `details` of the VERSION_CONFLICT error. */
export interface VersionConflict {
  currentVersion: number;
  updatedBy: string | null;
}

export const scriptsApi = {
  list(projectId: number, params: { search: string; tag: string; page: number }) {
    const query = new URLSearchParams({ page: String(params.page), pageSize: String(SCRIPTS_PAGE_SIZE) });
    if (params.search.trim()) query.set('search', params.search.trim());
    if (params.tag) query.set('tag', params.tag);
    return api<ScriptList>(`/projects/${projectId}/scripts?${query.toString()}`);
  },
  get: (id: number) => api<{ script: Script }>(`/scripts/${id}`),
  create: (projectId: number, input: NewScript) =>
    api<{ script: Script }>(`/projects/${projectId}/scripts`, { method: 'POST', body: input }),
  update: (id: number, patch: ScriptPatch) =>
    api<{ script: Script }>(`/scripts/${id}`, { method: 'PUT', body: patch }),
  remove: (id: number) => api<void>(`/scripts/${id}`, { method: 'DELETE' }),
  duplicate: (id: number, name: string) =>
    api<{ script: Script }>(`/scripts/${id}/duplicate`, { method: 'POST', body: { name } }),
  versions: (id: number) => api<{ items: ScriptVersionItem[] }>(`/scripts/${id}/versions`),
  version: (id: number, version: number) => api<{ version: ScriptVersion }>(`/scripts/${id}/versions/${version}`),
  restore: (id: number, version: number) =>
    api<{ script: Script }>(`/scripts/${id}/versions/${version}/restore`, { method: 'POST' }),
  download: (id: number, version?: number) =>
    apiDownload(`/scripts/${id}/download${version === undefined ? '' : `?version=${version}`}`),
  tags(search: string) {
    const query = search.trim() ? `?search=${encodeURIComponent(search.trim())}` : '';
    return api<{ items: string[] }>(`/tags${query}`);
  },
};
