import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppShell } from './components/AppShell';
import { LoginPage } from './pages/LoginPage';
import { ProjectDashboardPage } from './pages/ProjectDashboardPage';
import { ProjectsPage } from './pages/ProjectsPage';
import { UsersPage } from './pages/UsersPage';

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
        <Route path="/settings/users" element={<UsersPage />} />
        <Route path="*" element={<Navigate to="/projects" replace />} />
      </Route>
    </Routes>
  );
}
