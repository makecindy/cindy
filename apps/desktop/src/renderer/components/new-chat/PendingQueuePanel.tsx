/**
 * PendingQueuePanel
 * ---------------------------------------------------------------------------
 * Renders the not-yet-dispatched FIFO queue above ChatInput.
 *
 * Product contract:
 * - Rows are shown in actual send order: top row is the next message.
 * - Visible ordinals are intentionally omitted. FIFO order is obvious from
 *   placement; numbers made the queue read like a table instead of a compact
 *   draft list. ARIA labels still carry the row index for screen readers.
 * - Queues of four or fewer rows stay fully visible. Five or more collapse to
 *   the first three rows; "show more" only reveals the tail and never pauses
 *   dispatch.
 * - Stop owns the real paused state. A paused queue shows a Continue action and
 *   will not drain until the user resumes it.
 * - Paused queues still expose row-level 插话. After Stop there is no active
 *   turn to steer into, so the store treats it as "resume with this row next".
 * - Drag-sort installs a global store lock because every position is changing.
 *   Editing installs a clientId lock only for that row, so unrelated rows ahead
 *   of it can still drain. Viewing the queue is passive.
 */

import {
  AlarmClock,
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronUp,
  GripVertical,
  Pencil,
  Trash2,
  X,
} from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SortableList } from '@/components/sidebar/SortableList';
import { ListComposerTextarea } from './ListComposerTextarea';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { QueuedMessage } from '@/lib/makerChatStore';
import {
  activatePendingQueueRowFocus,
  activatePendingQueueRowHover,
  deactivatePendingQueueRowFocus,
  deactivatePendingQueueRowHover,
  emptyPendingQueueRowActivityState,
  isPendingQueueRowActive,
  prunePendingQueueRowActivity,
} from './pendingQueueRowActivity';
import {
  getPendingQueueRowPresentation,
  resolvePendingQueueEditSubmission,
} from './pendingQueueRowPresentation';
import {
  acquireQueueEditLock,
  acquireQueueInteractionLock,
  releaseQueueEditLock,
  releaseQueueInteractionLock,
  type QueueEditLockOwner,
  type QueueInteractionLockOwner,
} from './pendingQueueLocks';

interface PendingQueuePanelProps {
  queue: QueuedMessage[];
  /** Visual tail expansion for queues beyond the compact threshold. Does not pause drain. */
  expanded: boolean;
  onToggle: () => void;
  onRemove: (clientId: string) => void;
  onEdit?: (clientId: string, newText: string) => void;
  onSteer?: (clientId: string) => Promise<boolean>;
  steeringClientIds?: string[];
  /** True after Stop pauses queued messages. */
  paused?: boolean;
  /**
   * True while an agent turn is running and row steer injects into it.
   * Drives the ⬆️ tooltip's 插话/继续 wording, shared with the composer
   * Cmd/Ctrl+Enter path (both read showStopButton).
   * Orthogonal to `paused` (Stop-paused queue): store invariants keep the two
   * from being true at once, so `paused` stays scoped to the footer Continue.
   */
  turnRunning?: boolean;
  /** Resume a paused queue and let the store drain the current head. */
  onResume?: () => void;
  /** Move a row to an insertion index in the full FIFO queue. */
  onReorder?: (clientId: string, targetIndex: number) => void;
  /** Lock auto-drain globally while drag-sort is in progress. */
  onInteractionLock?: (lockId: string, locked: boolean) => void;
  /** Lock one queued row while its text is being edited. */
  onEditLock?: (clientId: string, locked: boolean) => void;
  ariaLabel?: string;
  mergedWithBelow?: boolean;
  steerShortcutLabel?: string;
}

const COLLAPSED_VISIBLE_ROWS = 3;
const COLLAPSE_THRESHOLD_ROWS = 4;
const QUEUE_INTERACTION_LOCK_ID = 'pending-queue-panel';

function getQueuedMessageId(entry: QueuedMessage): string {
  return entry.clientId;
}

function equalIds(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((id, idx) => id === right[idx]);
}

