import type { FastifyBaseLogger } from 'fastify';
import { isUniqueViolation } from '../db';
import { AppError, notFound } from '../errors';
import type { Transact } from '../repositories';
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
    private readonly audit: AuditService,
    private readonly transact: Transact,
    private readonly log: FastifyBaseLogger,
  ) {}

  list(): Promise<User[]> {
    return this.users.list();
  }

  async create(actor: Actor, input: CreateUserInput): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    let user: User;
    try {
      user = await this.transact(async (r) => {
        const created = await r.users.create({
          email: input.email,
          displayName: input.displayName,
          passwordHash,
          role: input.role,
        });
        await this.audit.record(
          {
            userId: actor.userId,
            userEmail: actor.email,
            action: 'user.create',
            resource: 'user',
            resourceId: String(created.id),
            result: 'SUCCESS',
            ip: actor.ip,
            details: { email: created.email, role: created.role },
          },
          r.audit,
        );
        return created;
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new AppError(409, 'EMAIL_TAKEN', `A user with the email ${input.email} already exists.`);
      }
      throw err;
    }

    this.log.info(`[USER] Created user ${user.id}`);
    return user;
  }

  async update(actor: Actor, id: number, input: UpdateUserInput): Promise<User> {
    // Hashing is slow; do it before the transaction takes any locks.
    const passwordHash = input.password === undefined ? undefined : await hashPassword(input.password);

    const updated = await this.transact(async (r) => {
      const existing = await r.users.findById(id);
      if (!existing) throw notFound('User');

      const losesAdmin =
        existing.role === 'ADMIN' &&
        existing.status === 'ACTIVE' &&
        ((input.role !== undefined && input.role !== 'ADMIN') || input.status === 'DISABLED');
      // The lock makes concurrent demotions queue here, so two requests cannot
      // each see "two admins" and together leave none.
      if (losesAdmin && (await r.users.lockActiveAdmins()) <= 1) {
        throw new AppError(409, 'LAST_ADMIN', 'This is the last active administrator and cannot be demoted or disabled.');
      }

      const user = await r.users.update(id, {
        displayName: input.displayName,
        role: input.role,
        status: input.status,
        passwordHash,
      });
      if (!user) throw notFound('User');

      // A disabled account or a changed password must not leave old sessions usable.
      if (input.status === 'DISABLED' || input.password !== undefined) {
        await r.sessions.revokeAllForUser(id);
      }

      await this.audit.record(
        {
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
        },
        r.audit,
      );
      return user;
    });

    this.log.info(`[USER] Updated user ${id}`);
    return updated;
  }
}
