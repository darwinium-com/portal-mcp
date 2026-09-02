/**
 * ErrorRow — dismissible warning row shown below the primary CTA.
 *
 * Auto-dismisses 60s after the error first fired. Manual `[×]` dismiss is also
 * available; the dismiss does NOT mute the underlying state — only this
 * transient row clears.
 *
 * The 60s window is computed against `showAt` (the lastErrorAt epoch ms), so
 * if the popup is opened LATE the timer fires immediately on mount.
 */
import { useEffect, type FC } from 'react';
import styles from './popup.module.css';

interface ErrorRowProps {
  message: string;
  onDismiss: () => void;
  /** Epoch ms when the underlying error fired (chrome.storage.session.lastErrorAt). */
  showAt: number;
}

/** 60-second auto-clear window. */
const AUTO_DISMISS_MS = 60_000;

export const ErrorRow: FC<ErrorRowProps> = ({ message, onDismiss, showAt }) => {
  useEffect(() => {
    const elapsed = Date.now() - showAt;
    const remaining = Math.max(0, AUTO_DISMISS_MS - elapsed);
    const t = setTimeout(onDismiss, remaining);
    return () => clearTimeout(t);
  }, [showAt, onDismiss]);

  return (
    <div className={styles['error-row']} role="alert">
      <span className={styles['error-row__icon']} aria-hidden="true">⚠</span>
      <span className={styles['error-row__body']}>{message}</span>
      <button
        type="button"
        className={styles['error-row__dismiss']}
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
};
