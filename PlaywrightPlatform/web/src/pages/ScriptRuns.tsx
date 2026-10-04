import { useState } from 'react';
import { errorMessage } from '../api/client';
import { executionsApi, type Execution, type ReportLinks } from '../api/executions';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';

const FINISHED: ReadonlySet<string> = new Set(['PASSED', 'FAILED', 'ABORTED', 'ERROR']);

function countsText(run: Execution): string {
  if (run.total <= 0) return '—';
  const parts = [`${run.passed} passed`, `${run.failed} failed`];
  if (run.skipped > 0) parts.push(`${run.skipped} skipped`);
  return parts.join(', ');
}

function durationText(ms: number | null): string {
  if (ms === null || ms < 0) return '—';
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

/** The reports of one run. The links are asked for on demand: each one works for an hour. */
function RunReports({ run }: { run: Execution }) {
  const [links, setLinks] = useState<ReportLinks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!FINISHED.has(run.status) || run.buildNumber === null) return <span className="muted">—</span>;

  async function load() {
    setBusy(true);
    setError(null);
    try {
      setLinks((await executionsApi.reports(run.id)).reports);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (!links) {
    return (
      <>
        <button className="btn btn-secondary btn-sm" onClick={() => void load()} disabled={busy}>
          {busy ? 'Loading…' : 'Show reports'}
        </button>
        {error && <span className="error" role="alert"> {error}</span>}
      </>
    );
  }
  if (!links.playwright && !links.allure) return <span className="muted">No report was archived</span>;
  return (
    <>
      {links.playwright && (
        <a className="btn btn-secondary btn-sm" href={links.playwright} target="_blank" rel="noopener noreferrer">
          Playwright report
        </a>
      )}
      {links.allure && (
        <a className="btn btn-secondary btn-sm" href={links.allure} target="_blank" rel="noopener noreferrer">
          Allure report
        </a>
      )}
    </>
  );
}

/** A script's recent runs on Jenkins, with the reports of each. */
export function ScriptRuns({ scriptId }: { scriptId: number }) {
  const runs = useLoad(() => executionsApi.list(scriptId), [scriptId]);

  return (
    <section aria-label="Recent runs">
      <div className="toolbar" style={{ marginTop: 20 }}>
        <h2>Recent runs</h2>
        <button className="btn btn-secondary btn-sm" onClick={runs.reload} disabled={runs.loading}>Refresh</button>
      </div>
      {runs.error && <p className="error" role="alert">{runs.error}</p>}
      {!runs.data && !runs.error && <p className="muted">Loading runs…</p>}
      {runs.data && runs.data.items.length === 0 && (
        <p className="muted">This script has not been run yet. Runs are started from the browser extension.</p>
      )}
      {runs.data && runs.data.items.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Run</th>
                <th>Status</th>
                <th>Tests</th>
                <th>Took</th>
                <th>Started</th>
                <th>Reports</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.items.map((run) => (
                <tr key={run.id}>
                  <td>
                    #{run.id} · v{run.scriptVersion}
                    {run.buildNumber !== null && <span className="muted"> · build {run.buildNumber}</span>}
                  </td>
                  <td><StatusBadge status={run.status} /></td>
                  <td>{countsText(run)}</td>
                  <td className="muted">{durationText(run.durationMs)}</td>
                  <td className="muted">
                    {new Date(run.createdAt).toLocaleString()}
                    {run.triggeredBy ? ` by ${run.triggeredBy}` : ''}
                  </td>
                  <td className="actions"><RunReports run={run} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
