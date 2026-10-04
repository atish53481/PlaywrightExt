import { api } from './client';

export interface SkillSummary {
  id: number;
  name: string;
  description: string;
  scope: 'GLOBAL' | 'PROJECT';
  projectId: number | null;
  fileName: string | null;
  version: number;
  status: 'ACTIVE' | 'ARCHIVED';
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface Skill extends SkillSummary {
  content: string;
}

/** A skill as one project sees it. A global skill is used by a project only once attached. */
export interface ProjectSkill extends SkillSummary {
  attached: boolean;
  enabled: boolean;
  priority: number;
}

export interface SkillVersionItem {
  version: number;
  changeSummary: string;
  createdBy: string | null;
  createdAt: string;
}

export interface NewSkill {
  name: string;
  description: string;
  content: string;
  tags: string[];
  fileName?: string;
}

export interface SkillPatch {
  name?: string;
  description?: string;
  content?: string;
  tags?: string[];
  changeSummary?: string;
}

export const skillsApi = {
  list(projectId: number, search: string) {
    const query = search.trim() ? `?${new URLSearchParams({ search: search.trim() }).toString()}` : '';
    return api<{ items: ProjectSkill[] }>(`/projects/${projectId}/skills${query}`);
  },
  get: (id: number) => api<{ skill: Skill }>(`/skills/${id}`),
  /** `projectId` null creates a global skill, which only an ADMIN may do. */
  create: (projectId: number | null, input: NewSkill) =>
    api<{ skill: Skill }>(projectId === null ? '/skills' : `/projects/${projectId}/skills`, { method: 'POST', body: input }),
  update: (id: number, patch: SkillPatch) => api<{ skill: Skill }>(`/skills/${id}`, { method: 'PUT', body: patch }),
  archive: (id: number) => api<void>(`/skills/${id}`, { method: 'DELETE' }),
  versions: (id: number) => api<{ items: SkillVersionItem[] }>(`/skills/${id}/versions`),
  restore: (id: number, version: number) =>
    api<{ skill: Skill }>(`/skills/${id}/versions/${version}/restore`, { method: 'POST' }),
  /** Attaches or detaches a global skill, and switches or orders any skill, for one project. */
  setForProject: (projectId: number, skillId: number, patch: { attached?: boolean; enabled?: boolean; priority?: number }) =>
    api<{ skill: ProjectSkill }>(`/projects/${projectId}/skills/${skillId}`, { method: 'PUT', body: patch }),
};
