import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { SCRIPTS_PAGE_SIZE, scriptsApi } from '../api/scripts';
import type { Project, ScriptListItem } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { saveTextFile } from '../download';
import { useDebounced } from '../hooks/useDebounced';
import { useLoad } from '../hooks/useLoad';
import { readScriptFile } from '../importFile';

type Dialog =
  | { kind: 'duplicate'; script: ScriptListItem }
  | { kind: 'delete'; script: ScriptListItem }
  | { kind: 'hint'; action: 'Record' | 'Generate' };

// The agents live in the extension; these buttons only say how to get a script from there to here.
const HINTS = {
  Record:
    'Recording happens in the Playwright AI Studio extension. Open its side panel, record your steps in the Recorder, then choose "Save to Project" and pick this project. The script then appears in this list.',
  Generate:
    'Generation happens in the Playwright AI Studio extension. Open its side panel, produce the test in the Generator or the Orchestrator, then choose "Save to Project" and pick this project. The script then appears in this list.',
};

const COPY_SUFFIX = ' (copy)';

export function ScriptsTab({ project }: { project: Project }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const fileInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [tag, setTag] = useState('');
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search, 250);

  const archived = project.status !== 'ACTIVE';
  // The API refuses writes from a VIEWER and in an archived project, so the controls are not offered.
  const canWrite = user?.role !== 'VIEWER' && !archived;

  const scripts = useLoad(
    () => scriptsApi.list(project.id, { search: debouncedSearch, tag, page }),
    [project.id, debouncedSearch, tag, page],
  );
  const tags = useLoad(() => scriptsApi.tags(''), [project.id]);
  const data = scripts.data;

  // Deleting the last script on a page leaves that page empty: step back to one that exists.
  useEffect(() => {
    if (data && data.items.length === 0 && data.total > 0 && page > 1) setPage(page - 1);
  }, [data, page]);

  const tagOptions = [...new Set([...(tags.data?.items ?? []), ...(tag ? [tag] : [])])];
  const first = data ? (data.page - 1) * data.pageSize + 1 : 0;
  const last = data ? first + data.items.length - 1 : 0;

  const refresh = () => {
    scripts.reload();
    tags.reload();
  };
  const close = () => setDialog(null);
  const closeAndRefresh = () => {
    close();
    refresh();
  };
  const pickTag = (name: string) => {
    setTag(name);
    setPage(1);
  };

  async function onImport(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // so the same file can be chosen again
    if (!file) return;
    try {
      const imported = await readScriptFile(file);
      navigate(`/projects/${project.id}/scripts/new`, { state: { imported } });
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  async function download(script: ScriptListItem) {
    try {
      const file = await scriptsApi.download(script.id);
      saveTextFile(file.fileName, file.text);
      setProblem(null);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  return (
    <>
      {archived && <p className="muted">This project is archived, so its scripts cannot be changed.</p>}

      {canWrite && (
        <div className="toolbar">
          <Link className="btn btn-primary" to={`/projects/${project.id}/scripts/new`}>New Script</Link>
          <button className="btn btn-secondary" onClick={() => fileInput.current?.click()}>Import</button>
          <input ref={fileInput} type="file" hidden accept=".ts,.js,.mjs,.cjs" aria-label="Import script file"
            onChange={(e) => void onImport(e)} />
          <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'hint', action: 'Record' })}>Record</button>
          <button className="btn btn-secondary" onClick={() => setDialog({ kind: 'hint', action: 'Generate' })}>Generate</button>
        </div>
      )}

      <div className="toolbar">
        <input type="search" placeholder="Search scripts..." aria-label="Search scripts" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
        <label htmlFor="tag-filter">Tag</label>
        <select id="tag-filter" value={tag} onChange={(e) => pickTag(e.target.value)}>
          <option value="">All tags</option>
          {tagOptions.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <button className="btn btn-secondary" onClick={refresh}>Refresh</button>
      </div>

      {problem && <p className="error" role="alert">{problem}</p>}
      {scripts.error && <p className="error" role="alert">{scripts.error}</p>}
      {scripts.loading && !data && <p className="muted">Loading scripts…</p>}
      {data && data.items.length === 0 && (
        <p className="muted center">{debouncedSearch || tag ? 'No scripts match.' : 'No scripts yet.'}</p>
      )}

      {data && data.items.length > 0 && (
        <div className="card table-scroll">
          <table>
            <thead>
              <tr>
                <th>Script</th>
                <th>Version</th>
                <th>State</th>
                <th>Tags</th>
                <th>Last Updated</th>
                <th>Updated By</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((script) => (
                <tr key={script.id}>
                  <td>
                    <Link to={`/scripts/${script.id}`}>{script.name}</Link>
                    {script.description && <div className="muted">{script.description}</div>}
                  </td>
                  <td>v{script.version}</td>
                  <td><StatusBadge status={script.lifecycleState} /></td>
                  <td>
                    {script.tags.map((name) => (
                      <button key={name} className="chip" title={`Filter by ${name}`} onClick={() => pickTag(name)}>
                        {name}
                      </button>
                    ))}
                  </td>
                  <td className="muted">{new Date(script.updatedAt).toLocaleString()}</td>
                  <td className="muted">{script.updatedBy ?? '—'}</td>
                  <td className="actions">
                    <Link className="btn btn-secondary btn-sm" to={`/scripts/${script.id}`}>View</Link>
                    {canWrite && (
                      <Link className="btn btn-secondary btn-sm" to={`/scripts/${script.id}?edit=1`}>Edit</Link>
                    )}
                    {canWrite && (
                      <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'duplicate', script })}>
                        Duplicate
                      </button>
                    )}
                    <Link className="btn btn-secondary btn-sm" to={`/scripts/${script.id}/versions`}>Version History</Link>
                    <button className="btn btn-secondary btn-sm" onClick={() => void download(script)}>Download</button>
                    <button className="btn btn-secondary btn-sm" disabled title="Coming soon">Run</button>
                    <button className="btn btn-secondary btn-sm" disabled title="Coming soon">Heal</button>
                    {canWrite && (
                      <button className="btn btn-danger btn-sm" onClick={() => setDialog({ kind: 'delete', script })}>
                        Delete
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data && data.items.length > 0 && (
        <div className="pager">
          <span className="muted">{first}–{last} of {data.total}</span>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <button className="btn btn-secondary btn-sm" disabled={page * SCRIPTS_PAGE_SIZE >= data.total}
            onClick={() => setPage(page + 1)}>
            Next
          </button>
        </div>
      )}

      {dialog?.kind === 'duplicate' && (
        <DuplicateForm script={dialog.script} onCancel={close} onDone={closeAndRefresh} />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Are you sure?"
          message="This will remove the script from the project."
          confirmLabel="Delete"
          danger
          onCancel={close}
          onConfirm={async () => {
            await scriptsApi.remove(dialog.script.id);
            closeAndRefresh();
          }}
        />
      )}
      {dialog?.kind === 'hint' && (
        <Modal title={`${dialog.action} in the extension`} onClose={close}>
          <p>{HINTS[dialog.action]}</p>
          <div className="form-actions">
            <button className="btn btn-primary" onClick={close}>Close</button>
          </div>
        </Modal>
      )}
    </>
  );
}

interface DuplicateFormProps {
  script: ScriptListItem;
  onDone(): void;
  onCancel(): void;
}

function DuplicateForm({ script, onDone, onCancel }: DuplicateFormProps) {
  // The same default the server would choose, shown so it can be changed first.
  const [name, setName] = useState(`${script.name.slice(0, 200 - COPY_SUFFIX.length)}${COPY_SUFFIX}`);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await scriptsApi.duplicate(script.id, name);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title="Duplicate script" onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="duplicate-name">Name</label>
        <input id="duplicate-name" required maxLength={200} autoFocus value={name}
          onChange={(e) => setName(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>Duplicate</button>
        </div>
      </form>
    </Modal>
  );
}
