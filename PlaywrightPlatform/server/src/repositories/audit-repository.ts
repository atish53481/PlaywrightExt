import type { Db } from '../db';

export interface AuditRow {
  userId: number | null;
  userEmail: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: 'SUCCESS' | 'FAILURE';
  ip: string | null;
  details: Record<string, unknown> | null;
}

export class AuditRepository {
  constructor(private readonly db: Db) {}

  async insert(row: AuditRow): Promise<void> {
    await this.db('audit_logs').insert({
      user_id: row.userId,
      user_email: row.userEmail,
      action: row.action,
      resource: row.resource,
      resource_id: row.resourceId,
      result: row.result,
      ip: row.ip,
      details: row.details === null ? null : JSON.stringify(row.details),
    });
  }
}
