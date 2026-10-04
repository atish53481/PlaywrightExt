import { useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { errorMessage } from '../api/client';
import { skillsApi, type ProjectSkill, type Skill } from '../api/skills';
import type { Project } from '../api/types';
import { useAuth } from '../auth/AuthContext';
import { saveTextFile } from '../download';
import { useDebounced } from '../hooks/useDebounced';
import { useLoad } from '../hooks/useLoad';

// The server keeps 200,000 characters; a larger file is refused before it is read.
const UPLOAD_LIMIT_BYTES = 300_000;

/** What the editor opens with: an existing skill, or the start of a new one. */
interface Draft {
  skill: Skill | null;
  name: string;
  description: string;
  content: string;
  tags: string;
  fileName?: string;
}

const emptyDraft: Draft = { skill: null, name: '', description: '', content: '', tags: '' };

function draftOf(skill: Skill): Draft {
  return { skill, name: skill.name, description: skill.description, content: skill.content, tags: skill.tags.join(', ') };
}

/** "smoke, Auth , smoke" becomes ['smoke', 'Auth']; the server applies the rules for a tag. */
function tagList(text: string): string[] {
  return [...new Set(text.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

/**
 * A project's skills: the Markdown notes of rules and examples that the AI agents in the
 * extension are given. Skill text is always shown as plain text, never rendered.
 */
export function SkillsTab({ project }: { project: Project }) {
  const { user } = useAuth();
  const fileInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const debouncedSearch = useDebounced(search, 250);

  const archived = project.status !== 'ACTIVE';
  // The API refuses writes from a VIEWER and in an archived project, so the controls are not offered.
  const canWrite = user?.role !== 'VIEWER' && !archived;
  const isAdmin = user?.role === 'ADMIN';

  const skills = useLoad(() => skillsApi.list(project.id, debouncedSearch), [project.id, debouncedSearch]);

  /** `undo` puts a control back when the server refuses the change. */
  async function change(
    skill: ProjectSkill,
    patch: { attached?: boolean; enabled?: boolean; priority?: number },
    undo?: () => void,
  ) {
    try {
      await skillsApi.setForProject(project.id, skill.id, patch);
      setProblem(null);
    } catch (err) {
      undo?.();
      setProblem(errorMessage(err));
    }
    skills.reload();
  }

  async function open(skill: ProjectSkill) {
    try {
      setDraft(draftOf((await skillsApi.get(skill.id)).skill));
      setProblem(null);
    } catch (err) {
      setProblem(errorMessage(err));
    }
  }

  // An uploaded file is only read as text and put in the editor; nothing is stored until Save.
  async function onUpload(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = ''; // so the same file can be chosen again
    if (!file) return;
    if (file.size > UPLOAD_LIMIT_BYTES) {
      setProblem('That file is too large for a skill (300 KB at most).');
      return;
    }
    const content = await file.text();
    const heading = /^#\s+(.+)$/m.exec(content)?.[1]?.trim();
    const base = file.name.replace(/(\.skill)?\.(md|markdown|txt)$/i, '');
    // The server takes a plain .md name only; any other name is simply not kept.
    const fileName = /^[A-Za-z0-9][A-Za-z0-9._ -]*\.md$/.test(file.name) && file.name.length <= 120 ? file.name : undefined;
    setProblem(null);
    setDraft({ ...emptyDraft, name: (heading || base).slice(0, 200), content, fileName });
  }

  if (draft) {
    return (
      <SkillEditor
        key={draft.skill ? `${draft.skill.id}-${draft.skill.version}` : 'new'}
        project={project}
        draft={draft}
        canWrite={canWrite}
        isAdmin={isAdmin}
        onOpen={setDraft}
        onClose={() => {
          setDraft(null);
          skills.reload();
        }}
      />
    );
  }

  const items = skills.data?.items ?? [];
  return (
    <>
      {archived && <p className="muted">This project is archived, so its skills cannot be changed.</p>}
      <p className="muted">
        A skill is a Markdown note of rules and examples for the AI agents. Ticked skills are given to the Planner,
        Generator, and Healer in the extension, lowest order number first.
      </p>

      {canWrite && (
        <div className="toolbar">
          <button className="btn btn-primary" onClick={() => setDraft(emptyDraft)}>New Skill</button>
          <button className="btn btn-secondary" onClick={() => fileInput.current?.click()}>Upload .md</button>
          <input ref={fileInput} type="file" hidden accept=".md,.markdown,.txt,text/markdown,text/plain"
            aria-label="Upload skill file" onChange={(e) => void onUpload(e)} />
        </div>
      )}

      <div className="toolbar">
        <input type="search" placeholder="Search skills..." aria-label="Search skills" value={search}
          onChange={(e) => setSearch(e.target.value)} />
        <button className="btn btn-secondary" onClick={skills.reload}>Refresh</button>
      </div>

      {problem && <p className="error" role="alert">{problem}</p>}
      {skills.error && <p className="error" role="alert">{skills.error}</p>}
      {skills.data && items.length === 0 && (
        <p className="muted center">{debouncedSearch.trim() ? 'No skills match the search.' : 'No skills yet.'}</p>
      )}

      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Use</th>
              <th>Skill</th>
              <th>Scope</th>
              <th>Version</th>
              <th>Tags</th>
              <th>Order</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {items.map((skill) => (
              <tr key={skill.id}>
                <td>
                  {/* Ticking a global skill the project does not have yet also attaches it. */}
                  {/* The box answers the click at once; if the server refuses, it goes back. */}
                  <input type="checkbox" aria-label={`Use ${skill.name} in this project`} defaultChecked={skill.enabled}
                    key={String(skill.enabled)} disabled={!canWrite}
                    onChange={(e) => {
                      const box = e.target;
                      void change(skill, box.checked ? { attached: true, enabled: true } : { enabled: false }, () => {
                        box.checked = skill.enabled;
                      });
                    }} />
                </td>
                <td>
                  <strong>{skill.name}</strong>
                  {skill.description && <div className="muted">{skill.description}</div>}
                </td>
                <td>{skill.scope === 'GLOBAL' ? 'Global' : 'Project'}</td>
                <td>v{skill.version}</td>
                <td>{skill.tags.join(', ')}</td>
                <td>
                  <input type="number" min={1} max={1000} aria-label={`Order of ${skill.name}`} defaultValue={skill.priority}
                    key={skill.priority} disabled={!canWrite} style={{ width: '5em' }}
                    onBlur={(e) => {
                      const priority = Number(e.target.value);
                      if (Number.isInteger(priority) && priority >= 1 && priority <= 1000 && priority !== skill.priority) {
                        void change(skill, { priority });
                      } else {
                        e.target.value = String(skill.priority);
                      }
                    }} />
                </td>
                <td className="actions">
                  <button className="btn btn-secondary" onClick={() => void open(skill)}>Open</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

interface EditorProps {
  project: Project;
  draft: Draft;
  canWrite: boolean;
  isAdmin: boolean;
  /** Shows another draft in the editor: the skill after a save, or a copy of it. */
  onOpen: (draft: Draft) => void;
  onClose: () => void;
}

function SkillEditor({ project, draft, canWrite, isAdmin, onOpen, onClose }: EditorProps) {
  const skill = draft.skill;
  const [name, setName] = useState(draft.name);
  const [description, setDescription] = useState(draft.description);
  const [content, setContent] = useState(draft.content);
  const [tags, setTags] = useState(draft.tags);
  const [summary, setSummary] = useState('');
  const [global, setGlobal] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  // A global skill is changed by an ADMIN only; everyone else reads it.
  const writable = canWrite && (!skill || skill.scope === 'PROJECT' || isAdmin);
  const versions = useLoad(
    () => (skill ? skillsApi.versions(skill.id) : Promise.resolve({ items: [] })),
    [skill?.id, skill?.version],
  );

  async function run(work: () => Promise<void>) {
    setBusy(true);
    try {
      await work();
      setProblem(null);
    } catch (err) {
      setProblem(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const body = { name: name.trim(), description: description.trim(), content, tags: tagList(tags) };
    void run(async () => {
      if (skill) {
        const patch = summary.trim() ? { ...body, changeSummary: summary.trim() } : body;
        onOpen(draftOf((await skillsApi.update(skill.id, patch)).skill));
        return;
      }
      const created = (await skillsApi.create(global ? null : project.id, { ...body, fileName: draft.fileName })).skill;
      // A new global skill is put to use in the project it was written from.
      if (global) await skillsApi.setForProject(project.id, created.id, { attached: true });
      onClose();
    });
  }

  const scope = skill?.scope === 'GLOBAL' ? 'Global skill' : 'Project skill';
  return (
    <>
      <div className="toolbar">
        <button className="btn btn-secondary" onClick={onClose}>Back to skills</button>
      </div>
      <h2>{skill ? `${skill.name} · v${skill.version}` : 'New skill'}</h2>
      {skill && <p className="muted">{scope}{!writable && ' · read only'}</p>}
      {problem && <p className="error" role="alert">{problem}</p>}

      <form className="form" onSubmit={submit}>
        <label htmlFor="skill-name">Skill name</label>
        <input id="skill-name" value={name} maxLength={200} required readOnly={!writable}
          onChange={(e) => setName(e.target.value)} />

        <label htmlFor="skill-description">Description</label>
        <input id="skill-description" value={description} maxLength={2000} readOnly={!writable}
          onChange={(e) => setDescription(e.target.value)} />

        <label htmlFor="skill-tags">Tags</label>
        <input id="skill-tags" value={tags} maxLength={900} readOnly={!writable} placeholder="smoke, login"
          onChange={(e) => setTags(e.target.value)} />

        {!skill && isAdmin && (
          <label>
            <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> Global skill (any
            project can attach it)
          </label>
        )}

        <label htmlFor="skill-content">Skill text</label>
        <textarea id="skill-content" value={content} rows={18} maxLength={200_000} required readOnly={!writable}
          spellCheck={false} style={{ fontFamily: 'monospace' }} onChange={(e) => setContent(e.target.value)} />

        {skill && writable && (
          <>
            <label htmlFor="skill-summary">What changed</label>
            <input id="skill-summary" value={summary} maxLength={500} onChange={(e) => setSummary(e.target.value)} />
          </>
        )}

        <div className="form-actions">
          {writable && <button className="btn btn-primary" type="submit" disabled={busy}>Save skill</button>}
          {skill && canWrite && (
            // A copy is a new skill of this project; nothing is stored until Save.
            <button className="btn btn-secondary" type="button"
              onClick={() => onOpen({ ...emptyDraft, name: `${skill.name} (copy)`.slice(0, 200), description, content, tags })}>
              Duplicate
            </button>
          )}
          {skill && (
            <button className="btn btn-secondary" type="button"
              onClick={() => saveTextFile(skill.fileName ?? `${skill.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skill'}.skill.md`, content)}>
              Download .md
            </button>
          )}
          {skill && writable && (
            <button className="btn btn-secondary" type="button" disabled={busy}
              onClick={() => {
                if (!confirmArchive) { setConfirmArchive(true); return; }
                void run(async () => {
                  await skillsApi.archive(skill.id);
                  onClose();
                });
              }}>
              {confirmArchive ? 'Confirm archive' : 'Archive'}
            </button>
          )}
        </div>
      </form>

      {skill && (
        <>
          <h3>Versions</h3>
          {versions.error && <p className="error" role="alert">{versions.error}</p>}
          <table>
            <tbody>
              {(versions.data?.items ?? []).map((version) => (
                <tr key={version.version}>
                  <td>v{version.version}</td>
                  <td>{version.changeSummary}</td>
                  <td>{version.createdBy ?? ''}</td>
                  <td>{new Date(version.createdAt).toLocaleString()}</td>
                  <td className="actions">
                    {writable && version.version !== skill.version && (
                      <button className="btn btn-secondary" disabled={busy}
                        onClick={() => void run(async () => onOpen(draftOf((await skillsApi.restore(skill.id, version.version)).skill)))}>
                        Restore v{version.version}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}
