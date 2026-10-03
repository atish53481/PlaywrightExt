import type { Db } from '../db';
import type { Session, SessionKind, User } from '../types';
import { toUser } from './user-repository';

export interface NewSession {
  userId: number;
  tokenHash: string;
  kind: SessionKind;
  csrfSecret: string;
  expiresAt: Date;
}

export class SessionRepository {
  constructor(private readonly db: Db) {}

  async create(input: NewSession): Promise<Session> {
    const [row] = await this.db('sessions')
      .insert({
        user_id: input.userId,
        token_hash: input.tokenHash,
        kind: input.kind,
        csrf_secret: input.csrfSecret,
        expires_at: input.expiresAt,
        last_used_at: this.db.fn.now(),
      })
      .returning(['id', 'user_id', 'kind', 'csrf_secret', 'expires_at']);
    return {
      id: row.id,
      userId: row.user_id,
      kind: row.kind,
      csrfSecret: row.csrf_secret,
      expiresAt: row.expires_at,
    };
  }

  /** A session counts only if unrevoked, unexpired, of the right kind, and its user is active. */
  async findActive(tokenHash: string, kind: SessionKind): Promise<{ user: User; session: Session } | null> {
    const row = await this.db('sessions as s')
      .join('users as u', 'u.id', 's.user_id')
      .where('s.token_hash', tokenHash)
      .where('s.kind', kind)
      .whereNull('s.revoked_at')
      .where('s.expires_at', '>', this.db.fn.now())
      .where('u.status', 'ACTIVE')
      .first(
        's.id as session_id',
        's.kind as session_kind',
        's.csrf_secret',
        's.expires_at',
        'u.id',
        'u.email',
        'u.display_name',
        'u.role',
        'u.status',
        'u.last_login_at',
        'u.created_at',
        'u.updated_at',
      );
    if (!row) return null;
    return {
      user: toUser(row),
      session: {
        id: row.session_id,
        userId: row.id,
        kind: row.session_kind,
        csrfSecret: row.csrf_secret,
        expiresAt: row.expires_at,
      },
    };
  }

  async revoke(id: number): Promise<void> {
    await this.db('sessions').where({ id }).whereNull('revoked_at').update({ revoked_at: this.db.fn.now() });
  }

  async revokeAllForUser(userId: number): Promise<void> {
    await this.db('sessions')
      .where({ user_id: userId })
      .whereNull('revoked_at')
      .update({ revoked_at: this.db.fn.now() });
  }
}
