import { lazy, Suspense, type ReactNode } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { ProjectDashboardPage } from './pages/ProjectDashboardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { UsersPage } from './pages/UsersPage';

// These pages pull in CodeMirror, so their code is fetched only when one of them is opened.
const NewScriptPage = lazy(() => import('./pages/NewScriptPage').then((m) => ({ default: m.NewScriptPage })));
const ScriptPage = lazy(() => import('./pages/ScriptPage').then((m) => ({ default: m.ScriptPage })));

/** Wraps a lazily loaded page so only the page area, not the whole shell, waits for its code. */
function lazyPage(page: ReactNode) {
  return <Suspense fallback={<p className="muted">Loading…</p>}>{page}</Suspense>;
}

function RequireAuth() {
  const { user, loading } = useAuth();
  if (loading) return <p className="muted center">Loading…</p>;
  if (!user) return <Navigate to="/login" replace />;
  return <AppShell />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route element={<RequireAuth />}>
        <Route path="/projects" element={<ProjectsPage />} />
        <Route path="/projects/:id" element={<ProjectDashboardPage />} />
        <Route path="/projects/:projectId/scripts/new" element={lazyPage(<NewScriptPage />)} />
        <Route path="/scripts/:id" element={lazyPage(<ScriptPage />)} />
        <Route path="/settings/users" element={<UsersPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}
