import { useState } from 'react';
import { errorMessage } from '../api/client';
import { Modal } from './Modal';

interface Props {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm(): Promise<void>;
  onCancel(): void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }

  return (
    <Modal title={title} onClose={onCancel}>
      <p>{message}</p>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="form-actions">
        <button className="btn btn-secondary" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={`btn ${danger ? 'btn-danger' : 'btn-primary'}`} onClick={() => void confirm()} disabled={busy}>
          {confirmLabel}
        </button>
      </div>
    </Modal>
  );
}
