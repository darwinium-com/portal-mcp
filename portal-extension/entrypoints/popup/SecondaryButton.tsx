/**
 * SecondaryButton — the non-accent, full-width CTA used for `Disconnect`
 * (connected layout) and `Connect` (disconnected-paired layout). Disconnect is
 * intentionally NOT styled destructive — disconnecting is reversible in one click.
 */
import type { FC, MouseEventHandler } from 'react';
import styles from './popup.module.css';

interface SecondaryButtonProps {
  label: string;
  onClick: MouseEventHandler<HTMLButtonElement>;
}

export const SecondaryButton: FC<SecondaryButtonProps> = ({ label, onClick }) => (
  <button
    type="button"
    className={`${styles.btn} ${styles['btn--secondary']} ${styles['btn--full']}`}
    onClick={onClick}
  >
    {label}
  </button>
);
