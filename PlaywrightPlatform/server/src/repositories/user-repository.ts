import type { Db } from '../db';
import type { Role, User, UserStatus, UserWithHash } from '../types';

interface UserRow {
  id: number;
  email: string;
  display_name: string;
  password_hash: string;
  role: Role;
  status: UserStatus;
  last_login_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toUser(row: Omit<UserRow, 'password_hash'>): User {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toUserWithHash(row: UserRow): UserWithHash {
  return { ...toUser(row), passwordHash: row.password_hash };
}

export interface NewUser {
  email: string;
  displayName: string;
  passwordHash: string;
  role: Role;
}

export interface UserPatch {
  displayName?: string;
  role?: Role;
  status?: UserStatus;
  passwordHash?: string;
}

export class UserRepository {
  constructor(private readonly db: Db) {}

  async findByEmail(email: string): Promise<UserWithHash | null> {
    const row = await this.db('users')
      .whereRaw('lower(email) = ?', [email.toLowerCase()])
      .first();
    return row ? toUserWithHash(row) : null;
  }

  async findById(id: number): Promise<UserWithHash | null> {
    const row = await this.db('users').where({ id }).first();
    return row ? toUserWithHash(row) : null;
  }

  async list(): Promise<User[]> {
    const rows = await this.db('users').orderBy('created_at', 'asc').orderBy('id', 'asc');
    return rows.map(toUser);
  }

  async create(input: NewUser): Promise<User> {
    const [row] = await this.db('users')
      .insert({
        email: input.email,
        display_name: input.displayName,
        password_hash: input.passwordHash,
        role: input.role,
      })
      .returning('*');
    return toUser(row);
  }

  async update(id: number, patch: UserPatch): Promise<User | null> {
    const changes: Record<string, unknown> = { updated_at: this.db.fn.now() };
    if (patch.displayName !== undefined) changes.display_name = patch.displayName;
    if (patch.role !== undefined) changes.role = patch.role;
    if (patch.status !== undefined) changes.status = patch.status;
    if (patch.passwordHash !== undefined) changes.password_hash = patch.passwordHash;
    const [row] = await this.db('users').where({ id }).update(changes).returning('*');
    return row ? toUser(row) : null;
  }

  async touchLogin(id: number): Promise<void> {
    await this.db('users').where({ id }).update({ last_login_at: this.db.fn.now() });
  }

  async countActiveAdmins(): Promise<number> {
    const row = await this.db('users').where({ role: 'ADMIN', status: 'ACTIVE' }).count('* as n').first();
    return Number(row?.n ?? 0);
  }
}
