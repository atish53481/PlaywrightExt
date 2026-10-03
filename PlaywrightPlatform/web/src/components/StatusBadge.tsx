const TONE: Record<string, string> = {
  PASSED: 'success',
  ACTIVE: 'success',
  FAILED: 'danger',
  ERROR: 'danger',
  DELETED: 'danger',
  DISABLED: 'danger',
  RUNNING: 'info',
  QUEUED: 'warn',
  ABORTED: 'warn',
  ARCHIVED: 'neutral',
};

/** One look for every status word in the product. Unknown or missing values render neutrally. */
export function StatusBadge({ status }: { status: string | null }) {
  if (!status) return <span className="muted">—</span>;
  return <span className={`badge badge-${TONE[status] ?? 'neutral'}`}>{status}</span>;
}
