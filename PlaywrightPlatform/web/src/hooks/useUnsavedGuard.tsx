import { useEffect, useRef, type ReactNode } from 'react';
import { useBlocker } from 'react-router-dom';
import { ConfirmDialog } from '../components/ConfirmDialog';

export interface UnsavedGuard {
  /** Render this somewhere in the page: it is the confirmation dialog, or null. */
  dialog: ReactNode;
  /** Call right before navigating away on purpose, for example after a successful save. */
  allowLeave(): void;
}

/**
 * While `dirty` is true, asks before the user leaves the page through a link or the
 * Back button, and lets the browser warn on reload and on closing the tab.
 * Changing only the query string (for example ?edit=1) is not leaving.
 */
export function useUnsavedGuard(dirty: boolean): UnsavedGuard {
  const leaving = useRef(false);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && !leaving.current && currentLocation.pathname !== nextLocation.pathname,
  );

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = ''; // older browsers show the prompt only when this is set
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const dialog =
    blocker.state === 'blocked' ? (
      <ConfirmDialog
        title="Discard unsaved changes?"
        message="You have changes that are not saved. Leave this page and lose them?"
        confirmLabel="Discard changes"
        danger
        onCancel={() => blocker.reset?.()}
        onConfirm={async () => blocker.proceed?.()}
      />
    ) : null;

  return {
    dialog,
    allowLeave: () => {
      leaving.current = true;
    },
  };
}
