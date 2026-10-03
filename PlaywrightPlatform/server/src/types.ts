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

export type ScriptLanguage = 'TypeScript' | 'JavaScript';
export type ScriptType = 'E2E' | 'API' | 'COMPONENT';
export type ScriptStatus = 'ACTIVE' | 'ARCHIVED' | 'DELETED';
export type ScriptLifecycleState =
  | 'DRAFT'
  | 'GENERATED'
  | 'SAVED'
  | 'VALIDATED'
  | 'READY'
  | 'RUNNING'
  | 'PASSED'
  | 'FAILED'
  | 'HEALING';
export type ScriptVersionSource = 'MANUAL' | 'GENERATED' | 'RECORDED' | 'IMPORTED' | 'HEALED' | 'RESTORED';

/** A script as lists show it: everything except the two large text fields. */
export interface ScriptSummary {
  id: number;
  projectId: number;
  /** Status of the owning project. Writes are refused unless it is ACTIVE. */
  projectStatus: ProjectStatus;
  name: string;
  description: string;
  language: ScriptLanguage;
  framework: string;
  scriptType: ScriptType;
  version: number;
  status: ScriptStatus;
  lifecycleState: ScriptLifecycleState;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  /** Display name of the last editor. */
  updatedBy: string | null;
}

export interface Script extends ScriptSummary {
  testScenario: string;
  content: string;
}

export interface ScriptVersionSummary {
  version: number;
  source: ScriptVersionSource;
  changeSummary: string;
  /** Display name of the author. */
  createdBy: string | null;
  createdAt: Date;
  /** Content length in characters. */
  size: number;
}

export interface ScriptVersion extends ScriptVersionSummary {
  content: string;
}
