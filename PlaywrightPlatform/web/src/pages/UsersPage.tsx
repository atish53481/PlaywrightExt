import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { errorMessage } from '../api/client';
import type { Role, User, UserStatus } from '../api/types';
import { usersApi } from '../api/users';
import { useAuth } from '../auth/AuthContext';
import { Modal } from '../components/Modal';
import { StatusBadge } from '../components/StatusBadge';
import { useLoad } from '../hooks/useLoad';

const ROLES: Role[] = ['ADMIN', 'USER', 'VIEWER'];

export function UsersPage() {
  const { user: me } = useAuth();
  const { data, error, loading, reload } = useLoad(() => usersApi.list(), []);
  const [dialog, setDialog] = useState<{ kind: 'create' } | { kind: 'edit'; user: User } | null>(null);

  if (me?.role !== 'ADMIN') return <Navigate to="/projects" replace />;

  const done = () => {
    setDialog(null);
    reload();
  };

  return (
    <>
      <div className="page-head">
        <h1>Users</h1>
        <button className="btn btn-primary" onClick={() => setDialog({ kind: 'create' })}>Create User</button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {loading && !data && <p className="muted">Loading users…</p>}

      {data && (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last Sign-in</th>
                <th aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {data.items.map((user) => (
                <tr key={user.id}>
                  <td>{user.email}</td>
                  <td>{user.displayName}</td>
                  <td><span className="badge badge-neutral">{user.role}</span></td>
                  <td><StatusBadge status={user.status} /></td>
                  <td className="muted">{user.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Never'}</td>
                  <td className="actions">
                    <button className="btn btn-secondary btn-sm" onClick={() => setDialog({ kind: 'edit', user })}>Edit</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog?.kind === 'create' && <CreateUserForm onCancel={() => setDialog(null)} onDone={done} />}
      {dialog?.kind === 'edit' && <EditUserForm user={dialog.user} onCancel={() => setDialog(null)} onDone={done} />}
    </>
  );
}

function useSubmit(action: () => Promise<void>) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return { submit, error, busy };
}

function CreateUserForm({ onCancel, onDone }: { onCancel(): void; onDone(): void }) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');
  const { submit, error, busy } = useSubmit(async () => {
    await usersApi.create({ email, displayName, password, role });
    onDone();
  });

  return (
    <Modal title="Create User" onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="user-email">Email</label>
        <input id="user-email" type="email" required autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
        <label htmlFor="user-name">Display Name</label>
        <input id="user-name" required maxLength={120} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <label htmlFor="user-password">Password</label>
        <input id="user-password" type="password" required minLength={8} autoComplete="new-password" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        <label htmlFor="user-role">Role</label>
        <select id="user-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>Create User</button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserForm({ user, onCancel, onDone }: { user: User; onCancel(): void; onDone(): void }) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [role, setRole] = useState<Role>(user.role);
  const [status, setStatus] = useState<UserStatus>(user.status);
  const [password, setPassword] = useState('');
  const { submit, error, busy } = useSubmit(async () => {
    await usersApi.update(user.id, {
      displayName: displayName !== user.displayName ? displayName : undefined,
      role: role !== user.role ? role : undefined,
      status: status !== user.status ? status : undefined,
      password: password || undefined,
    });
    onDone();
  });
  const unchanged = displayName === user.displayName && role === user.role && status === user.status && !password;

  return (
    <Modal title={`Edit ${user.email}`} onClose={onCancel}>
      <form className="form" onSubmit={submit}>
        <label htmlFor="edit-name">Display Name</label>
        <input id="edit-name" required maxLength={120} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <label htmlFor="edit-role">Role</label>
        <select id="edit-role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
          {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
        </select>
        <label htmlFor="edit-status">Status</label>
        <select id="edit-status" value={status} onChange={(e) => setStatus(e.target.value as UserStatus)}>
          <option value="ACTIVE">ACTIVE</option>
          <option value="DISABLED">DISABLED</option>
        </select>
        <label htmlFor="edit-password">New Password (leave blank to keep)</label>
        <input id="edit-password" type="password" minLength={8} autoComplete="new-password" value={password}
          onChange={(e) => setPassword(e.target.value)} />
        {error && <p className="error" role="alert">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
          <button type="submit" className="btn btn-primary" disabled={busy || unchanged}>Save</button>
        </div>
      </form>
    </Modal>
  );
}
