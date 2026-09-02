/**
 * TokenInput — paste-the-pairing-token field used in the pre-pair layout.
 *
 * Primary flow: the user asks Claude for their pairing token (the MCP server
 * surfaces the 64-hex token in its instructions and not-connected tool
 * responses) and pastes it here. The legacy 6-digit OOB code from
 * `install` / `rotate-token` is still accepted for back-compat.
 *
 * Validation runs on blur (avoids flashing red mid-paste). The `Save & Connect`
 * button stays disabled until the trimmed value matches the validator regex.
 */
import { useState } from 'react';
import styles from './popup.module.css';

interface TokenInputProps {
  /** Parent saves the trimmed token to chrome.storage.local + sends popup:connect. */
  onSave: (token: string) => void;
  /** When true, input is disabled and button shows `Connecting...`. */
  saving?: boolean;
}

// Accepts EITHER the 64-hex pairing token (the simple "ask Claude for your token"
// flow — the MCP server surfaces it in its instructions / not-connected responses)
// OR a 6-digit code (the legacy interactive `install` / `rotate-token` OOB flow).
// The SW (ws-client.ts) branches the handshake on shape: 6 digits → pair.<code>,
// 64 hex → tok.<token>.
const VALIDATOR = /^(\d{6}|[a-f0-9]{64})$/i;

const PLACEHOLDER = 'Paste your pairing token';
const ARIA_LABEL = 'Pairing token';
const HELPER_TEXT = 'Ask Claude "what is my Darwinium pairing token?" and paste it here.';
const ERROR_TEXT = 'Enter the 64-character token (or a 6-digit pairing code).';

export function TokenInput({ onSave, saving }: TokenInputProps) {
  const [value, setValue] = useState('');
  const [touched, setTouched] = useState(false);
  const trimmed = value.trim();
  const isValid = VALIDATOR.test(trimmed);
  const showInvalid = touched && !isValid && trimmed.length > 0;

  return (
    <>
      <input
        type="text"
        className={`${styles.input} ${showInvalid ? styles['input--invalid'] : ''}`.trim()}
        placeholder={PLACEHOLDER}
        aria-label={ARIA_LABEL}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={() => setTouched(true)}
        disabled={saving}
        autoFocus
      />
      {showInvalid && (
        <span className={`${styles.helper} ${styles['helper--error']}`.trim()}>
          {ERROR_TEXT}
        </span>
      )}
      <span className={styles.helper}>{HELPER_TEXT}</span>
      <button
        type="button"
        className={`${styles.btn} ${styles['btn--primary']} ${styles['btn--full']}`}
        onClick={() => onSave(trimmed)}
        disabled={!isValid || saving}
      >
        {saving ? 'Connecting...' : 'Save & Connect'}
      </button>
    </>
  );
}
