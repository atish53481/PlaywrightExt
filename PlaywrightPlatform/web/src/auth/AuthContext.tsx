import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { authApi } from '../api/auth';
import { setCsrfToken, setUnauthorizedHandler } from '../api/client';
import type { User } from '../api/types';

interface AuthValue {
  user: User | null;
  /** True until the first /auth/me probe finishes. */
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const clear = useCallback(() => {
    setCsrfToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(clear);
    authApi
      .me()
      .then(({ user: current, csrfToken }) => {
        setCsrfToken(csrfToken);
        setUser(current);
      })
      .catch(clear)
      .finally(() => setLoading(false));
    return () => setUnauthorizedHandler(null);
  }, [clear]);

  const login = useCallback(async (email: string, password: string) => {
    const result = await authApi.login(email, password);
    setCsrfToken(result.csrfToken);
    setUser(result.user);
  }, []);

  const logout = useCallback(async () => {
    try {
      await authApi.logout();
    } finally {
      clear();
    }
  }, [clear]);

  const value = useMemo(() => ({ user, loading, login, logout }), [user, loading, login, logout]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) throw new Error('useAuth must be used inside <AuthProvider>.');
  return value;
}
