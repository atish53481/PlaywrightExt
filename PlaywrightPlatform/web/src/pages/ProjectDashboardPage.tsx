import { Link, useParams, useSearchParams } from 'react-router-dom';
import { projectsApi } from '../api/projects';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';
import { ScriptsTab } from './ScriptsTab';

const TABS = ['Overview', 'Scripts', 'Executions', 'CI/CD', 'Reports', 'Skills', 'Settings'] as const;
type Tab = (typeof TABS)[number];

/** 'CI/CD' becomes 'ci-cd'. The slug is what the address shows as ?tab=. */
function slug(tab: Tab): string {
  return tab.toLowerCase().replace(/[^a-z]+/g, '-');
}

function formatWhen(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : 'Never';
}

export function ProjectDashboardPage() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const tab: Tab = TABS.find((name) => slug(name) === params.get('tab')) ?? 'Overview';
  const { data, error, loading, reload } = useLoad(() => projectsApi.get(id), [id]);

  function open(name: Tab) {
    // Replaced, not pushed: Back then leaves the project instead of walking through its tabs.
    setParams(name === 'Overview' ? {} : { tab: slug(name) }, { replace: true });
    if (name === 'Overview') reload(); // the counters may have changed on another tab
  }

  if (error) {
    return (
      <>
        <p className="error" role="alert">{error}</p>
        <Link to="/projects">Back to projects</Link>
      </>
    );
  }
  // While a different project is loading, the previous one must not be shown under the new address.
  if (!data || (loading && data.project.id !== id)) return <p className="muted">Loading project…</p>;

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
          <button key={name} role="tab" className="tab" aria-selected={tab === name} onClick={() => open(name)}>
            {name}
          </button>
        ))}
      </div>

      {tab === 'Overview' && (
        <div className="stats">
          {stats.map(([label, value]) => (
            <div className="card" key={label}>
              <div className="stat-value">{value}</div>
              <div className="stat-label">{label}</div>
            </div>
          ))}
        </div>
      )}
      {tab === 'Scripts' && <ScriptsTab project={project} />}
      {tab !== 'Overview' && tab !== 'Scripts' && <p className="muted center">{tab} is not available yet.</p>}
    </>
  );
}
