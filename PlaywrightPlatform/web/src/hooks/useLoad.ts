import { useCallback, useEffect, useState, type DependencyList } from 'react';
import { errorMessage } from '../api/client';

export interface LoadState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload(): void;
}

/** Runs `load` on mount, whenever `deps` change, and on `reload()`. Ignores stale responses. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): LoadState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let current = true;
    setLoading(true);
    load()
      .then((result) => {
        if (!current) return;
        setData(result);
        setError(null);
      })
      .catch((err) => {
        if (current) setError(errorMessage(err));
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
    // `load` is intentionally excluded: callers pass a fresh closure every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { data, error, loading, reload };
}
