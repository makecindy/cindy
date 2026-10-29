import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { ApprovalRow } from './ApprovalRow';
import type { QueueEntry } from './queueModel';

export interface FocusRequest { key: string; id: number }

/**
 * The queue is a listbox with a roving tabindex. Arrow keys / Home / End move focus only; Enter and
 * Space select. Selecting never decides anything: the decision controls live in the inspector.
 * While the pointer or focus is inside, vanished-request placeholders are held (`onHoldChange`), so
 * rows never collapse under the cursor.
 */
export function ApprovalQueue({ entries, selectedKey, identityVersion, focusRequest, onSelect, onHoldChange }: {
  entries: QueueEntry[];
  selectedKey: string | null;
  identityVersion: number;
  focusRequest: FocusRequest | null;
  onSelect: (key: string) => void;
  onHoldChange: (held: boolean) => void;
}) {
  const { t } = useTranslation();
  const rows = useRef(new Map<string, HTMLLIElement>());
  const hold = useRef({ pointer: false, focus: false });
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const pendingKeys = entries.filter((entry) => entry.phase === 'pending').map((entry) => entry.key);
  const tabbableKey = focusKey && pendingKeys.includes(focusKey) ? focusKey : pendingKeys[0] ?? null;

  const syncHold = () => onHoldChange(hold.current.pointer || hold.current.focus);
  const moveFocus = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    rows.current.get(key)?.focus();
  };

  useEffect(() => {
    if (!focusRequest) return;
    moveFocus(focusRequest.key);
    // Only a new request moves focus.
  }, [focusRequest?.id]);

  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    const key = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]')?.dataset.key;
    if (!key || !pendingKeys.includes(key)) return;
    const at = pendingKeys.indexOf(key);
    if (event.key === 'ArrowDown') moveFocus(pendingKeys[Math.min(at + 1, pendingKeys.length - 1)]);
    else if (event.key === 'ArrowUp') moveFocus(pendingKeys[Math.max(at - 1, 0)]);
    else if (event.key === 'Home') moveFocus(pendingKeys[0]);
    else if (event.key === 'End') moveFocus(pendingKeys[pendingKeys.length - 1]);
    else if (event.key === 'Enter' || event.key === ' ') onSelect(key);
    else return;
    event.preventDefault();
  };

  return (
    <div
      data-testid="approval-queue"
      className="flex h-full min-h-0 flex-col rounded-xl border border-[var(--border-default)]"
      onPointerEnter={() => { hold.current.pointer = true; syncHold(); }}
      onPointerLeave={() => { hold.current.pointer = false; syncHold(); }}
      onFocus={() => { hold.current.focus = true; syncHold(); }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) { hold.current.focus = false; syncHold(); }
      }}
    >
      <h2 className="px-5 pb-1 pt-4 text-12 font-medium text-[var(--text-secondary)]">{t('approvalsInbox.queueTitle')}</h2>
      <ul
        role="listbox"
        aria-label={t('approvalsInbox.queueTitle')}
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {entries.map((entry) => (
          <ApprovalRow
            key={entry.key}
            entry={entry}
            selected={selectedKey === entry.key}
            tabbable={tabbableKey === entry.key}
            identityVersion={identityVersion}
            setRef={(element) => { if (element) rows.current.set(entry.key, element); else rows.current.delete(entry.key); }}
            onFocus={() => setFocusKey(entry.key)}
            onSelect={() => onSelect(entry.key)}
          />
        ))}
      </ul>
    </div>
  );
}
