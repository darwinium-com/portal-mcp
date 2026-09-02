/**
 * ToolHistoryPanel — debug view of MCP tool calls observed in the current
 * browser session.
 *
 * Reads chrome.storage.session.toolCallHistory (written by
 * src/background/tool-call-history.ts) on mount and listens for
 * chrome.storage.onChanged for live updates. Newest entries first.
 *
 * Click a row to expand and see the full args / result preview / error.
 *
 * "Clear" button posts {type:'popup:clearHistory'} to the SW; the SW resets
 * its in-memory mirror and removes the storage key, which fires onChanged
 * and collapses our list to empty.
 */
import { useEffect, useState, useCallback } from 'react';
import type { ToolCallEntry } from '../../src/shared/messages';
import styles from './popup.module.css';

const STORAGE_KEY = 'toolCallHistory';

function formatTime(ts: number): string {
  const d = new Date(ts);
  // HH:MM:SS — sufficient for in-session debugging.
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function statusGlyph(status: ToolCallEntry['status']): string {
  if (status === 'success') return '✓';
  if (status === 'error') return '✖';
  return '…';
}

function statusClass(status: ToolCallEntry['status']): string {
  if (status === 'success') return styles['history-row__status--success'] ?? '';
  if (status === 'error') return styles['history-row__status--error'] ?? '';
  return styles['history-row__status--pending'] ?? '';
}

export function ToolHistoryPanel() {
  const [entries, setEntries] = useState<ToolCallEntry[]>([]);
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void chrome.storage.session.get(STORAGE_KEY).then((stored) => {
      if (cancelled) return;
      const value = stored[STORAGE_KEY];
      if (Array.isArray(value)) setEntries(value as ToolCallEntry[]);
    });
    const onChange = (
      changes: { [k: string]: chrome.storage.StorageChange },
      area: chrome.storage.AreaName,
    ) => {
      if (area !== 'session' || !(STORAGE_KEY in changes)) return;
      const newValue = changes[STORAGE_KEY]?.newValue;
      setEntries(Array.isArray(newValue) ? (newValue as ToolCallEntry[]) : []);
    };
    chrome.storage.onChanged.addListener(onChange);
    return () => {
      cancelled = true;
      chrome.storage.onChanged.removeListener(onChange);
    };
  }, []);

  const onClear = useCallback(async () => {
    // Optimistic local clear so the UI feels instant; the SW's clearHistory()
    // also wipes storage, which would have fired onChanged anyway.
    setEntries([]);
    setExpandedId(undefined);
    try {
      await chrome.runtime.sendMessage({ type: 'popup:clearHistory' });
    } catch {
      // SW asleep / no listener — storage write below will still drive the
      // empty state for the popup. The mirror will rehydrate on next SW spawn.
    }
  }, []);

  if (entries.length === 0) {
    return (
      <div className={styles['history-empty']}>
        <p className={styles.helper}>No tool calls yet this session.</p>
        <p className={styles.helper}>
          Calls from Claude / MCP will appear here as they happen, newest first.
        </p>
      </div>
    );
  }

  // Render newest-first.
  const ordered = [...entries].reverse();

  return (
    <div className={styles.history}>
      <ul className={styles['history-list']}>
        {ordered.map((entry) => {
          const expanded = expandedId === entry.id;
          return (
            <li key={entry.id} className={styles['history-item']}>
              <button
                type="button"
                className={styles['history-row']}
                onClick={() => setExpandedId(expanded ? undefined : entry.id)}
              >
                <span className={`${styles['history-row__status']} ${statusClass(entry.status)}`}>
                  {statusGlyph(entry.status)}
                </span>
                <span className={styles['history-row__name']} title={entry.name}>
                  {entry.name}
                  {!entry.isCommand && (
                    <span className={styles['history-row__tag']} title="Infrastructure op (not a runCommand)">
                      &nbsp;[op]
                    </span>
                  )}
                </span>
                <span className={styles['history-row__meta']}>
                  {entry.durationMs !== undefined ? `${entry.durationMs}ms` : '…'}
                </span>
                <span className={styles['history-row__time']}>{formatTime(entry.startedAt)}</span>
              </button>
              {expanded && (
                <div className={styles['history-detail']}>
                  {entry.argsPreview && (
                    <div>
                      <span className={styles['history-detail__label']}>args</span>
                      <pre className={styles['history-detail__pre']}>{entry.argsPreview}</pre>
                    </div>
                  )}
                  {entry.status === 'error' && entry.error && (
                    <div>
                      <span className={`${styles['history-detail__label']} ${styles['history-detail__label--error']}`}>error</span>
                      <pre className={styles['history-detail__pre']}>{entry.error}</pre>
                    </div>
                  )}
                  {entry.status === 'success' && entry.resultPreview && (
                    <div>
                      <span className={styles['history-detail__label']}>result</span>
                      <pre className={styles['history-detail__pre']}>{entry.resultPreview}</pre>
                    </div>
                  )}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className={`${styles.btn} ${styles['btn--secondary']} ${styles['btn--full']}`} onClick={onClear}>
        Clear history
      </button>
    </div>
  );
}
