import { NavLink, Outlet } from 'react-router-dom';
import { useAuth } from '../auth/AuthContext';

// Sections that later sub-projects will build. Shown so the product shape is visible.
const COMING_SOON = ['Dashboard', 'Playwright Agents', 'CI/CD', 'Reports', 'Skills'];

export function AppShell() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">PLAYWRIGHT AI</div>
        <nav aria-label="Main">
          <span className="nav-item disabled" title="Coming soon">Dashboard</span>
          <NavLink className="nav-item" to="/projects">Projects</NavLink>
          {COMING_SOON.slice(1).map((label) => (
            <span key={label} className="nav-item disabled" title="Coming soon">
              {label}
            </span>
          ))}
          {user.role === 'ADMIN' && (
            <NavLink className="nav-item" to="/settings/users">Settings</NavLink>
          )}
        </nav>
      </aside>
      <div className="main">
        <header className="topbar">
          <span className="muted">{user.email}</span>
          <span className="badge badge-neutral">{user.role}</span>
          <button className="btn btn-secondary" onClick={() => void logout()}>Sign out</button>
        </header>
        <main className="content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
