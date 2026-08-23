import { syntheticTriggerKind } from './syntheticTrigger.js';
import { presentationText, type PresentationLocalizer } from './presentationLocalization.js';

export interface QueueProjectionLike {
  error: string | null;
  errorRetryText: string | null;
  pendingQueue: readonly unknown[];
  queueAbortPending: boolean;
  queueExpanded: boolean;
  queuePaused: boolean;
}

export interface QueuePanelSummary {
  detail: string;
  hiddenCount: number;
  hint: string;
  title: string;
  visibleCount: number;
}

export interface QueueRowProjectionLike {
  steeringQueueClientIds: readonly string[];
  queueEditLocks: readonly string[];
  queueInteractionLocks: readonly string[];
}

export type QueueRowActionId = 'moveUp' | 'moveDown' | 'steer' | 'edit' | 'remove';

export interface QueueRowActionPresentation {
  disabled: boolean;
  disabledReason: string | null;
  targetIndex?: number | null;
}

export interface QueueRowPresentation {
  actions: Record<QueueRowActionId, QueueRowActionPresentation>;
  editLocked: boolean;
  hint: string | null;
  interactionLocked: boolean;
  orcaOrigin: boolean;
  steering: boolean;
  /**
   * 合成 UI 指令行的遮蔽标签语义(桌面「失败后继续」等隐藏 prompt 在 session 忙时
   * 会排进 pendingQueue):'continue' = 续跑指令、'generic' = 其它系统指令、null =
   * 普通用户消息。非 null 时渲染层必须用遮蔽标签替代原文(裸 prompt 不能给用户看),
   * 且 edit / steer 已被禁用(任何合成指令都不该被改写;删除/排序保留)。
   */
  syntheticKind: 'continue' | 'generic' | null;
  title: string;
}

export function stopOptionsForProjection(
  projection: Pick<QueueProjectionLike, 'pendingQueue'>,
): { keepQueue?: boolean; pauseQueue?: boolean } | undefined {
  return projection.pendingQueue.length > 0
    ? { keepQueue: true, pauseQueue: true }
    : undefined;
}

export function buildQueuePanelSummary(
  projection: QueueProjectionLike,
  readOnlyReason?: string | null,
  collapsedVisibleRows = 3,
  localizer?: PresentationLocalizer,
): QueuePanelSummary {
  const queueCount = projection.pendingQueue.length;
  const expanded = projection.queueExpanded || queueCount <= collapsedVisibleRows;
  const visibleCount = expanded ? queueCount : Math.max(0, collapsedVisibleRows);
  const hiddenCount = Math.max(0, queueCount - visibleCount);

  if (projection.error) {
    return {
      detail: projection.errorRetryText
        ? presentationText(localizer, 'message.queuePresentation.panel.sendFailedRetryable', '发送失败 · 可重试')
        : presentationText(localizer, 'message.queuePresentation.panel.sendFailed', '发送失败'),
      hiddenCount,
      hint: readOnlyReason
        ?? presentationText(localizer, 'message.queuePresentation.panel.errorHint', '先处理队列错误，再继续发送新的消息。'),
      title: presentationText(localizer, 'message.queuePresentation.panel.errorTitle', '队列需要处理'),
      visibleCount,
    };
  }
  if (projection.queueAbortPending) {
    return {
      detail: queueCount > 0
        ? presentationText(localizer, 'message.queuePresentation.panel.abortQueued', `${queueCount} 条消息保留在队列里`, { count: queueCount })
        : presentationText(localizer, 'message.queuePresentation.panel.abortWaiting', '等待桌面端确认停止'),
      hiddenCount,
      hint: readOnlyReason
        ?? presentationText(localizer, 'message.queuePresentation.panel.abortHint', '停止完成前先不要重复发送，保留的消息会继续显示在这里。'),
      title: presentationText(localizer, 'message.queuePresentation.panel.abortTitle', '停止处理中'),
      visibleCount,
    };
  }
  if (projection.queuePaused) {
    return {
      detail: presentationText(localizer, 'message.queuePresentation.panel.pausedDetail', `${queueCount} 条消息等待恢复`, { count: queueCount }),
      hiddenCount,
      hint: readOnlyReason
        ?? presentationText(localizer, 'message.queuePresentation.panel.pausedHint', '点“继续”后会按当前顺序继续发送到桌面端。'),
      title: presentationText(localizer, 'message.queuePresentation.panel.pausedTitle', '队列已暂停'),
      visibleCount,
    };
  }
  return {
    detail: presentationText(localizer, 'message.queuePresentation.panel.defaultDetail', `${queueCount} 条消息 · 按桌面端顺序发送`, { count: queueCount }),
    hiddenCount,
    hint: readOnlyReason
      ?? presentationText(localizer, 'message.queuePresentation.panel.defaultHint', '可调整顺序、插话、编辑或删除普通队列消息。'),
    title: presentationText(localizer, 'message.queuePresentation.panel.defaultTitle', '待发送队列'),
    visibleCount,
  };
}

