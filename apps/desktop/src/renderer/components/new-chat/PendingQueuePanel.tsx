import { Button } from '@/components/ui/button';
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
  ChevronDown,
  ChevronUp,
  GripVertical,
  Pencil,
  Puzzle,
  Send,
  Trash2,
} from 'lucide-react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactElement } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { SortableList } from '@/components/sidebar/SortableList';
import { SentInlineAtomBody } from '@/components/chat/SentInlineAtomBody';
import { Spinner } from '@/components/ui/spinner';
import { Tip } from '@/components/ui/tooltip';
import { BotAvatar } from '@/features/bots/BotAvatar';
import { useBotProfiles } from '@/features/bots/botStore';
import { cn } from '@/lib/utils';
import type { QueuedMessage } from '@/lib/makerChatStore';
import { QueueSourceDeviceTag } from '@/components/chat/MessageSourceLabels';
import { messageSourceIdEntries } from '@cindy/maker-shared/message-source';
import {
  activatePendingQueueRowFocus,
  activatePendingQueueRowHover,
  deactivatePendingQueueRowFocus,
  deactivatePendingQueueRowHover,
  emptyPendingQueueRowActivityState,
  isPendingQueueBodyTipOpen,
  isPendingQueueRowActive,
  prunePendingQueueRowActivity,
} from './pendingQueueRowActivity';
import { getPendingQueueRowPresentation } from './pendingQueueRowPresentation';
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
  /** Queue row currently loaded into the shared composer. */
  editingClientId?: string | null;
  /** Load a queued message into the shared composer. */
  onEditBegin?: (entry: QueuedMessage) => void;
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

