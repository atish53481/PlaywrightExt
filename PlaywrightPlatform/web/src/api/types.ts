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