export function buildQueueRowPresentation(input: {
  busy?: boolean;
  item: Pick<{ clientId: string; origin?: unknown; text?: string }, 'clientId' | 'origin' | 'text'>;
  originalIndex: number;
  projection: QueueRowProjectionLike;
  queueLength: number;
  readOnlyReason?: string | null;
}, localizer?: PresentationLocalizer): QueueRowPresentation {
  const steering = input.projection.steeringQueueClientIds.includes(input.item.clientId);
  const editLocked = input.projection.queueEditLocks.includes(input.item.clientId);
  const interactionLocked = input.projection.queueInteractionLocks.length > 0;
  const orcaOrigin = isOrcaQueueItem(input.item);
  const syntheticKind = syntheticTriggerKind(input.item.text ?? '');
  const moveUpTarget = queueMoveTargetIndex(input.originalIndex, input.queueLength, 'up');
  const moveDownTarget = queueMoveTargetIndex(input.originalIndex, input.queueLength, 'down');
  const baseDisabledReason = queueRowBaseDisabledReason({
    busy: input.busy === true,
    editLocked,
    interactionLocked,
    orcaOrigin,
    readOnlyReason: input.readOnlyReason,
    steering,
  }, localizer);
  // 合成指令行只封 edit / steer(对齐桌面 canEdit / canSteer=false),删除与排序
  // 照常——用户可以取消一条排队中的续跑,但不能改写或抢发它的内容。
  const syntheticEditReason = syntheticKind
    ? presentationText(localizer, 'message.queuePresentation.row.syntheticEditDisabled', '系统指令消息不支持编辑或插话发送。')
    : null;

  return {
    actions: {
      moveUp: queueRowAction(baseDisabledReason, moveUpTarget, presentationText(localizer, 'message.queuePresentation.row.first', '已经是队列第一条。')),
      moveDown: queueRowAction(baseDisabledReason, moveDownTarget, presentationText(localizer, 'message.queuePresentation.row.last', '已经是队列最后一条。')),
      steer: queueRowAction(baseDisabledReason ?? syntheticEditReason),
      edit: queueRowAction(baseDisabledReason ?? syntheticEditReason),
      remove: queueRowAction(baseDisabledReason),
    },
    editLocked,
    hint: queueRowHint({
      editLocked,
      interactionLocked,
      orcaOrigin,
      readOnlyReason: input.readOnlyReason,
      steering,
      syntheticKind,
    }, localizer),
    interactionLocked,
    orcaOrigin,
    steering,
    syntheticKind,
    title: steering
      ? presentationText(localizer, 'message.queuePresentation.row.steering', '插话发送中')
      : orcaOrigin
        ? presentationText(localizer, 'message.queuePresentation.row.orcaTitle', `协同队列 ${input.originalIndex + 1}`, { index: input.originalIndex + 1 })
        : presentationText(localizer, 'message.queuePresentation.row.title', `队列 ${input.originalIndex + 1}`, { index: input.originalIndex + 1 }),
  };
}