function resolveSingleMove(
  oldIds: string[],
  nextIds: string[],
): { clientId: string; targetIndex: number } | null {
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


/**
 * 排队来源行的悬停提示:与可见标签同一优先级的来源 ID(共享 messageSourceIdEntries:插件优先,
 * 伙伴给伙伴 ID + 任务 ID);脱敏来源没有 ID。
 */
function queueRowSourceIdTitle(
  entry: QueuedMessage,
  t: (key: string, opts?: Record<string, unknown>) => string,
): string | null {
  const lines = messageSourceIdEntries(entry).map(({ kind, id }) =>
    t(`chat.userMessage.sourceIds.${kind}`, { id }),
  );
  return lines.length > 0 ? lines.join('\n') : null;
}

export function PendingQueuePanel({
  queue,
  expanded,
  onToggle,
  onRemove,
  editingClientId = null,
  onEditBegin,
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
  const botProfiles = useBotProfiles();
  const resolvedAriaLabel = ariaLabel ?? t('newChat.pendingQueue.regionAria');
  const [rowActivity, setRowActivity] = useState(emptyPendingQueueRowActivityState);
  /**
   * 正文全文提示的目标行:指针 / 键盘焦点现量到这一行真的被单行截断时记成它的 clientId。
   * 只记「哪一行溢出」而不记「刚刚量到溢出」,上一次的结果才不会残留到另一行头上。
   */
  const [bodyTipClientId, setBodyTipClientId] = useState<string | null>(null);
  /** 已经等满悬停延迟、可以真正浮出的行:受控 Tip 不会自己走 Provider 的 delay。 */
  const [revealedBodyTipClientId, setRevealedBodyTipClientId] = useState<string | null>(null);
  /** 拖动排序进行中:Sortable 指针捕获期间不允许行级浮层留在屏幕上。 */
  const [dragActive, setDragActive] = useState(false);
  const editingLockOwnerRef = useRef<QueueEditLockOwner | null>(null);
  const onEditLockRef = useRef(onEditLock);
  const interactionLockedRef = useRef(false);
  const interactionLockOwnerRef = useRef<QueueInteractionLockOwner | null>(null);
  const onInteractionLockRef = useRef(onInteractionLock);

  const visibleQueue = useMemo(
    () =>
      expanded || queue.length <= COLLAPSE_THRESHOLD_ROWS
        ? queue
        : queue.slice(0, COLLAPSED_VISIBLE_ROWS),
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
      setDragActive(active);
      // 拖动全程压着一块气泡在行上,松手前不该再弹正文全文。
      if (active) setBodyTipClientId(null);
    },
    [setInteractionLocked],
  );

  useEffect(() => () => setInteractionLocked(false), [setInteractionLocked]);

  // Tip 的关闭请求(窗口失活、Radix 自己的 pointerleave / Esc)必须复位目标行,
  // 否则受控浮层关不掉:切到别的窗口时浮层就僵在屏幕上。
  const dismissBodyTip = useCallback(() => setBodyTipClientId(null), []);

  // 受控 Tip 绕过 Provider 的 delayDuration,指针只是划过一行截断正文就会铺开一大块
  // 全文。这里自己补上同一节奏的延迟:目标行停留满 delay 才允许浮出,关闭立即生效。
  useEffect(() => {
    if (bodyTipClientId === null) return undefined;
    const timer = window.setTimeout(
      () => setRevealedBodyTipClientId(bodyTipClientId),
      QUEUE_BODY_TIP_HOVER_DELAY_MS,
    );
    return () => {
      window.clearTimeout(timer);
      setRevealedBodyTipClientId((current) => (current === bodyTipClientId ? null : current));
    };
  }, [bodyTipClientId]);

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
    }
    setRowActivity((activity) =>
      prunePendingQueueRowActivity(activity, queue.map(getQueuedMessageId)),
    );
    setBodyTipClientId((current) =>
      current !== null && !queue.some((q) => q.clientId === current) ? null : current,
    );
  }, [editingClientId, queue, releaseEditLock]);

  useEffect(() => {
    if (editingClientId !== null) acquireEditLock(editingClientId);
    else releaseEditLock();
  }, [acquireEditLock, editingClientId, releaseEditLock]);

  const beginEdit = useCallback(
    (entry: QueuedMessage) => {
      if (!onEditBegin) return;
      if (steeringClientIds.includes(entry.clientId)) return;
      acquireEditLock(entry.clientId);
      onEditBegin(entry);
    },
    [acquireEditLock, onEditBegin, steeringClientIds],
  );

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
          const senderBotProfile = rowPresentation.senderBotId
            ? botProfiles.find((item) => item.id === rowPresentation.senderBotId)
            : undefined;
          const queueRowSenderLabel =
            senderBotProfile?.name ||
            rowPresentation.senderLabel ||
            (rowPresentation.isSession
              ? t('newChat.pendingQueue.sessionSenderFallback')
              : rowPresentation.isPlugin
                ? t('newChat.pendingQueue.pluginSenderFallback')
                : null);
          const isPendingEnqueue = entry.isPendingEnqueue === true;
          const isRowActive = isPendingQueueRowActive(rowActivity, entry.clientId);
          const isRowEditing = entry.clientId === editingClientId;
          const isSteering = steeringClientIds.includes(entry.clientId);
          const showActions = !isPendingEnqueue && (isRowActive || isSteering || isRowEditing);
          const canSteerRow = Boolean(onSteer) && rowPresentation.canSteer;
          const canEditRow =
            Boolean(onEditBegin) &&
            rowPresentation.canEdit &&
            (editingClientId === null || isRowEditing);
          const chatMessageContent = entry.chatMessage.content ?? entry.text;
          const agentReferences =
            entry.chatMessage.agentReferences?.length
              ? entry.chatMessage.agentReferences
              : (entry.agentReferences ?? []);
          const hasStructuredAtoms =
            !rowPresentation.isSyntheticTrigger &&
            (entry.chatMessage.quotesEncoded === true ||
              (entry.chatMessage.pastedTextRanges?.length ?? 0) > 0 ||
              (entry.chatMessage.slashCommandRanges?.length ?? 0) > 0 ||
              agentReferences.length > 0 ||
              (entry.mentions?.length ?? 0) > 0);
          const actionSlotWidth = canSteerRow
            ? canEditRow
              ? 'w-[68px]'
              : 'w-[44px]'
            : canEditRow
              ? 'w-[44px]'
              : 'w-5';
          const dragDisabled = !onReorder || isPendingEnqueue || isRowEditing || isSteering;
          // 正文提示:被截断时才展开全文;合成指令行按契约只显示标签、不给原文。
          // 目标行由本行正文的实测溢出决定(不是面板级共享标记),上次量到的结果不会
          // 残留到另一行头上。text/结构始终稳定,只由 controlledOpen 决定开合:悬停时若
          // 把 Tip 从透明分支换成 Trigger 分支,正文节点会重建、丢掉当时这次 mouseover,
          // 提示就永远不弹。
          const bodyTipText = rowPresentation.isSyntheticTrigger
            ? null
            : rowPresentation.displayText;
          const bodyTipOpen = isPendingQueueBodyTipOpen(
            bodyTipClientId,
            revealedBodyTipClientId,
            {
              clientId: entry.clientId,
              syntheticTrigger: rowPresentation.isSyntheticTrigger,
              editing: isRowEditing,
              dragActive,
            },
          );
          /** 把「正文要全文提示」指向这一行,或清掉它:溢出判定始终跟着当前这一行。 */
          const syncBodyTip = (overflowed: boolean) =>
            setBodyTipClientId(overflowed ? entry.clientId : null);
          const steerTipText = (() => {
            if (isSteering) return t('newChat.pendingQueue.steeringAction');
            const base = t(
              turnRunning
                ? 'newChat.pendingQueue.steerRunningTip'
                : 'newChat.pendingQueue.steerPausedTip',
            );
            return steerShortcutLabel ? `${base} · ${steerShortcutLabel}` : base;
          })();
          // The surrounding <p> owns the queue row's single-line nowrap +
          // ellipsis contract. Do not override white-space in the structured
          // body or multiline text islands can expand the row.
          const pendingRowContent = rowPresentation.isSyntheticTrigger
            ? t(rowPresentation.syntheticKind === 'continue'
                ? 'newChat.pendingQueue.syntheticContinueLabel'
                : 'newChat.pendingQueue.syntheticTriggerLabel')
            : hasStructuredAtoms ? (
                <SentInlineAtomBody
                  agentReferences={agentReferences}
                  className="relative top-px inline-flex min-w-0 max-w-full items-center gap-1 text-13 leading-[1.25]"
                  content={chatMessageContent}
                  pastedTextRanges={entry.chatMessage.pastedTextRanges}
                  quotesEncoded={entry.chatMessage.quotesEncoded}
                  slashCommandRanges={entry.chatMessage.slashCommandRanges}
                  workingDir={entry.createOpts.workingDir}
                />
              )
            : rowPresentation.displayText || t('newChat.pendingQueue.noTextContent');
          const handleRowKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
            if (!isPendingQueueSteerShortcut(e)) return;
            if (!canSteerRow || !onSteer || isSteering || isRowEditing) return;
            e.preventDefault();
            e.stopPropagation();
            void onSteer(entry.clientId);
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
              tabIndex={canSteerRow && !isPendingEnqueue ? 0 : undefined}
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
              onFocusCapture={(event) => {
                setRowActivity((activity) =>
                  activatePendingQueueRowFocus(activity, entry.clientId),
                );
                // 键盘激活也要按当行现量;焦点落在行内动作按钮 / 引用 chip 上时让位给它们自己的 Tip。
                syncBodyTip(
                  !isQueueRowChildTipTarget(event.target) &&
                    isQueueRowBodyOverflowed(
                      event.currentTarget.querySelector<HTMLElement>(
                        QUEUE_ROW_BODY_SELECTOR,
                      ),
                    ),
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
                setBodyTipClientId((current) => (current === entry.clientId ? null : current));
              }}
              aria-selected={isRowActive}
              className={cn(
                'group flex gap-1.5 rounded-[8px] border border-transparent px-2 py-0.5',
                // 单行展示态整行垂直居中, 让 drag handle / 文字 / actions 光学对齐;
                // 编辑态仅保留行高亮与取消入口，正文统一在主输入框修改。
                'items-center',
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
                  !dragDisabled &&
                    'cursor-grab group-hover:opacity-100 focus:opacity-100 active:cursor-grabbing',
                  dragDisabled && 'cursor-default',
                )}
              >
                <GripVertical size={12} strokeWidth={2} aria-hidden />
              </button>
              {rowPresentation.isOrca ||
              rowPresentation.isScheduler ||
              rowPresentation.isSession ||
              rowPresentation.isPlugin ? (
                <div
                  aria-label={t(
                    rowPresentation.isScheduler
                      ? 'newChat.pendingQueue.schedulerRowAria'
                      : rowPresentation.senderBotId
                        ? 'newChat.pendingQueue.botRowAria'
                        : rowPresentation.isSession
                          ? 'newChat.pendingQueue.sessionRowAria'
                        : rowPresentation.isPlugin
                          ? 'newChat.pendingQueue.pluginRowAria'
                        : 'newChat.pendingQueue.orcaRowAria',
                    { sender: queueRowSenderLabel },
                  )}
                  className="relative top-px flex min-w-0 flex-1 items-center gap-1.5"
                >
                  {rowPresentation.senderBotId ? (
                    <BotAvatar
                      bot={{
                        name: queueRowSenderLabel ?? rowPresentation.senderBotId,
                        avatar: senderBotProfile?.avatar ?? null,
                        avatarColor: senderBotProfile?.avatarColor ?? null,
                      }}
                      size="xs"
                      className="h-3.5 w-3.5 text-10"
                    />
                  ) : rowPresentation.isSession ? (
                    <Send
                      size={13}
                      strokeWidth={2}
                      aria-hidden
                      className="shrink-0 text-[var(--msg-assistant-text)]"
                    />
                  ) : rowPresentation.isPlugin ? (
                    <Puzzle
                      size={13}
                      strokeWidth={2}
                      aria-hidden
                      className="shrink-0 text-[var(--msg-assistant-text)]"
                    />
                  ) : rowPresentation.isScheduler ? (
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
                  {/* 来源 ID 提示归来源标签:整行只留正文提示,两件事不再抢同一个悬停位置。 */}
                  <span
                    title={queueRowSourceIdTitle(entry, t) ?? undefined}
                    className="min-w-0 max-w-[120px] shrink truncate text-13 font-semibold leading-[1.25] text-[var(--msg-assistant-text)]"
                  >
                    {queueRowSenderLabel}
                  </span>
                  <Tip
                    text={bodyTipText}
                    controlledOpen={bodyTipOpen}
                    onOpenChange={dismissBodyTip}
                    contentClassName={queueBodyTipClassName}
                  >
                    <span
                      data-queue-row-body
                      onPointerOver={(event) =>
                        // pointerover 会冒泡到正文内的 chip:指针在 chip 上时行级全文提示让位。
                        syncBodyTip(
                          !isQueueRowChildTipTarget(event.target) &&
                            isQueueRowBodyOverflowed(event.currentTarget),
                        )
                      }
                      onPointerLeave={() =>
                        setBodyTipClientId((current) =>
                          current === entry.clientId ? null : current,
                        )
                      }
                      className={cn(
                        'min-w-0 flex-1 truncate text-13 leading-[1.25]',
                        isRowActive
                          ? 'text-[var(--msg-assistant-text)]'
                          : 'text-[var(--settings-section-desc)]',
                      )}
                    >
                      {rowPresentation.isSyntheticTrigger
                        ? t(
                            rowPresentation.syntheticKind === 'continue'
                            ? 'newChat.pendingQueue.syntheticContinueLabel'
                            : 'newChat.pendingQueue.syntheticTriggerLabel',
                          )
                        : rowPresentation.displayText || t('newChat.pendingQueue.noTextContent')}
                    </span>
                  </Tip>
                </div>
              ) : (
                <>
                {/* 手机 / 另一台电脑发来的本人排队消息:与已发送消息同一规则标出设备(查看者即发送设备时不标)。 */}
                {entry.sourceDevice ? <QueueSourceDeviceTag device={entry.sourceDevice} /> : null}
                <Tip
                  text={bodyTipText}
                  controlledOpen={bodyTipOpen}
                  onOpenChange={dismissBodyTip}
                  contentClassName={queueBodyTipClassName}
                >
                  <p
                    data-queue-row-body
                    onPointerOver={(event) =>
                      // pointerover 会冒泡到正文内的 chip:指针在 chip 上时行级全文提示让位。
                      syncBodyTip(
                        !isQueueRowChildTipTarget(event.target) &&
                          isQueueRowBodyOverflowed(event.currentTarget),
                      )
                    }
                    onPointerLeave={() =>
                      setBodyTipClientId((current) =>
                        current === entry.clientId ? null : current,
                      )
                    }
                    className={cn(
                      // top-px: 在居中基础上把文字再压低 1px, 抵消字体 metrics, 与 drag handle 光学对齐
                      'relative top-px min-w-0 flex-1 truncate text-13 leading-[1.25]',
                      isRowActive
                        ? 'text-[var(--msg-assistant-text)]'
                        : 'text-[var(--settings-section-desc)]',
                    )}
                  >
                    {pendingRowContent}
                  </p>
                </Tip>
                </>
              )}

              {isPendingEnqueue ? (
                <span
                  aria-hidden
                  className="flex h-5 w-5 shrink-0 items-center justify-center text-[var(--cmd-palette-item-meta)]"
                >
                  <Spinner size={12} strokeWidth={2.25} />
                </span>
              ) : isRowEditing ? (
                <span aria-hidden className="h-5 w-5 shrink-0" />
              ) : showActions ? (
                <div
                  data-pending-queue-row-action="true"
                  className={cn('flex shrink-0 items-center justify-end gap-1', actionSlotWidth)}
                >
                  {canSteerRow && onSteer && (
                    <Tip text={steerTipText} side="top">
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
                        className={cn(
                          iconButtonClassName,
                          'disabled:cursor-wait disabled:opacity-70',
                        )}
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
                        onClick={() => beginEdit(entry)}
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
                        aria-label={t('newChat.pendingQueue.removeAria', {
                          index: originalIdx + 1,
                        })}
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
            'grid w-full select-none grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-t px-2 py-1.5 text-12 leading-none',
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
              {expanded ? (
                <ChevronUp size={13} aria-hidden />
              ) : (
                <ChevronDown size={13} aria-hidden />
              )}
            </button>
          ) : (
            <span aria-hidden className="col-start-2 h-5" />
          )}
          <div className="col-start-3 flex min-w-0 justify-end">
            {paused && onResume && (
              <Button
                variant="secondary"
                size="xxs"
                compact
                type="button"
                onClick={onResume}
                aria-label={t('newChat.pendingQueue.resumeAria')}
                className="min-w-[64px]"
              >
                {t('newChat.pendingQueue.resumeAction')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 正文全文提示:保留原换行。限高是防止超长协调指令把浮层铺满整屏,但固定 200px 会
// 在十几行处把内容裁掉,而这类行没有别的可读表面。改用视口相对上限,常见长指令能
// 整段读完;再长的尾部仍会被裁 —— 这个浮层不能滚动:仓库统一给 Tip 设了
// disableHoverableContent=true(见 ui/tooltip.tsx),指针一移到浮层上就关,滚轮没有
// 落点。要真正做到可滚动得先放开那条全局裁决,不在本 PR 范围。
const queueBodyTipClassName =
  'max-h-[min(60vh,480px)] overflow-hidden whitespace-pre-wrap';

const QUEUE_ROW_BODY_SELECTOR = '[data-queue-row-body]';
/**
 * 行内自带 Tip 的子元素:动作按钮、正文里的引用 chip。
 * 指针 / 焦点落在这些子元素上时,行级全文提示必须先收起,否则两层提示叠在一屏。
 */
const QUEUE_ROW_CHILD_TIP_SELECTOR =
  '[data-pending-queue-row-action="true"], [data-inline-reference-chip]';

/** 与 Tip 共享的 delayDuration 对齐:指针划过列表时不该立刻铺开全文浮层。 */
const QUEUE_BODY_TIP_HOVER_DELAY_MS = 500;

/** 正文被单行截断时才需要全文提示,短消息不重复一遍可见内容。 */
function isQueueRowBodyOverflowed(node: HTMLElement | null): boolean {
  return Boolean(node && node.scrollWidth > node.clientWidth);
}

/** 行内自带 Tip 的子元素(插话/编辑/删除按钮、引用 chip)不该被行级浮层盖住。 */
function isQueueRowChildTipTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(QUEUE_ROW_CHILD_TIP_SELECTOR) !== null;
}

const iconButtonClassName = cn(
  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full border',
  'border-[var(--chat-input-border)] bg-[var(--chat-input-bg)]',
  'text-[var(--settings-section-desc)] hover:text-[var(--msg-assistant-text)]',
);