function resolveSingleMove(oldIds: string[], nextIds: string[]): { clientId: string; targetIndex: number } | null {
  if (oldIds.length !== nextIds.length || equalIds(oldIds, nextIds)) return null;

  for (let oldIndex = 0; oldIndex < oldIds.length; oldIndex += 1) {
    const withoutMoved = [...oldIds];
    const [clientId] = withoutMoved.splice(oldIndex, 1);
    if (!clientId) continue;

    for (let newIndex = 0; newIndex <= withoutMoved.length; newIndex += 1) {
      const candidate = [...withoutMoved];
      candidate.splice(newIndex, 0, clientId);
      if (!equalIds(candidate, nextIds)) continue;

      // makerChatStore.moveQueueItem takes the insertion index in the original
      // queue before removal. SortableJS gives the final index after removal.
      return { clientId, targetIndex: oldIndex < newIndex ? newIndex + 1 : newIndex };
    }
  }

  return null;
}

function isPendingQueueSteerShortcut(event: ReactKeyboardEvent): boolean {
  return (
    event.key === 'Enter' &&
    (event.metaKey || event.ctrlKey) &&
    !event.shiftKey &&
    !event.altKey &&
    !event.nativeEvent.repeat &&
    !event.nativeEvent.isComposing
  );
}

