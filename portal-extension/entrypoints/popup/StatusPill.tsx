/**
 * StatusPill — renders the status dot + text shown at the top of the popup.
 * Each state maps to a dot color and a pill text. Wrapped in role="status" +
 * aria-live="polite" so screen readers announce state changes.
 */
import type { FC } from 'react';
import styles from './popup.module.css';

export type StatusKind =
  | 'connected'
  | 'connecting'
  | 'disconnected'
  | 'disconnected-unpaired'
  | 'token-mismatch';

interface StatusPillProps {
  state: StatusKind;
  /** Tab URL — only used when state === 'connected'; truncates with ellipsis on overflow. */
  url?: string;
}

/** Status pill copy per state. */
const COPY: Record<StatusKind, string> = {
  // followed by URL span when state === 'connected'
  'connected': 'Connected:',
  'connecting': 'Connecting...',
  'disconnected': 'Disconnected',
  'disconnected-unpaired': 'Disconnected — not paired',
  'token-mismatch': 'Token mismatch',
};

/** Dot color per state. */
const DOT_CLASS: Record<StatusKind, string> = {
  'connected': styles['dot--success'] ?? '',
  'connecting': styles['dot--warn'] ?? '',
  'disconnected': styles['dot--muted'] ?? '',
  'disconnected-unpaired': styles['dot--muted'] ?? '',
  'token-mismatch': styles['dot--error'] ?? '',
};

export const StatusPill: FC<StatusPillProps> = ({ state, url }) => {
  const isMuted = state === 'disconnected' || state === 'disconnected-unpaired';
  const textClass = `${styles['pill-text']} ${isMuted ? styles['pill-text--muted'] : ''}`.trim();
  return (
    <div className={styles.pill} role="status" aria-live="polite">
      <span className={`${styles.dot} ${DOT_CLASS[state]}`} aria-hidden="true" />
      <span className={textClass}>
        {COPY[state]}
        {state === 'connected' && url && (
          <>
            {' '}
            <span className={styles['pill-url']} title={url}>{url}</span>
          </>
        )}
      </span>
    </div>
  );
};
