import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { projectsApi } from '../api/projects';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';

const TABS = ['Overview', 'Scripts', 'Executions', 'CI/CD', 'Reports', 'Skills', 'Settings'] as const;
type Tab = (typeof TABS)[number];

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

export function ProjectDashboardPage() {
  const id = Number(useParams().id);
  const [tab, setTab] = useState<Tab>('Overview');
  const { data, error, loading } = useLoad(() => projectsApi.get(id), [id]);

  if (error) {
    return (
      <>
        <p className="error" role="alert">{error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  if (loading || !data) return <p className="muted">Loading project…</p>;

  const { project, overview } = data;
  const stats: [string, string | number][] = [
    ['Total Scripts', overview.totalScripts],
    ['Passed Tests', overview.passedScripts],
    ['Failed Tests', overview.failedScripts],
    ['Not Executed', overview.notExecuted],
    ['Last Execution', formatWhen(overview.lastExecutionAt)],
  ];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          {project.description && <p className="muted">{project.description}</p>}
        </div>
        <StatusBadge status={project.status} />
      </div>

      <div className="tabs" role="tablist">
        {TABS.map((name) => (
          <button key={name} role="tab" className="tab" aria-selected={tab === name} onClick={() => setTab(name)}>
            {name}
          </button>
        ))}
      </div>

      {tab === 'Overview' ? (
        <div className="stats">
          {stats.map(([label, value]) => (
            <div className="card" key={label}>
              <div className="stat-value">{value}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="muted center">{tab} is not available yet.</p>
      )}
    </>
  );
}