export function queueMoveTargetIndex(
  currentIndex: number,
  queueLength: number,
  direction: 'up' | 'down',
): number | null {
  if (!Number.isInteger(currentIndex) || !Number.isInteger(queueLength)) return null;
  if (currentIndex < 0 || currentIndex >= queueLength) return null;
  if (direction === 'up') return currentIndex > 0 ? currentIndex - 1 : null;
  return currentIndex < queueLength - 1 ? currentIndex + 2 : null;
}

export function isOrcaQueueItem(
  item: Pick<{ origin?: unknown }, 'origin'>,
): boolean {
  const origin = readRecord(item.origin);
  return origin?.kind === 'orca';
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function queueRowAction(
  baseDisabledReason: string | null,
  targetIndex?: number | null,
  boundaryReason?: string,
): QueueRowActionPresentation {
  if (baseDisabledReason) {
    return {
      disabled: true,
      disabledReason: baseDisabledReason,
      ...(targetIndex !== undefined ? { targetIndex } : {}),
    };
  }
  if (targetIndex === null) {
    return {
      disabled: true,
      disabledReason: boundaryReason ?? '当前操作不可用。',
      targetIndex,
    };
  }
  return {
    disabled: false,
    disabledReason: null,
    ...(targetIndex !== undefined ? { targetIndex } : {}),
  };
}

function queueRowBaseDisabledReason(input: {
  busy: boolean;
  editLocked: boolean;
  interactionLocked: boolean;
  orcaOrigin: boolean;
  readOnlyReason?: string | null;
  steering: boolean;
}, localizer?: PresentationLocalizer): string | null {
  if (input.readOnlyReason) return input.readOnlyReason;
  if (input.orcaOrigin) return presentationText(localizer, 'message.queuePresentation.row.orcaReadOnly', '协同消息由桌面端编排，手机端只读显示。');
  if (input.busy) return presentationText(localizer, 'message.queuePresentation.row.busy', '队列操作同步中，完成后再继续操作。');
  if (input.steering) return presentationText(localizer, 'message.queuePresentation.row.steeringDisabled', '插话正在发送到当前 turn，等待桌面端回流后再操作。');
  if (input.editLocked) return presentationText(localizer, 'message.queuePresentation.row.editLocked', '这条队列消息正在编辑中，完成后再操作。');
  if (input.interactionLocked) return presentationText(localizer, 'message.queuePresentation.row.interactionLocked', '队列正在被其它操作锁定，完成后再操作。');
  return null;
}

function queueRowHint(input: {
  editLocked: boolean;
  interactionLocked: boolean;
  orcaOrigin: boolean;
  readOnlyReason?: string | null;
  steering: boolean;
  syntheticKind?: 'continue' | 'generic' | null;
}, localizer?: PresentationLocalizer): string | null {
  if (input.readOnlyReason) return input.readOnlyReason;
  if (input.orcaOrigin) return presentationText(localizer, 'message.queuePresentation.row.orcaReadOnly', '协同消息由桌面端编排，手机端只读显示。');
  if (input.syntheticKind) return presentationText(localizer, 'message.queuePresentation.row.syntheticHint', '这是系统自动生成的指令，可以取消，但不能编辑或插话发送。');
  if (input.steering) return presentationText(localizer, 'message.queuePresentation.row.steeringHint', '插话正在发送到当前 turn，暂时不能编辑或移动。');
  if (input.editLocked) return presentationText(localizer, 'message.queuePresentation.row.editHint', '这条消息正在编辑中，桌面端会暂停自动发送。');
  if (input.interactionLocked) return presentationText(localizer, 'message.queuePresentation.row.interactionHint', '队列正在被排序或其它交互锁定，暂时不能编辑。');
  return null;
}
