import type { FastifyBaseLogger } from 'fastify';
import type { AuditRepository } from '../repositories/audit-repository';

export interface AuditEntry {
  userId: number | null;
  userEmail: string | null;
  action: string;
  resource: string;
  resourceId: string | null;
  result: 'SUCCESS' | 'FAILURE';
  ip: string | null;
  /** Never put secrets here: this object is stored and logged. */
  details?: Record<string, unknown>;
}

export class AuditService {
  constructor(
    private readonly repo: AuditRepository,
    private readonly log: FastifyBaseLogger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    await this.repo.insert({ ...entry, details: entry.details ?? null });
    this.log.info(
      { action: entry.action, resource: entry.resource, resourceId: entry.resourceId, userId: entry.userId },
      `[AUDIT] ${entry.action} ${entry.result}`,
    );
  }
}
