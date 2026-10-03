import { AppError } from '../errors';
import type { Transact } from '../repositories';
import type { SessionRepository } from '../repositories/session-repository';
import type { UserRepository } from '../repositories/user-repository';
import { hashPassword, verifyPassword } from '../security/passwords';
import { hashToken, newToken } from '../security/tokens';
import type { AuthContext, Session, SessionKind, User } from '../types';
import type { AuditService } from './audit-service';

const WEB_SESSION_MS = 8 * 60 * 60 * 1000;
const EXTENSION_SESSION_MS = 30 * 24 * 60 * 60 * 1000;

export interface LoginInput {
  email: string;
  password: string;
  client: 'web' | 'extension';
  ip: string;
}

export interface LoginResult {
  user: User;
  token: string;
  csrfToken: string;
  expiresAt: Date;
}

export class AuthService {
  // Verified against when the email is unknown, so both failure paths cost the same.
  private readonly dummyHash = hashPassword('timing-equaliser-not-a-real-password');

  constructor(
    private readonly users: UserRepository,
    private readonly sessions: SessionRepository,
    private readonly audit: AuditService,
    private readonly transact: Transact,
  ) {}

  async login(input: LoginInput): Promise<LoginResult> {
    const found = await this.users.findByEmail(input.email);
    const passwordOk = await verifyPassword(found?.passwordHash ?? (await this.dummyHash), input.password);

    if (!found || !passwordOk || found.status !== 'ACTIVE') {
      await this.audit.record({
        userId: found?.id ?? null,
        userEmail: input.email,
        action: 'auth.login',
        resource: 'session',
        resourceId: null,
        result: 'FAILURE',
        ip: input.ip,
      });
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password.');
    }

    const kind: SessionKind = input.client === 'web' ? 'WEB' : 'EXTENSION';
    const token = newToken();
    const csrfToken = newToken();
    const expiresAt = new Date(Date.now() + (kind === 'WEB' ? WEB_SESSION_MS : EXTENSION_SESSION_MS));
    // One transaction: a session must never exist without its audit row.
    await this.transact(async (r) => {
      const session = await r.sessions.create({
        userId: found.id,
        tokenHash: hashToken(token),
        kind,
        csrfSecret: csrfToken,
        expiresAt,
      });
      await r.users.touchLogin(found.id);
      await this.audit.record(
        {
          userId: found.id,
          userEmail: found.email,
          action: 'auth.login',
          resource: 'session',
          resourceId: String(session.id),
          result: 'SUCCESS',
          ip: input.ip,
          details: { client: input.client },
        },
        r.audit,
      );
    });

    const { passwordHash: _omit, ...user } = found;
    return { user, token, csrfToken, expiresAt };
  }

  resolve(token: string, kind: SessionKind): Promise<{ user: User; session: Session } | null> {
    return this.sessions.findActive(hashToken(token), kind);
  }

  async logout(ctx: AuthContext, ip: string): Promise<void> {
    await this.transact(async (r) => {
      await r.sessions.revoke(ctx.session.id);
      await this.audit.record(
        {
          userId: ctx.user.id,
          userEmail: ctx.user.email,
          action: 'auth.logout',
          resource: 'session',
          resourceId: String(ctx.session.id),
          result: 'SUCCESS',
          ip,
        },
        r.audit,
      );
    });
  }
}
