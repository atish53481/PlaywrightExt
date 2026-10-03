import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ApiError, errorMessage } from '../api/client';
import { scriptsApi, type ScriptPatch, type VersionConflict } from '../api/scripts';
import type { Script } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CodeDiff } from '../components/CodeDiff';
import { CodeEditor } from '../components/CodeEditor';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { StatusBadge } from '../components/StatusBadge';
import { TagInput } from '../components/TagInput';
import { saveTextFile } from '../download';
import { useLoad } from '../hooks/useLoad';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';

/** The fields a user can edit on this page. */
interface Draft {
  name: string;
  description: string;
  testScenario: string;
  tags: string[];
  content: string;
}

function draftOf(script: Script): Draft {
  return {
    name: script.name,
    description: script.description,
    testScenario: script.testScenario,
    tags: script.tags,
    content: script.content,
  };
}

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((tag, index) => tag === b[index]);
}

export function ScriptPage() {
  const id = Number(useParams().id);
  const loaded = useLoad(() => scriptsApi.get(id), [id]);

  if (loaded.error) {
    return (
      <>
        <p className="error" role="alert">{loaded.error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  if (!loaded.data || loaded.data.script.id !== id) return <p className="muted">Loading script…</p>;
  // Keyed, so opening another script starts from a clean state.
  return <ScriptEditor key={id} initial={loaded.data.script} />;
}

function ScriptEditor({ initial }: { initial: Script }) {
  const { user } = useAuth();
  const [params, setParams] = useSearchParams();
  // `base` is the script as last saved or loaded; `draft` is what is on screen.
  const [base, setBase] = useState(initial);
  const [draft, setDraft] = useState<Draft>(() => draftOf(initial));
  const [changeSummary, setChangeSummary] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [conflict, setConflict] = useState<VersionConflict | null>(null);
  const [latest, setLatest] = useState<Script | null>(null); // fetched for "Compare with latest"
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const archived = base.projectStatus !== 'ACTIVE';
  // The API refuses writes from a VIEWER and in an archived project, so the controls are not offered.
  const canWrite = (user?.role === 'ADMIN' || user?.role === 'USER') && !archived;
  const editing = canWrite && params.get('edit') === '1';
  const changed = {
    name: draft.name !== base.name,
    description: draft.description !== base.description,
    testScenario: draft.testScenario !== base.testScenario,
    tags: !sameTags(draft.tags, base.tags),
    content: draft.content !== base.content,
  };
  const dirty = editing && Object.values(changed).some(Boolean);
  const guard = useUnsavedGuard(dirty);

  /** Shows `script` as the saved state and drops any edits. */
  function show(script: Script) {
    setBase(script);
    setDraft(draftOf(script));
    setChangeSummary('');
    setConflict(null);
    setLatest(null);
  }

  /** Runs a request with the busy flag set and reports a failure on the page. */
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setStatus(null);
    try {
      await work();
    } catch (err) {
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        setConflict(err.details as VersionConflict);
      } else {
        setError(errorMessage(err));
      }
    } finally {
      setBusy(false);
    }
  }

  const save = () =>
    run(async () => {
      if (!draft.name.trim()) throw new Error('Script name is required.');
      if (!draft.content) throw new Error('Script content cannot be empty.');

      // Only what changed is sent; content always travels with the version it was based on.
      const patch: ScriptPatch = {};
      if (changed.name) patch.name = draft.name;
      if (changed.description) patch.description = draft.description;
      if (changed.testScenario) patch.testScenario = draft.testScenario;
      if (changed.tags) patch.tags = draft.tags;
      if (changed.content) {
        patch.content = draft.content;
        patch.baseVersion = base.version;
        if (changeSummary.trim()) patch.changeSummary = changeSummary.trim();
      }

      const { script } = await scriptsApi.update(base.id, patch);
      const message = script.version === base.version ? 'Saved.' : `Saved as v${script.version}.`;
      show(script);
      setStatus(message);
    });

  const reloadLatest = () =>
    run(async () => {
      show((await scriptsApi.get(base.id)).script);
    });

  const compareWithLatest = () =>
    run(async () => {
      setLatest((await scriptsApi.get(base.id)).script);
    });

  /** Keeps what the user changed, on top of the latest version, so the next Save succeeds. */
  function keepMine() {
    if (!latest) return;
    setDraft({
      name: changed.name ? draft.name : latest.name,
      description: changed.description ? draft.description : latest.description,
      testScenario: changed.testScenario ? draft.testScenario : latest.testScenario,
      tags: changed.tags ? draft.tags : latest.tags,
      content: draft.content,
    });
    setBase(latest);
    setConflict(null);
    setLatest(null);
    setStatus(`Your text is now based on v${latest.version}. Save to store it as v${latest.version + 1}.`);
  }

  const download = () =>
    run(async () => {
      const file = await scriptsApi.download(base.id);
      saveTextFile(file.fileName, file.text);
    });

  const startEditing = () => setParams({ edit: '1' }, { replace: true });
  const stopEditing = () => {
    show(base);
    setError(null);
    setStatus(null);
    setConfirmDiscard(false);
    setParams({}, { replace: true });
  };
  const cancel = () => (dirty ? setConfirmDiscard(true) : stopEditing());

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{base.name}</h1>
          <p className="muted">
            v{base.version} · {base.language} · {base.scriptType} · updated {new Date(base.updatedAt).toLocaleString()}
            {base.updatedBy ? ` by ${base.updatedBy}` : ''}
          </p>
        </div>
        <StatusBadge status={base.lifecycleState} />
      </div>
      {archived && <p className="muted">This project is archived, so its scripts cannot be changed.</p>}

      <div className="toolbar">
        <Link to={`/projects/${base.projectId}?tab=scripts`}>Back to scripts</Link>
        <Link className="btn btn-secondary" to={`/scripts/${base.id}/versions`}>Version History</Link>
        <button className="btn btn-secondary" onClick={() => void download()} disabled={busy}>Download</button>
        {canWrite && !editing && <button className="btn btn-primary" onClick={startEditing}>Edit</button>}
      </div>

      {conflict && (
        <div className="notice notice-warn" role="alert">
          <p>
            {conflict.updatedBy ?? 'Someone else'} saved v{conflict.currentVersion} while you were editing.
            Your text is still in the editor and has not been saved.
          </p>
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={() => void reloadLatest()} disabled={busy}>
              Reload latest
            </button>
            <button className="btn btn-secondary" onClick={() => void compareWithLatest()} disabled={busy}>
              Compare with latest
            </button>
          </div>
        </div>
      )}

      {latest && (
        <section className="notice" aria-label="Comparison with the latest version">
          <h2>Latest version (v{latest.version}) on the left, your text on the right</h2>
          <CodeDiff left={latest.content} right={draft.content} leftLabel="Latest version" rightLabel="Your text"
            language={base.language} />
          <div className="form-actions">
            <button className="btn btn-primary" onClick={keepMine}>Keep my text</button>
          </div>
        </section>
      )}

      {editing ? (
        <div className="form">
          <label htmlFor="script-name">Script Name</label>
          <input id="script-name" maxLength={200} value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <label htmlFor="script-description">Description</label>
          <textarea id="script-description" maxLength={2000} value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
          <label htmlFor="script-scenario">Test Scenario</label>
          <textarea id="script-scenario" maxLength={5000} value={draft.testScenario}
            onChange={(e) => setDraft({ ...draft, testScenario: e.target.value })} />
          <label htmlFor="script-tags">Tags</label>
          <TagInput id="script-tags" tags={draft.tags} onChange={(tags) => setDraft((d) => ({ ...d, tags }))} />
        </div>
      ) : (
        <>
          {base.description && <p>{base.description}</p>}
          {base.testScenario && (
            <>
              <h2>Test Scenario</h2>
              <p className="pre-wrap">{base.testScenario}</p>
            </>
          )}
          {base.tags.length > 0 && (
            <p>
              {base.tags.map((name) => <span key={name} className="chip">{name}</span>)}
            </p>
          )}
        </>
      )}

      <span className="field-label">Script</span>
      <CodeEditor
        label="Script content"
        value={draft.content}
        language={base.language}
        readOnly={!editing}
        onChange={(content) => setDraft((d) => ({ ...d, content }))}
      />

      {error && <p className="error" role="alert">{error}</p>}
      {status && <p className="muted" role="status">{status}</p>}

      {editing && (
        <div className="form">
          <label htmlFor="change-summary">Change summary (optional)</label>
          <input id="change-summary" maxLength={500} value={changeSummary} placeholder="What changed in this version?"
            onChange={(e) => setChangeSummary(e.target.value)} />
          <div className="form-actions">
            <button className="btn btn-secondary" onClick={cancel} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => void save()} disabled={busy || !dirty}>Save</button>
          </div>
        </div>
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          message="Your edits to this script will be lost."
          confirmLabel="Discard changes"
          danger
          onCancel={() => setConfirmDiscard(false)}
          onConfirm={async () => stopEditing()}
        />
      )}
      {guard.dialog}
    </>
  );
}
