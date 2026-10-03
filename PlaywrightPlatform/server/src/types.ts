export type Role = 'ADMIN' | 'USER' | 'VIEWER';
export type UserStatus = 'ACTIVE' | 'DISABLED';
export type SessionKind = 'WEB' | 'EXTENSION';

export interface User {
  id: number;
  email: string;
  displayName: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserWithHash extends User {
  passwordHash: string;
}

export interface Session {
  id: number;
  userId: number;
  kind: SessionKind;
  csrfSecret: string;
  expiresAt: Date;
}

export interface AuthContext {
  user: User;
  session: Session;
  via: 'cookie' | 'bearer';
}

/** Who performed an action, for audit rows. */
export interface Actor {
  userId: number;
  email: string;
  ip: string;
}

export type ProjectStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';

export interface Project {
  id: number;
  name: string;
  description: string;
  status: ProjectStatus;
  autoUseSkills: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProjectListItem extends Project {
  scriptCount: number;
  lastRunStatus: string | null;
  lastRunAt: Date | null;
}

export interface ProjectOverview {
  totalScripts: number;
  passedScripts: number;
  failedScripts: number;
  notExecuted: number;
  lastExecutionAt: Date | null;
}
