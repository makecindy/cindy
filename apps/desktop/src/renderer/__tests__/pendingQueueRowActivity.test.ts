import { describe, expect, it } from 'vitest';

import {
  activatePendingQueueRowFocus,
  activatePendingQueueRowHover,
  deactivatePendingQueueRowFocus,
  deactivatePendingQueueRowHover,
  emptyPendingQueueRowActivityState,
  isPendingQueueBodyTipOpen,
  isPendingQueueRowActive,
  prunePendingQueueRowActivity,
} from '@/components/new-chat/pendingQueueRowActivity';

describe('pendingQueueRowActivity', () => {
  it('clears hover activity when the pointer leaves the same row', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);

    expect(isPendingQueueRowActive(hovered, 'row-a')).toBe(true);
    expect(deactivatePendingQueueRowHover(hovered, 'row-a')).toEqual(
      emptyPendingQueueRowActivityState,
    );
  });

  it('does not let a stale mouseleave clear a newer hovered row', () => {
    const rowA = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);
    const rowB = activatePendingQueueRowHover(rowA, 'row-b', null);

    expect(deactivatePendingQueueRowHover(rowB, 'row-a')).toBe(rowB);
    expect(isPendingQueueRowActive(rowB, 'row-b')).toBe(true);
  });

  it('keeps keyboard focus activity after hover leaves', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);
    const focused = activatePendingQueueRowFocus(hovered, 'row-a');
    const hoverLeft = deactivatePendingQueueRowHover(focused, 'row-a');

    expect(isPendingQueueRowActive(hoverLeft, 'row-a')).toBe(true);
    expect(deactivatePendingQueueRowFocus(hoverLeft, 'row-a')).toEqual(
      emptyPendingQueueRowActivityState,
    );
  });

  it('does not move hover while an edit lock is active', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);

    expect(activatePendingQueueRowHover(hovered, 'row-b', 'row-a')).toBe(hovered);
  });

  it('prunes activity for rows that left the queue', () => {
    const hovered = activatePendingQueueRowHover(emptyPendingQueueRowActivityState, 'row-a', null);
    const focused = activatePendingQueueRowFocus(hovered, 'row-b');

    expect(prunePendingQueueRowActivity(focused, ['row-b'])).toEqual({
      hoveredClientId: null,
      focusedClientId: 'row-b',
    });
  });
});

// 测试价值
// - 生产入口与可观察结果:PendingQueuePanel 用 isPendingQueueBodyTipOpen 决定行级正文
//   全文提示开不开;用户看到的是截断行才弹全文、且同一时刻只有一行弹。
// - Bug／规则依据:#8977 自动审查 P1:溢出标记曾是面板级单一布尔,键盘把焦点移到一条
//   没被截断的短行也会弹全文,指针悬停 A / 焦点落在 B 时两行同真。
// - 现有覆盖缺口:pendingQueueRowActivity 已有用例只覆盖 hover/focus 激活,未覆盖这条
//   「目标行 + 当前行」绑定关系。
// - 最小失败输入:target='row-a'(悬停过长行)后切到 row-b(短行)。
// - tier:unit;纯谓词,无 DOM,并入同模块现有文件。
// - 实测耗时(单跑本文件):见 PR 描述。
describe('isPendingQueueBodyTipOpen', () => {
  const row = {
    clientId: 'row-a',
    syntheticTrigger: false,
    editing: false,
    dragActive: false,
  };

  it('only opens for the row whose body was measured as truncated', () => {
    expect(isPendingQueueBodyTipOpen('row-a', 'row-a', row)).toBe(true);
    expect(isPendingQueueBodyTipOpen('row-a', 'row-a', { ...row, clientId: 'row-b' })).toBe(false);
    expect(isPendingQueueBodyTipOpen(null, null, row)).toBe(false);
  });

  it('waits for the hover delay before the measured row may show', () => {
    expect(isPendingQueueBodyTipOpen('row-a', null, row)).toBe(false);
    expect(isPendingQueueBodyTipOpen('row-a', 'row-b', row)).toBe(false);
  });

  it('stays shut for synthetic, editing and dragging rows', () => {
    expect(isPendingQueueBodyTipOpen('row-a', 'row-a', { ...row, syntheticTrigger: true })).toBe(
      false,
    );
    expect(isPendingQueueBodyTipOpen('row-a', 'row-a', { ...row, editing: true })).toBe(false);
    expect(isPendingQueueBodyTipOpen('row-a', 'row-a', { ...row, dragActive: true })).toBe(false);
  });
});
