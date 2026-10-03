export type Role = 'ADMIN' | 'USER' | 'VIEWER';
export type UserStatus = 'ACTIVE' | 'DISABLED';
export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface Project {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  autoUseSkills: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectListItem extends Project {
  scriptCount: number;
  lastRunStatus: string | null;
  lastRunAt: string | null;
}

export interface ProjectOverview {
  totalScripts: number;
  passedScripts: number;
  failedScripts: number;
  notExecuted: number;
  lastExecutionAt: string | null;
}

export type ScriptLanguage = 'TypeScript' | 'JavaScript';
export type ScriptType = 'E2E' | 'API' | 'COMPONENT';
export type ScriptSource = 'MANUAL' | 'GENERATED' | 'RECORDED' | 'IMPORTED' | 'HEALED' | 'RESTORED';

export interface ScriptListItem {
  id: number;
  projectId: number;
  /** Status of the owning project. Scripts can be changed only while it is ACTIVE. */
  projectStatus: ProjectStatus;
  name: string;
  description: string;
  language: ScriptLanguage;
  framework: string;
  scriptType: ScriptType;
  version: number;
  status: 'ACTIVE' | 'ARCHIVED' | 'DELETED';
  lifecycleState: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  updatedBy: string | null;
}

export interface Script extends ScriptListItem {
  testScenario: string;
  content: string;
}

export interface ScriptVersionItem {
  version: number;
  source: ScriptSource;
  changeSummary: string;
  createdBy: string | null;
  createdAt: string;
  size: number;
}

export interface ScriptVersion extends ScriptVersionItem {
  content: string;
}