export function PendingQueuePanel({
  queue,
  expanded,
  onToggle,
  onRemove,
  onEdit,
  onSteer,
  steeringClientIds = [],
  paused = false,
  onResume,
  onReorder,
  onInteractionLock,
  onEditLock,
  ariaLabel,
  mergedWithBelow = false,
  steerShortcutLabel,
  turnRunning = false,
}: PendingQueuePanelProps): ReactElement | null {
  const { t } = useTranslation();
  const resolvedAriaLabel = ariaLabel ?? t('newChat.pendingQueue.regionAria');
  const [rowActivity, setRowActivity] = useState(emptyPendingQueueRowActivityState);
  const [editingClientId, setEditingClientId] = useState<string | null>(null);
  const [editingDraft, setEditingDraft] = useState<string>('');
  const editingTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editingLockOwnerRef = useRef<QueueEditLockOwner | null>(null);
  const onEditLockRef = useRef(onEditLock);
  const interactionLockedRef = useRef(false);
  const interactionLockOwnerRef = useRef<QueueInteractionLockOwner | null>(null);
  const onInteractionLockRef = useRef(onInteractionLock);

  const visibleQueue = useMemo(
    () => (expanded || queue.length <= COLLAPSE_THRESHOLD_ROWS ? queue : queue.slice(0, COLLAPSED_VISIBLE_ROWS)),
    [expanded, queue],
  );
  const hiddenCount = Math.max(0, queue.length - visibleQueue.length);
  const hasCollapsibleTail = queue.length > COLLAPSE_THRESHOLD_ROWS;
  const showFooter = hasCollapsibleTail || paused;

  useEffect(() => {
    onEditLockRef.current = onEditLock;
  }, [onEditLock]);

  useEffect(() => {
    onInteractionLockRef.current = onInteractionLock;
  }, [onInteractionLock]);

  const setInteractionLocked = useCallback((locked: boolean) => {
    if (interactionLockedRef.current === locked) return;
    interactionLockedRef.current = locked;
    interactionLockOwnerRef.current = locked
      ? acquireQueueInteractionLock(QUEUE_INTERACTION_LOCK_ID, onInteractionLockRef.current)
      : releaseQueueInteractionLock(interactionLockOwnerRef.current);
  }, []);

  const handleDragActiveChange = useCallback(
    (active: boolean) => {
      // Sortable fires this synchronously at drag start/end. Installing the
      // store lock here closes the same race we already fixed for edit mode:
      // a turn `done` event must not drain the queue before React commits the
      // local drag state update.
      setInteractionLocked(active);
    },
    [setInteractionLocked],
  );

  useEffect(() => () => setInteractionLocked(false), [setInteractionLocked]);

  const acquireEditLock = useCallback((clientId: string) => {
    editingLockOwnerRef.current = acquireQueueEditLock(
      editingLockOwnerRef.current,
      clientId,
      onEditLockRef.current,
    );
  }, []);

  const releaseEditLock = useCallback((clientId?: string | null) => {
    editingLockOwnerRef.current = releaseQueueEditLock(editingLockOwnerRef.current, clientId);
  }, []);

  useEffect(() => () => releaseEditLock(), [releaseEditLock]);

  useEffect(() => {
    if (editingClientId !== null && !queue.some((q) => q.clientId === editingClientId)) {
      releaseEditLock(editingClientId);
      setEditingClientId(null);
      setEditingDraft('');
    }
    setRowActivity((activity) =>
      prunePendingQueueRowActivity(activity, queue.map(getQueuedMessageId)),
    );
  }, [editingClientId, queue, releaseEditLock]);

  useEffect(() => {
    if (editingClientId === null) return;
    const ta = editingTextareaRef.current;
    if (!ta) return;
    ta.focus();
    ta.select();
  }, [editingClientId]);

  const beginEdit = useCallback(
    (clientId: string, currentText: string) => {
      if (!onEdit) return;
      if (steeringClientIds.includes(clientId)) return;
      acquireEditLock(clientId);
      setEditingClientId(clientId);
      setEditingDraft(currentText);
    },
    [acquireEditLock, onEdit, steeringClientIds],
  );

  const cancelEdit = useCallback(() => {
    releaseEditLock(editingClientId);
    setEditingClientId(null);
    setEditingDraft('');
  }, [editingClientId, releaseEditLock]);

  const commitEdit = useCallback(() => {
    if (editingClientId === null) return;
    const trimmed = editingDraft.trim();
    if (trimmed.length > 0) {
      const entry = queue.find((item) => item.clientId === editingClientId);
      const submission = entry
        ? resolvePendingQueueEditSubmission(entry, editingDraft)
        : null;
      if (submission !== null) onEdit?.(editingClientId, submission);
    }
    releaseEditLock(editingClientId);
    setEditingClientId(null);
    setEditingDraft('');
  }, [editingClientId, editingDraft, onEdit, queue, releaseEditLock]);

  const handleSortableReorder = useCallback(
    (nextVisibleIds: string[]) => {
      if (!onReorder) return;
      const currentVisibleIds = visibleQueue.map(getQueuedMessageId);
      const move = resolveSingleMove(currentVisibleIds, nextVisibleIds);
      if (!move) return;
      onReorder(move.clientId, move.targetIndex);
    },
    [onReorder, visibleQueue],
  );

  if (queue.length === 0) return null;

  return (
    <div
      role="region"
      aria-label={resolvedAriaLabel}
      className={cn(
        'w-full overflow-hidden',
        mergedWithBelow
          ? 'border-b border-[var(--chat-input-border)]'
          : 'rounded-[12px] border border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
      )}
    >
      <SortableList
        items={visibleQueue}
        getId={getQueuedMessageId}
        onReorder={handleSortableReorder}
        disabled={!onReorder}
        handle=".pending-queue-drag-handle"
        // SortableList's default filter excludes all <button> starts. The
        // queue drag handle is intentionally a real button for keyboard
        // reordering, so this list has to exempt that one button from the
        // filter or pointer drag can never enter Sortable's lifecycle.
        filter="button:not(.pending-queue-drag-handle), input, textarea, select, a, [data-no-drag]"
        onDragActiveChange={handleDragActiveChange}
        role="list"
        ariaLabel={t('newChat.pendingQueue.listAria')}
        rowClassName="pending-queue-sortable-row"
        className="pending-queue-scroll flex max-h-[196px] flex-col gap-0 overflow-y-auto overscroll-contain px-1 pb-0.5 pt-1.5 [scrollbar-gutter:stable_both-edges]"
        renderItem={(entry, originalIdx) => {
          const rowPresentation = getPendingQueueRowPresentation(entry);
          const isRowActive = isPendingQueueRowActive(rowActivity, entry.clientId);
          const isRowEditing = entry.clientId === editingClientId;
          const isSteering = steeringClientIds.includes(entry.clientId);
          const showActions = isRowActive || isSteering || isRowEditing;
          const canSteerRow = Boolean(onSteer) && rowPresentation.canSteer;
          const canEditRow = Boolean(onEdit) && rowPresentation.canEdit;
          const actionSlotWidth = canSteerRow
            ? (canEditRow ? 'w-[68px]' : 'w-[44px]')
            : (canEditRow ? 'w-[44px]' : 'w-5');
          const dragDisabled = !onReorder || isRowEditing || isSteering;
          const steerTipText = (() => {
            if (isSteering) return t('newChat.pendingQueue.steeringAction');
            const base = t(turnRunning ? 'newChat.pendingQueue.steerRunningTip' : 'newChat.pendingQueue.steerPausedTip');
            return steerShortcutLabel ? `${base} · ${steerShortcutLabel}` : base;
          })();
          const handleRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (!isPendingQueueSteerShortcut(e)) return;
            if (!canSteerRow || !onSteer || isSteering || isRowEditing) return;
            e.preventDefault();
            e.stopPropagation();
            void onSteer(entry.clientId);
          };
          const handleEditKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.stopPropagation();
              commitEdit();
              return;
            }
            if (e.key === 'Escape') {
              e.preventDefault();
              e.stopPropagation();
              cancelEdit();
            }
          };
          const handleDragHandleKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
            if (isPendingQueueSteerShortcut(e)) return;
            if (dragDisabled || !onReorder) return;
            const fullIndex = queue.findIndex((item) => item.clientId === entry.clientId);
            if (fullIndex < 0) return;

            let targetIndex: number | null = null;
            switch (e.key) {
              case 'ArrowUp':
                if (fullIndex > 0) targetIndex = fullIndex - 1;
                break;
              case 'ArrowDown':
                if (fullIndex < queue.length - 1) targetIndex = fullIndex + 2;
                break;
              case 'Home':
                if (fullIndex > 0) targetIndex = 0;
                break;
              case 'End':
                if (fullIndex < queue.length - 1) targetIndex = queue.length;
                break;
              case 'Enter':
              case ' ':
                e.preventDefault();
                e.stopPropagation();
                setRowActivity((activity) =>
                  activatePendingQueueRowFocus(activity, entry.clientId),
                );
                return;
              default:
                return;
            }

            if (targetIndex === null) return;
            e.preventDefault();
            e.stopPropagation();
            setRowActivity((activity) => activatePendingQueueRowFocus(activity, entry.clientId));
            onReorder(entry.clientId, targetIndex);
          };

          return (
            <div
              role="listitem"
              tabIndex={canSteerRow ? 0 : undefined}
              aria-keyshortcuts={canSteerRow ? 'Meta+Enter Control+Enter' : undefined}
              onKeyDown={handleRowKeyDown}
              onMouseEnter={() => {
                setRowActivity((activity) =>
                  activatePendingQueueRowHover(activity, entry.clientId, editingClientId),
                );
              }}
              onMouseLeave={() => {
                setRowActivity((activity) =>
                  deactivatePendingQueueRowHover(activity, entry.clientId),
                );
              }}
              onFocusCapture={() => {
                setRowActivity((activity) =>
                  activatePendingQueueRowFocus(activity, entry.clientId),
                );
              }}
              onBlurCapture={(event) => {
                const nextFocusTarget = event.relatedTarget;
                if (
                  nextFocusTarget instanceof Node &&
                  event.currentTarget.contains(nextFocusTarget)
                )
                  return;
                setRowActivity((activity) =>
                  deactivatePendingQueueRowFocus(activity, entry.clientId),
                );
              }}
              aria-selected={isRowActive}
              className={cn(
                'group flex gap-1.5 rounded-[8px] border border-transparent px-2 py-0.5',
                // 单行展示态整行垂直居中, 让 drag handle / 文字 / actions 光学对齐;
                // 编辑态 textarea 可能多行, 保持顶对齐让 handle / actions 留在首行。
                isRowEditing ? 'items-start' : 'items-center',
                (isRowActive || isRowEditing) && 'bg-[var(--chat-input-chip-bg)]',
              )}
            >
              <button
                type="button"
                disabled={dragDisabled}
                onKeyDown={handleDragHandleKeyDown}
                aria-label={t('newChat.pendingQueue.dragAria', { index: originalIdx + 1 })}
                aria-keyshortcuts="ArrowUp ArrowDown Home End"
                className={cn(
                  'pending-queue-drag-handle flex h-5 w-5 shrink-0 touch-none select-none items-center justify-center rounded-[6px]',
                  'appearance-none border-0 bg-transparent p-0',
                  'text-[var(--cmd-palette-item-meta)] opacity-0 transition-opacity',
                  !dragDisabled && 'cursor-grab group-hover:opacity-100 focus:opacity-100 active:cursor-grabbing',
                  dragDisabled && 'cursor-default',
                )}
              >
                <GripVertical size={12} strokeWidth={2} aria-hidden />
              </button>
              {isRowEditing ? (
                <ListComposerTextarea
                  ref={editingTextareaRef}
                  value={editingDraft}
                  onChange={(e) => setEditingDraft(e.target.value)}
                  onKeyDown={handleEditKeyDown}
                  onBlur={commitEdit}
                  rows={1}
                  aria-label={t('newChat.pendingQueue.editAria', { index: originalIdx + 1 })}
                  className={cn(
                    'min-h-[18px] min-w-0 flex-1 resize-none rounded-[6px] bg-transparent text-[13px] leading-[1.25]',
                    'max-h-[120px] overflow-y-auto text-[var(--msg-assistant-text)] outline-none',
                    '[field-sizing:content]',
                  )}
                />
              ) : rowPresentation.isOrca || rowPresentation.isScheduler ? (
                <div
                  aria-label={t(
                    rowPresentation.isScheduler
                      ? 'newChat.pendingQueue.schedulerRowAria'
                      : 'newChat.pendingQueue.orcaRowAria',
                    { sender: rowPresentation.senderLabel },
                  )}
                  className="relative top-px flex min-w-0 flex-1 items-center gap-1.5"
                >
                  {rowPresentation.isScheduler ? (
                    <AlarmClock
                      size={13}
                      strokeWidth={2}
                      aria-hidden
                      className="shrink-0 text-[var(--msg-assistant-text)]"
                    />
                  ) : (
                    <Bot
                      size={13}
                      strokeWidth={2}
                      aria-hidden
                      className="shrink-0 text-[var(--msg-assistant-text)]"
                    />
                  )}
                  <span className="min-w-0 max-w-[120px] shrink truncate text-[13px] font-semibold leading-[1.25] text-[var(--msg-assistant-text)]">
                    {rowPresentation.senderLabel}
                  </span>
                  <span
                    className={cn(
                      'min-w-0 flex-1 truncate text-[13px] leading-[1.25]',
                      isRowActive
                        ? 'text-[var(--msg-assistant-text)]'
                        : 'text-[var(--settings-section-desc)]',
                    )}
                  >
                    {rowPresentation.isSyntheticTrigger
                      ? t(rowPresentation.syntheticKind === 'continue'
                          ? 'newChat.pendingQueue.syntheticContinueLabel'
                          : 'newChat.pendingQueue.syntheticTriggerLabel')
                      : (rowPresentation.displayText || t('newChat.pendingQueue.noTextContent'))}
                  </span>
                </div>
              ) : (
                <p
                  className={cn(
                    // top-px: 在居中基础上把文字再压低 1px, 抵消字体 metrics, 与 drag handle 光学对齐
                    'relative top-px min-w-0 flex-1 truncate text-[13px] leading-[1.25]',
                    isRowActive
                      ? 'text-[var(--msg-assistant-text)]'
                      : 'text-[var(--settings-section-desc)]',
                  )}
                >
                  {rowPresentation.isSyntheticTrigger
                      ? t(rowPresentation.syntheticKind === 'continue'
                          ? 'newChat.pendingQueue.syntheticContinueLabel'
                          : 'newChat.pendingQueue.syntheticTriggerLabel')
                      : (rowPresentation.displayText || t('newChat.pendingQueue.noTextContent'))}
                </p>
              )}

              {isRowEditing ? (
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={cancelEdit}
                    aria-label={t('newChat.pendingQueue.editCancelAria')}
                    className={iconButtonClassName}
                  >
                    <X size={12} strokeWidth={2.25} aria-hidden />
                  </button>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={commitEdit}
                    disabled={editingDraft.trim().length === 0}
                    aria-label={t('newChat.pendingQueue.editSaveAria')}
                    className={cn(iconButtonClassName, 'disabled:opacity-40')}
                  >
                    <Check size={12} strokeWidth={2.25} aria-hidden />
                  </button>
                </div>
              ) : showActions ? (
                <div className={cn('flex shrink-0 items-center justify-end gap-1', actionSlotWidth)}>
                  {canSteerRow && onSteer && (
                    <Tip
                      text={steerTipText}
                      side="top"
                    >
                      <button
                        type="button"
                        onClick={() => {
                          void onSteer(entry.clientId);
                        }}
                        disabled={isSteering}
                        aria-label={t(
                          isSteering
                            ? 'newChat.pendingQueue.steeringAria'
                            : 'newChat.pendingQueue.steerAria',
                          { index: originalIdx + 1 },
                        )}
                        className={cn(iconButtonClassName, 'disabled:cursor-wait disabled:opacity-70')}
                      >
                        {isSteering ? (
                          <Spinner size={12} strokeWidth={2.25} />
                        ) : (
                          <ArrowUp size={12} strokeWidth={2.25} aria-hidden />
                        )}
                      </button>
                    </Tip>
                  )}
                  {canEditRow && !isSteering && (
                    <Tip text={t('newChat.pendingQueue.editAction')} side="top">
                      <button
                        type="button"
                        onClick={() => beginEdit(entry.clientId, rowPresentation.displayText)}
                        aria-label={t('newChat.pendingQueue.editAria', { index: originalIdx + 1 })}
                        className={iconButtonClassName}
                      >
                        <Pencil size={11} strokeWidth={2.25} aria-hidden />
                      </button>
                    </Tip>
                  )}
                  {!isSteering && (
                    <Tip text={t('newChat.pendingQueue.removeAction')} side="top">
                      <button
                        type="button"
                        onClick={() => onRemove(entry.clientId)}
                        aria-label={t('newChat.pendingQueue.removeAria', { index: originalIdx + 1 })}
                        className={iconButtonClassName}
                      >
                        <Trash2 size={11} strokeWidth={2.25} aria-hidden />
                      </button>
                    </Tip>
                  )}
                </div>
              ) : (
                <span aria-hidden className={cn('h-5 shrink-0', actionSlotWidth)} />
              )}
            </div>
          );
        }}
      />

      {showFooter && (
        <div
          className={cn(
            'grid w-full select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t px-2 py-1.5 text-[12px] leading-none',
            'border-[var(--chat-input-border)]',
          )}
        >
          {paused && (
            <span className="min-w-0 truncate text-[var(--warning-fg)]">
              {t('newChat.pendingQueue.pausedFooter')}
            </span>
          )}
          {hasCollapsibleTail ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={expanded}
              className={cn(
                'col-start-2 flex h-5 items-center justify-center gap-1 rounded-full px-2',
                'text-[var(--cmd-palette-item-meta)] hover:bg-[var(--chat-input-chip-bg)] hover:text-[var(--msg-assistant-text)]',
              )}
            >
              {expanded
                ? t('newChat.pendingQueue.showLess')
                : t('newChat.pendingQueue.showMore', { count: hiddenCount })}
              {expanded ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />}
            </button>
          ) : (
            <span aria-hidden className="col-start-2 h-5" />
          )}
          <div className="col-start-3 flex min-w-0 justify-end">
            {paused && onResume && (
              <button
                type="button"
                onClick={onResume}
                aria-label={t('newChat.pendingQueue.resumeAria')}
                className={cn(
                  'flex h-5 min-w-[64px] items-center justify-center rounded-full border px-2',
                  'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
                  'text-[12px] leading-none text-[var(--msg-assistant-text)]',
                  'hover:bg-[var(--chat-input-chip-bg)]',
                )}
              >
                {t('newChat.pendingQueue.resumeAction')}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

const iconButtonClassName = cn(
  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
  'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
  'text-[var(--settings-section-desc)] hover:text-[var(--msg-assistant-text)]',
);
