import { describe, expect, it } from 'vitest';

import {
  SPLIT_GROUP_SESSION_MIME,
  hasSplitGroupSessionType,
  isSplitGroupDragSource,
  resolveSplitDropSide,
  writeSplitGroupSessionDragData,
} from '../splitGroupDnd';

const RECT = { left: 100, top: 50, width: 400, height: 300 };

describe('splitGroupDnd', () => {
  it('只接受 Cindy 任务拖拽 MIME', () => {
    expect(hasSplitGroupSessionType([SPLIT_GROUP_SESSION_MIME])).toBe(true);
    expect(hasSplitGroupSessionType(['Files', 'text/plain'])).toBe(false);
  });

  it('向侧栏拖拽写入专用 MIME 和纯文本回退', () => {
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      setData: (format: string, data: string) => values.set(format, data),
    };

    expect(writeSplitGroupSessionDragData(dataTransfer, ' session-a ')).toBe(true);
    expect(dataTransfer.effectAllowed).toBe('move');
    expect(values.get(SPLIT_GROUP_SESSION_MIME)).toBe('session-a');
    expect(values.get('text/plain')).toBe('session-a');
    expect(writeSplitGroupSessionDragData(dataTransfer, '   ')).toBe(false);
  });

  it.each([
    ['left', 110, 200],
    ['right', 490, 200],
    ['top', 300, 60],
    ['bottom', 300, 340],
  ] as const)('指针靠近 %s 边时返回对应落点', (side, clientX, clientY) => {
    expect(resolveSplitDropSide(RECT, clientX, clientY)).toBe(side);
  });

  it('无尺寸目标不产生落点', () => {
    expect(resolveSplitDropSide({ ...RECT, width: 0 }, 100, 100)).toBeNull();
  });

  it('时间排序列表里的普通任务行才是分屏拖拽源', () => {
    expect(
      isSplitGroupDragSource({ editing: false, orcaRole: null, inSortableContainer: false }),
    ).toBe(true);
    expect(
      isSplitGroupDragSource({ editing: false, orcaRole: 'lead', inSortableContainer: false }),
    ).toBe(true);
  });

  it('编辑态、Orca worker 与 Sortable 容器内的行不充当拖拽源', () => {
    expect(
      isSplitGroupDragSource({ editing: true, orcaRole: null, inSortableContainer: false }),
    ).toBe(false);
    expect(
      isSplitGroupDragSource({ editing: false, orcaRole: 'worker', inSortableContainer: false }),
    ).toBe(false);
    expect(
      isSplitGroupDragSource({ editing: false, orcaRole: null, inSortableContainer: true }),
    ).toBe(false);
  });
});
