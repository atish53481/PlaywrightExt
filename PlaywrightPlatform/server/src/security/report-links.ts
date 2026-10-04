import { createHmac, hkdfSync } from 'node:crypto';
import { safeEqual } from './tokens';

/**
 * Signs the links that open a run's reports. A report opens in its own browser tab, where
 * the extension cannot send its bearer token, so the link itself carries the permission:
 * the run, when the link stops working, and a signature only this server can make.
 */
export interface ReportLinkSigner {
  /** A token that opens the reports of one run until `expiresAt` (milliseconds since the epoch). */
  sign(executionId: number, expiresAt: number): string;
  /** The run a token opens, or null when the token is not ours or has expired. */
  verify(token: string, now: number): number | null;
  /** A token that opens one page for several runs at once: scripts that were run together. */
  signBatch(executionIds: number[], expiresAt: number): string;
  /** The runs a batch token opens, or null when the token is not ours or has expired. */
  verifyBatch(token: string, now: number): number[] | null;
}

export function createReportLinkSigner(secretsKey: Buffer): ReportLinkSigner {
  // A key of its own, so a signature here says nothing about the key that encrypts secrets.
  const key = Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'report-links', 32));
  const mac = (payload: string): string => createHmac('sha256', key).update(payload).digest('base64url');
  return {
    sign(executionId, expiresAt) {
      const payload = `${executionId}.${Math.floor(expiresAt / 1000)}`;
      return `${payload}.${mac(payload)}`;
    },
    verify(token, now) {
      const match = /^([1-9]\d{0,14})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return null;
      if (!safeEqual(match[3], mac(`${match[1]}.${match[2]}`))) return null;
      if (Number(match[2]) * 1000 <= now) return null;
      return Number(match[1]);
    },
    // A batch token starts with "b", which no token for one run does, so neither kind can stand in for the other.
    signBatch(executionIds, expiresAt) {
      const payload = `b${executionIds.join('-')}.${Math.floor(expiresAt / 1000)}`;
      return `${payload}.${mac(payload)}`;
    },
    verifyBatch(token, now) {
      const match = /^b([1-9]\d{0,14}(?:-[1-9]\d{0,14}){0,49})\.(\d{1,12})\.([A-Za-z0-9_-]{43})$/.exec(token);
      if (!match) return null;
      if (!safeEqual(match[3], mac(`b${match[1]}.${match[2]}`))) return null;
      if (Number(match[2]) * 1000 <= now) return null;
      return match[1].split('-').map(Number);
    },
  };
}
