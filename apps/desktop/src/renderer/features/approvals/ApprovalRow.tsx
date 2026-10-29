import { Minus } from 'lucide-react';
import { useMemo, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { makerChatStore } from '@/lib/makerChatStore';

import { ApprovalTile, KIND_ICONS } from './ApprovalTile';
import { formatSeenAge, requestKind, SEEN_KEYS } from './approvalFormat';
import type { QueueEntry } from './queueModel';
import { neutralReceiptSource, OUTCOME_TEXT_KEYS, type ApprovalReceiptSource } from './approvalReceipts';
import './approvals.css';
import { useNow } from './useNow';
import { useWorkerIdentity } from './useWorkerIdentity';

const FOCUS_RING =
  'group-focus-visible:outline group-focus-visible:outline-2 group-focus-visible:-outline-offset-2 group-focus-visible:outline-[color:var(--focus-ring)]';

/** Light snapshot of one session's pending permission, only if it is still the request this row shows. */
export function usePermissionFor(entry: Pick<QueueEntry, 'sessionId' | 'requestId'>) {
  const subscribe = useMemo(
    () => (listener: () => void) => makerChatStore.subscribeLight(entry.sessionId, listener),
    [entry.sessionId],
  );
  const getSnapshot = () => makerChatStore.getLightSnapshot(entry.sessionId);
  const light = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const permission = light?.pendingPermission;
  return permission && permission.requestId === entry.requestId ? permission : null;
}

/**
 * One queue row. It is a summary only: who, which project, what class of request and when this
 * window first saw it. It never shows the command and never contains a decision control.
 */
export function ApprovalRow({ entry, selected, tabbable, identityVersion, receipts = neutralReceiptSource, setRef, onFocus, onSelect }: {
  entry: QueueEntry;
  selected: boolean;
  tabbable: boolean;
  identityVersion: number;
  receipts?: ApprovalReceiptSource;
  setRef: (element: HTMLLIElement | null) => void;
  onFocus: () => void;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  const identity = useWorkerIdentity(entry.sessionId, identityVersion);
  const permission = usePermissionFor(entry);
  const now = useNow();
  const pending = entry.phase === 'pending';
  const separator = t('approvalsInbox.labelSeparator');

  if (!pending) {
    const text = t(OUTCOME_TEXT_KEYS[receipts.outcomeFor(entry.sessionId, entry.requestId)]);
    return (
      <li
        ref={setRef}
        role="option"
        aria-disabled="true"
        aria-label={[identity.name, text].filter(Boolean).join(separator)}
        data-key={entry.key}
        data-state={entry.phase}
        className="approval-row select-none outline-none"
      >
        <div className="approval-row-inner">
          <div className="mb-1 flex cursor-default items-center gap-3 rounded-xl border border-transparent px-3 py-2.5">
            <ApprovalTile role={identity.role} muted />
            <div className="min-w-0 flex-1">
              <div className="truncate text-13 font-medium text-[var(--text-secondary)]" title={identity.name}>{identity.name}</div>
              <div className="mt-0.5 flex items-center gap-1.5 text-12 text-[var(--text-secondary)]">
                {/* Neutral glyph: a check mark would read as "approved", which the renderer cannot know. */}
                <Minus size={13} strokeWidth={2} aria-hidden="true" className="shrink-0" />
                {text}
              </div>
            </div>
          </div>
        </div>
      </li>
    );
  }

  const kind = permission ? requestKind(permission.toolName, permission.input) : 'other';
  const KindIcon = KIND_ICONS[kind];
  const kindLabel = t(`approvalsInbox.kind.${kind}`);
  const seen = formatSeenAge(now - entry.firstSeenAt);
  const seenText = t(SEEN_KEYS[seen.unit], { count: seen.count });
  const status = permission?.submitting
    ? t('approvalsInbox.status.sending')
    : permission?.submissionFailed ? t('approvalsInbox.status.failed') : null;
  const label = [identity.name, kindLabel, identity.projectName, seenText, status].filter(Boolean).join(separator);

  return (
    <li
      ref={setRef}
      role="option"
      aria-label={label}
      aria-selected={selected}
      tabIndex={tabbable ? 0 : -1}
      data-key={entry.key}
      data-state="pending"
      onFocus={onFocus}
      onClick={onSelect}
      className="approval-row group cursor-pointer select-none outline-none"
    >
      <div className="approval-row-inner">
        <div
          className={cn(
            'mb-1 flex items-center gap-3 rounded-xl border px-3 py-2.5 transition-colors',
            selected ? 'border-[var(--border-default)] bg-[var(--surface-elevated)]' : 'border-transparent group-hover:bg-[var(--surface-hover)]',
            FOCUS_RING,
          )}
        >
          <ApprovalTile role={identity.role} inverse={selected} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="min-w-0 flex-1 truncate text-13 font-medium text-[var(--text-primary)]" title={identity.name}>
                {identity.name || ' '}
              </span>
              {status && (
                <span className={cn('shrink-0 text-12', permission?.submissionFailed ? 'text-[var(--text-danger)]' : 'text-[var(--text-secondary)]')}>
                  {status}
                </span>
              )}
              <span className="approval-tnum shrink-0 text-12 text-[var(--text-secondary)]" title={t('approvalsInbox.seenHint')}>
                {seenText}
              </span>
            </div>
            <div className="mt-0.5 flex items-center gap-2 text-12 text-[var(--text-secondary)]">
              <span className="min-w-0 flex-1 truncate" title={identity.projectPath ?? identity.projectName ?? undefined}>
                {identity.projectName}
              </span>
              <span className="flex shrink-0 items-center gap-1.5">
                <KindIcon size={13} strokeWidth={1.75} aria-hidden />
                {kindLabel}
              </span>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}
