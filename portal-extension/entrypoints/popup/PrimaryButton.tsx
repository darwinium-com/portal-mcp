/**
 * PrimaryButton — the accent-colored, full-width CTA used for `Save & Connect`
 * (pre-pair) and `Re-pair` (token-mismatch). When `loading` is true, the label
 * is overridden to `Connecting...` and the button is disabled.
 */
import type { FC, MouseEventHandler } from 'react';
import styles from './popup.module.css';

interface PrimaryButtonProps {
  /** Button label — `Save & Connect`, `Re-pair`, etc. */
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
  disabled?: boolean;
  /** When true, shows `Connecting...` label and disables the button. */
  loading?: boolean;
}

export const PrimaryButton: FC<PrimaryButtonProps> = ({ label, onClick, disabled, loading }) => (
  <button
    type="button"
    className={`${styles.btn} ${styles['btn--primary']} ${styles['btn--full']}`}
    onClick={onClick}
    disabled={disabled || loading}
  >
    {loading ? 'Connecting...' : label}
  </button>
);
