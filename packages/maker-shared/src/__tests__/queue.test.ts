import { describe, expect, it } from 'vitest';
import {
  buildQueuePanelSummary,
  buildQueueRowPresentation,
  isOrcaQueueItem,
  queueMoveTargetIndex,
  stopOptionsForProjection,
} from '../queue.js';
import {
  CONTINUE_AFTER_ERROR_PROMPT,
  UI_ACTION_TRIGGER_PREFIX,
} from '../syntheticTrigger.js';

function queued(clientId: string): { clientId: string } {
  return { clientId };
}

describe('shared queue presentation model', () => {
  it('preserves and pauses queue only when Stop sees queued rows', () => {
    expect(stopOptionsForProjection({ pendingQueue: [] })).toBeUndefined();
    expect(stopOptionsForProjection({ pendingQueue: [queued('q-1')] })).toEqual({
      keepQueue: true,
      pauseQueue: true,
    });
  });

  it('summarizes queue panel state for normal, paused, stopped, and errored queues', () => {
    const rows = [queued('q-1'), queued('q-2'), queued('q-3'), queued('q-4')];

    expect(buildQueuePanelSummary({
      error: null,
      errorRetryText: null,
      pendingQueue: rows,
      queueAbortPending: false,
      queueExpanded: false,
      queuePaused: false,
    })).toEqual({
      detail: '4 条消息 · 按桌面端顺序发送',
      hiddenCount: 1,
      hint: '可调整顺序、插话、编辑或删除普通队列消息。',
      title: '待发送队列',
      visibleCount: 3,
    });

    expect(buildQueuePanelSummary({
      error: null,
      errorRetryText: null,
      pendingQueue: rows.slice(0, 2),
      queueAbortPending: false,
      queueExpanded: false,
      queuePaused: true,
    })).toMatchObject({
      detail: '2 条消息等待恢复',
      hint: '点“继续”后会按当前顺序继续发送到桌面端。',
      title: '队列已暂停',
    });

    expect(buildQueuePanelSummary({
      error: null,
      errorRetryText: null,
      pendingQueue: [],
      queueAbortPending: true,
      queueExpanded: false,
      queuePaused: false,
    })).toMatchObject({
      detail: '等待桌面端确认停止',
      title: '停止处理中',
      visibleCount: 0,
    });

    expect(buildQueuePanelSummary({
      error: 'send failed',
      errorRetryText: 'retry',
      pendingQueue: rows,
      queueAbortPending: false,
      queueExpanded: true,
      queuePaused: false,
    }, '协作模式手机版第一版为只读安全降级。')).toMatchObject({
      detail: '发送失败 · 可重试',
      hint: '协作模式手机版第一版为只读安全降级。',
      hiddenCount: 0,
      title: '队列需要处理',
      visibleCount: 4,
    });
  });

  it('matches the desktop pending queue insertion-index contract for up/down moves', () => {
    expect(queueMoveTargetIndex(0, 3, 'up')).toBeNull();
    expect(queueMoveTargetIndex(1, 3, 'up')).toBe(0);
    expect(queueMoveTargetIndex(1, 3, 'down')).toBe(3);
    expect(queueMoveTargetIndex(2, 3, 'down')).toBeNull();
    expect(queueMoveTargetIndex(-1, 3, 'up')).toBeNull();
    expect(queueMoveTargetIndex(3, 3, 'down')).toBeNull();
  });

  it('detects Orca queue origins so clients can keep collaboration rows read-only', () => {
    expect(isOrcaQueueItem({ origin: { kind: 'orca', leadSessionId: 'lead-1' } })).toBe(true);
    expect(isOrcaQueueItem({ origin: { kind: 'user' } })).toBe(false);
    expect(isOrcaQueueItem({ origin: undefined })).toBe(false);
  });

  it('builds row action availability from queue order and locks', () => {
    const projection = {
      steeringQueueClientIds: [],
      queueEditLocks: [],
      queueInteractionLocks: [],
    };
    const first = buildQueueRowPresentation({
      item: queued('q-1'),
      originalIndex: 0,
      projection,
      queueLength: 3,
    });
    expect(first).toMatchObject({
      editLocked: false,
      hint: null,
      interactionLocked: false,
      orcaOrigin: false,
      steering: false,
      title: '队列 1',
    });
    expect(first.actions.moveUp).toEqual({
      disabled: true,
      disabledReason: '已经是队列第一条。',
      targetIndex: null,
    });
    expect(first.actions.moveDown).toEqual({
      disabled: false,
      disabledReason: null,
      targetIndex: 2,
    });
    expect(first.actions.steer.disabled).toBe(false);

    const middle = buildQueueRowPresentation({
      item: queued('q-2'),
      originalIndex: 1,
      projection,
      queueLength: 3,
    });
    expect(middle.actions.moveUp.targetIndex).toBe(0);
    expect(middle.actions.moveDown.targetIndex).toBe(3);
  });

  it('uses a single base disabled reason for busy and read-only rows', () => {
    const busy = buildQueueRowPresentation({
      busy: true,
      item: queued('q-1'),
      originalIndex: 1,
      projection: {
        steeringQueueClientIds: [],
        queueEditLocks: [],
        queueInteractionLocks: [],
      },
      queueLength: 3,
    });
    expect(busy.actions.edit).toEqual({
      disabled: true,
      disabledReason: '队列操作同步中，完成后再继续操作。',
    });
    expect(busy.actions.moveUp.disabledReason).toBe('队列操作同步中，完成后再继续操作。');

    const readOnly = buildQueueRowPresentation({
      busy: true,
      item: { ...queued('q-1'), origin: { kind: 'orca' } },
      originalIndex: 1,
      projection: {
        steeringQueueClientIds: ['q-1'],
        queueEditLocks: ['q-1'],
        queueInteractionLocks: ['drag'],
      },
      queueLength: 3,
      readOnlyReason: '协作模式手机版第一版为只读安全降级。',
    });
    expect(readOnly.hint).toBe('协作模式手机版第一版为只读安全降级。');
    expect(readOnly.actions.remove.disabledReason).toBe('协作模式手机版第一版为只读安全降级。');

    const busyOrca = buildQueueRowPresentation({
      busy: true,
      item: { ...queued('q-1'), origin: { kind: 'orca' } },
      originalIndex: 1,
      projection: {
        steeringQueueClientIds: [],
        queueEditLocks: [],
        queueInteractionLocks: [],
      },
      queueLength: 3,
    });
    expect(busyOrca.actions.edit.disabledReason).toBe('协同消息由桌面端编排，手机端只读显示。');
  });

  it('explains steering, edit-lock, interaction-lock, and Orca row states', () => {
    const steering = buildQueueRowPresentation({
      item: queued('q-1'),
      originalIndex: 0,
      projection: {
        steeringQueueClientIds: ['q-1'],
        queueEditLocks: [],
        queueInteractionLocks: [],
      },
      queueLength: 2,
    });
    expect(steering.title).toBe('插话发送中');
    expect(steering.hint).toBe('插话正在发送到当前 turn，暂时不能编辑或移动。');
    expect(steering.actions.edit.disabledReason).toBe('插话正在发送到当前 turn，等待桌面端回流后再操作。');

    const editLocked = buildQueueRowPresentation({
      item: queued('q-1'),
      originalIndex: 0,
      projection: {
        steeringQueueClientIds: [],
        queueEditLocks: ['q-1'],
        queueInteractionLocks: [],
      },
      queueLength: 2,
    });
    expect(editLocked.hint).toBe('这条消息正在编辑中，桌面端会暂停自动发送。');
    expect(editLocked.actions.remove.disabledReason).toBe('这条队列消息正在编辑中，完成后再操作。');

    const interactionLocked = buildQueueRowPresentation({
      item: queued('q-1'),
      originalIndex: 0,
      projection: {
        steeringQueueClientIds: [],
        queueEditLocks: [],
        queueInteractionLocks: ['drag'],
      },
      queueLength: 2,
    });
    expect(interactionLocked.hint).toBe('队列正在被排序或其它交互锁定，暂时不能编辑。');
    expect(interactionLocked.actions.steer.disabledReason).toBe('队列正在被其它操作锁定，完成后再操作。');

    const orca = buildQueueRowPresentation({
      item: { ...queued('q-2'), origin: { kind: 'orca', leadSessionId: 'lead-1' } },
      originalIndex: 1,
      projection: {
        steeringQueueClientIds: [],
        queueEditLocks: [],
        queueInteractionLocks: [],
      },
      queueLength: 2,
    });
    expect(orca.title).toBe('协同队列 2');
    expect(orca.hint).toBe('协同消息由桌面端编排，手机端只读显示。');
    expect(orca.actions.steer.disabledReason).toBe('协同消息由桌面端编排，手机端只读显示。');
  });

  it('locks edit and steer (but keeps remove and reorder) for synthetic trigger rows', () => {
    const projection = {
      steeringQueueClientIds: [],
      queueEditLocks: [],
      queueInteractionLocks: [],
    };
    const continueRow = buildQueueRowPresentation({
      item: { ...queued('q-1'), text: CONTINUE_AFTER_ERROR_PROMPT },
      originalIndex: 0,
      projection,
      queueLength: 2,
    });
    expect(continueRow.syntheticKind).toBe('continue');
    expect(continueRow.actions.edit.disabled).toBe(true);
    expect(continueRow.actions.steer.disabled).toBe(true);
    expect(continueRow.actions.edit.disabledReason).toBe('系统指令消息不支持编辑或插话发送。');
    expect(continueRow.actions.remove.disabled).toBe(false);
    expect(continueRow.actions.moveDown.disabled).toBe(false);
    expect(continueRow.hint).toBe('这是系统自动生成的指令，可以取消，但不能编辑或插话发送。');

    const genericRow = buildQueueRowPresentation({
      item: { ...queued('q-2'), text: `${UI_ACTION_TRIGGER_PREFIX} regenerate image` },
      originalIndex: 1,
      projection,
      queueLength: 2,
    });
    expect(genericRow.syntheticKind).toBe('generic');
    expect(genericRow.actions.edit.disabled).toBe(true);

    const normalRow = buildQueueRowPresentation({
      item: { ...queued('q-3'), text: '普通用户消息' },
      originalIndex: 0,
      projection,
      queueLength: 1,
    });
    expect(normalRow.syntheticKind).toBeNull();
    expect(normalRow.actions.edit.disabled).toBe(false);
  });
});
