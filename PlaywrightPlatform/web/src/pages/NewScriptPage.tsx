import { useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { projectsApi } from '../api/projects';
import { scriptsApi } from '../api/scripts';
import type { ScriptLanguage, ScriptType } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { CodeEditor } from '../components/CodeEditor';
import { TagInput } from '../components/TagInput';
import { useLoad } from '../hooks/useLoad';
import { useUnsavedGuard } from '../hooks/useUnsavedGuard';
import type { ImportedScript } from '../importFile';

export function NewScriptPage() {
  const projectId = Number(useParams().projectId);
  const { user } = useAuth();
  const navigate = useNavigate();
  // Set by the Import button on the Scripts tab.
  const imported = (useLocation().state as { imported?: ImportedScript } | null)?.imported;
  const project = useLoad(() => projectsApi.get(projectId), [projectId]);

  const [name, setName] = useState(imported?.name ?? '');
  const [description, setDescription] = useState('');
  const [testScenario, setTestScenario] = useState('');
  const [language, setLanguage] = useState<ScriptLanguage>(imported?.language ?? 'TypeScript');
  const [scriptType, setScriptType] = useState<ScriptType>('E2E');
  const [tags, setTags] = useState<string[]>([]);
  const [content, setContent] = useState(imported?.content ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const isViewer = user?.role === 'VIEWER';
  const dirty = !isViewer && Boolean(name || description || testScenario || content || tags.length > 0);
  const guard = useUnsavedGuard(dirty);
  const back = `/projects/${projectId}?tab=scripts`;

  if (isViewer) return <Navigate to={back} replace />;
  if (project.error) {
    return (
      <>
        <p className="error" role="alert">{project.error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!content.trim()) {
      setError('Add the script content before saving.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { script } = await scriptsApi.create(projectId, {
        name,
        description,
        testScenario,
        content,
        language,
        scriptType,
        tags,
        source: imported ? 'IMPORTED' : 'MANUAL',
      });
      guard.allowLeave();
      // Replaced, so Back from the new script does not return to this filled-in form.
      navigate(`/scripts/${script.id}`, { replace: true });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{imported ? 'Import Script' : 'New Script'}</h1>
          {project.data && <p className="muted">Project: {project.data.project.name}</p>}
        </div>
        <Link to={back}>Back to scripts</Link>
      </div>

      <form className="form" onSubmit={submit}>
        <label htmlFor="script-name">Script Name</label>
        <input id="script-name" required maxLength={200} autoFocus value={name}
          onChange={(e) => setName(e.target.value)} />

        <label htmlFor="script-description">Description</label>
        <textarea id="script-description" maxLength={2000} value={description}
          onChange={(e) => setDescription(e.target.value)} />

        <label htmlFor="script-scenario">Test Scenario</label>
        <textarea id="script-scenario" maxLength={5000} value={testScenario}
          onChange={(e) => setTestScenario(e.target.value)} />

        <div className="field-row">
          <div className="form">
            <label htmlFor="script-language">Language</label>
            <select id="script-language" value={language}
              onChange={(e) => setLanguage(e.target.value as ScriptLanguage)}>
              <option value="TypeScript">TypeScript</option>
              <option value="JavaScript">JavaScript</option>
            </select>
          </div>
          <div className="form">
            <label htmlFor="script-type">Type</label>
            <select id="script-type" value={scriptType} onChange={(e) => setScriptType(e.target.value as ScriptType)}>
              <option value="E2E">E2E</option>
              <option value="API">API</option>
              <option value="COMPONENT">Component</option>
            </select>
          </div>
        </div>

        <label htmlFor="script-tags">Tags</label>
        <TagInput id="script-tags" tags={tags} onChange={setTags} />

        <span className="field-label">Script</span>
        <CodeEditor label="Script content" value={content} language={language} onChange={setContent} />

        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <Link className="btn btn-secondary" to={back}>Cancel</Link>
          <button type="submit" className="btn btn-primary" disabled={busy}>Create Script</button>
        </div>
      </form>
      {guard.dialog}
    </>
  );
}
