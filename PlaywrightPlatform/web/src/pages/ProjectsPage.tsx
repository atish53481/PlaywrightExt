import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import { projectsApi } from '../api/projects';
import type { ProjectListItem, ProjectStatus } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useDebounced } from '../hooks/useDebounced';
import { useLoad } from '../hooks/useLoad';

type Dialog =
  | { kind: 'create' }
  | { kind: 'edit'; project: ProjectListItem }
  | { kind: 'archive'; project: ProjectListItem }
  | { kind: 'delete'; project: ProjectListItem };

export function ProjectsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === 'ADMIN';
  const navigate = useNavigate();
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<ProjectStatus>('ACTIVE');
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const debouncedSearch = useDebounced(search, 250);

  const { data, error, loading, reload } = useLoad(
    () => projectsApi.list({ search: debouncedSearch, status }),
    [debouncedSearch, status],
  );

  const close = () => setDialog(null);
  const closeAndReload = () => {
    close();
    reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>Projects</h1>
        {isAdmin && (
          <button className="btn btn-primary" onClick={() => setDialog({ kind: 'create' })}>Create Project</button>
        )}
      </div>

      <div className="toolbar">
        <input type="search" placeholder="Search projects..." aria-label="Search projects" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <label htmlFor="status-filter">Status</label>
        <select id="status-filter" value={status} onChange={(e) => setStatus(e.target.value as ProjectStatus)}>
          <option value="ACTIVE">Active</option>
          <option value="ARCHIVED">Archived</option>
        </select>
        <button className="btn btn-secondary" onClick={reload}>Refresh</button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {loading && !data && <p className="muted">Loading projects…</p>}
      {data && data.items.length === 0 && (
        <p className="muted center">
          {search ? 'No projects match your search.' : 'No projects yet.'}
        </p>
      )}

      {data && data.items.length > 0 && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Project Name</th>
                <th>Scripts</th>
                <th>Last Run</th>
                <th>Status</th>
                {isAdmin && <th aria-label="Actions" />}
              </tr>
            </thead>
            <tbody>
              {data.items.map((project) => (
                <tr key={project.id}>
                  <td>
                    <Link to={`/projects/${project.id}`}>{project.name}</Link>
                    {project.description && <div className="muted">{project.description}</div>}
                  </td>
                  <td>{project.scriptCount}</td>
                  <td><StatusBadge status={project.lastRunStatus} /></td>
                  <td><StatusBadge status={project.status} /></td>
                  {isAdmin && (
                    <td className="actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'edit', project })}>Edit</button>
                      {project.status === 'ACTIVE' ? (
                        <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'archive', project })}>Archive</button>
                      ) : (
                        <button className="btn btn-secondary btn-sm"
                          onClick={() => void projectsApi.update(project.id, { status: 'ACTIVE' }).then(reload)}>
                          Restore
                        </button>
                      )}
                      <button className="btn btn-danger btn-sm" onClick={() => setDialog({ kind: 'delete', project })}>Delete</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'create' && (
        <ProjectForm
          title="Create New Project"
          submitLabel="Create Project"
          initial={{ name: '', description: '' }}
          onCancel={close}
          onSubmit={async (values) => {
            const { project } = await projectsApi.create(values);
            navigate(`/projects/${project.id}`);
          }}
        />
      )}
      {dialog?.kind === 'edit' && (
        <ProjectForm
          title="Edit Project"
          submitLabel="Save"
          initial={{ name: dialog.project.name, description: dialog.project.description }}
          onCancel={close}
          onSubmit={async (values) => {
            await projectsApi.update(dialog.project.id, values);
            closeAndReload();
          }}
        />
      )}
      {dialog?.kind === 'archive' && (
        <ConfirmDialog
          title="Archive project"
          message={`Archive "${dialog.project.name}"? It moves to the Archived list and can be restored later.`}
          confirmLabel="Archive"
          onCancel={close}
          onConfirm={async () => {
            await projectsApi.update(dialog.project.id, { status: 'ARCHIVED' });
            closeAndReload();
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title="Are you sure?"
          message={`This will remove the project "${dialog.project.name}". Its execution history is kept.`}
          confirmLabel="Delete"
          danger
          onCancel={close}
          onConfirm={async () => {
            await projectsApi.remove(dialog.project.id);
            closeAndReload();
          }}
        />
      )}
    </>
  );
}

interface ProjectFormProps {
  title: string;
  submitLabel: string;
  initial: { name: string; description: string };
  onSubmit(values: { name: string; description: string }): Promise<void>;
  onCancel(): void;
}

function ProjectForm({ title, submitLabel, initial, onSubmit, onCancel }: ProjectFormProps) {
  const [name, setName] = useState(initial.name);
  const [description, setDescription] = useState(initial.description);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onSubmit({ name, description });
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="project-name">Project Name</label>
        <input id="project-name" required maxLength={120} autoFocus value={name} onChange={(e) => setName(e.target.value)} />
        <label htmlFor="project-description">Description</label>
        <textarea id="project-description" maxLength={2000} value={description}
          onChange={(e) => setDescription(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{submitLabel}</button>
        </div>
      </form>
    </Modal>
  );
}
