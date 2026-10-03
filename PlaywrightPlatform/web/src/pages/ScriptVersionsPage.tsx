import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { scriptsApi } from '../api/scripts';
import { useAuth } from '../auth/AuthContext';
import { CodeDiff } from '../components/CodeDiff';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { saveTextFile } from '../download';
import { useLoad } from '../hooks/useLoad';

export function ScriptVersionsPage() {
  const id = Number(useParams().id);
  const { user } = useAuth();
  const canWrite = user?.role === 'ADMIN' || user?.role === 'USER';
  const script = useLoad(() => scriptsApi.get(id), [id]);
  const versions = useLoad(() => scriptsApi.versions(id), [id]);
  // The two versions being compared: `left` is shown as the older side.
  const [left, setLeft] = useState<number | null>(null);
  const [right, setRight] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  // Whenever the list is loaded or reloaded, compare the latest version with the one before it.
  useEffect(() => {
    const list = versions.data?.items;
    if (!list || list.length === 0) return;
    setRight(list[0].version);
    setLeft((list[1] ?? list[0]).version);
  }, [versions.data]);

  const pair = useLoad(async () => {
    if (left === null || right === null) return null;
    const [a, b] = await Promise.all([scriptsApi.version(id, left), scriptsApi.version(id, right)]);
    return { left: a.version, right: b.version };
  }, [id, left, right]);

  const error = script.error ?? versions.error;
  if (error) {
    return (
      <>
        <p className="error" role="alert">{error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  if (!script.data || !versions.data || script.data.script.id !== id) {
    return <p className="muted">Loading history…</p>;
  }

  const current = script.data.script;
  const items = versions.data.items;
  const latest = items[0]?.version ?? current.version;

  async function download(version: number) {
    try {
      const file = await scriptsApi.download(id, version);
      // "login.spec.ts" becomes "login.v1.spec.ts", so an old version is not mistaken for the latest.
      saveTextFile(file.fileName.replace('.spec.', `.v${version}.spec.`), file.text);
      setProblem(null);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Version History</h1>
          <p className="muted">{current.name} · currently v{current.version}</p>
        </div>
        <Link to={`/scripts/${id}`}>Back to script</Link>
      </div>

      {problem && <p className="error" role="alert">{problem}</p>}
      {status && <p className="muted" role="status">{status}</p>}

      <div className="card table-scroll">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Source</th>
              <th>Summary</th>
              <th>Author</th>
              <th>Date</th>
              <th>Size</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((version) => (
              <tr key={version.version}>
                <td>
                  v{version.version} {version.version === latest && <span className="chip">latest</span>}
                </td>
                <td><span className="badge badge-neutral">{version.source}</span></td>
                <td>{version.changeSummary || <span className="muted">—</span>}</td>
                <td className="muted">{version.createdBy ?? '—'}</td>
                <td className="muted">{new Date(version.createdAt).toLocaleString()}</td>
                <td className="muted">{version.size.toLocaleString()} characters</td>
                <td className="actions">
                  <button className="btn btn-secondary btn-sm" onClick={() => void download(version.version)}>
                    Download
                  </button>
                  {canWrite && current.projectStatus === 'ACTIVE' && version.version !== latest && (
                    <button className="btn btn-secondary btn-sm" onClick={() => setRestoring(version.version)}>
                      Restore
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 style={{ marginTop: 20 }}>Compare</h2>
      {items.length === 1 ? (
        <p className="muted">This script has one version, so there is nothing to compare yet.</p>
      ) : (
        <div className="toolbar">
          <label htmlFor="compare-left">Older</label>
          <select id="compare-left" value={left ?? ''} onChange={(e) => setLeft(Number(e.target.value))}>
            {items.map((version) => (
              <option key={version.version} value={version.version}>v{version.version}</option>
            ))}
          </select>
          <label htmlFor="compare-right">Newer</label>
          <select id="compare-right" value={right ?? ''} onChange={(e) => setRight(Number(e.target.value))}>
            {items.map((version) => (
              <option key={version.version} value={version.version}>v{version.version}</option>
            ))}
          </select>
        </div>
      )}
      {pair.error && <p className="error" role="alert">{pair.error}</p>}
      {pair.data && (
        <CodeDiff
          left={pair.data.left.content}
          right={pair.data.right.content}
          leftLabel={`Version ${pair.data.left.version}`}
          rightLabel={`Version ${pair.data.right.version}`}
          language={current.language}
        />
      )}

      {restoring !== null && (
        <ConfirmDialog
          title={`Restore v${restoring}?`}
          message={`This creates v${latest + 1} with the content of v${restoring}. No version is removed.`}
          confirmLabel="Restore"
          onCancel={() => setRestoring(null)}
          onConfirm={async () => {
            const { script: updated } = await scriptsApi.restore(id, restoring);
            setRestoring(null);
            setStatus(`Restored v${restoring} as v${updated.version}.`);
            versions.reload();
            script.reload();
          }}
        />
      )}
    </>
  );
}
