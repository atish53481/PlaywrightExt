import type { FastifyBaseLogger } from 'fastify';
import { isUniqueViolation } from '../db';
import { AppError, notFound } from '../errors';
import type { SessionRepository } from '../repositories/session-repository';
import type { UserRepository } from '../repositories/user-repository';
import { hashPassword } from '../security/passwords';
import type { Actor, Role, User, UserStatus } from '../types';
import type { AuditService } from './audit-service';

export interface CreateUserInput {
  email: string;
  displayName: string;
  password: string;
  role: Role;
}

export interface UpdateUserInput {
  displayName?: string;
  role?: Role;
  status?: UserStatus;
  password?: string;
}

export class UserService {
  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly log: FastifyBaseLogger,
  ) {}

  list(): Promise<User[]> {
    return this.users.list();
  }

  async create(actor: Actor, input: CreateUserInput): Promise<User> {
    let user: User;
    try {
      user = await this.users.create({
        email: input.email,
        displayName: input.displayName,
        passwordHash: await hashPassword(input.password),
        role: input.role,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'EMAIL_TAKEN', `A user with the email ${input.email} already exists.`);
      }
      throw err;
    }

    await this.audit.record({
      userId: actor.userId,
      userEmail: actor.email,
      action: 'user.create',
      resource: 'user',
      resourceId: String(user.id),
      result: 'SUCCESS',
      ip: actor.ip,
      details: { email: user.email, role: user.role },
    });
    this.log.info(`[USER] Created user ${user.id}`);
    return user;
  }

  async update(actor: Actor, id: number, input: UpdateUserInput): Promise<User> {
    const existing = await this.users.findById(id);
    if (!existing) throw notFound('User');

    const losesAdmin =
      existing.role === 'ADMIN' &&
      existing.status === 'ACTIVE' &&
      ((input.role !== undefined && input.role !== 'ADMIN') || input.status === 'DISABLED');
    if (losesAdmin && (await this.users.countActiveAdmins()) <= 1) {
      throw new AppError(409, 'LAST_ADMIN', 'This is the last active administrator and cannot be demoted or disabled.');
    }

    const updated = await this.users.update(id, {
      displayName: input.displayName,
      role: input.role,
      status: input.status,
      passwordHash: input.password === undefined ? undefined : await hashPassword(input.password),
    });
    if (!updated) throw notFound('User');

    // A disabled account or a changed password must not leave old sessions usable.
    if (input.status === 'DISABLED' || input.password !== undefined) {
      await this.sessions.revokeAllForUser(id);
    }

    await this.audit.record({
      userId: actor.userId,
      userEmail: actor.email,
      action: 'user.update',
      resource: 'user',
      resourceId: String(id),
      result: 'SUCCESS',
      ip: actor.ip,
      details: {
        changed: Object.entries(input)
          .filter(([, value]) => value !== undefined)
          .map(([key]) => key),
      },
    });
    this.log.info(`[USER] Updated user ${id}`);
    return updated;
  }
}
