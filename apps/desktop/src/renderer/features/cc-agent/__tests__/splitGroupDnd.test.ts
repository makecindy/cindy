// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';

import {
  SPLIT_GROUP_SESSION_MIME,
  SPLIT_GROUP_SESSION_LINK_MIME,
  hasSplitGroupSessionType,
  isSplitGroupComposerDropTarget,
  isSplitGroupDragSource,
  needsDedicatedSplitGroupDragHandle,
  resolveSplitDropSide,
  shouldStartSplitGroupDrag,
  writeSplitGroupSessionDragData,
} from '../splitGroupDnd';

const RECT = { left: 100, top: 50, width: 400, height: 300 };

describe('splitGroupDnd', () => {
  it('输入框内的任务拖放由 composer 消费，不属于分屏落点', () => {
    const composer = document.createElement('div');
    composer.setAttribute('data-split-group-composer-drop-target', '');
    const child = document.createElement('span');
    composer.append(child);

    expect(isSplitGroupComposerDropTarget(child)).toBe(true);
    expect(isSplitGroupComposerDropTarget(document.createElement('div'))).toBe(false);
  });

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
    expect(dataTransfer.effectAllowed).toBe('copyMove');
    expect(values.get(SPLIT_GROUP_SESSION_MIME)).toBe('session-a');
    expect(values.get(SPLIT_GROUP_SESSION_LINK_MIME)).toBe('cindy://session/session-a');
    expect(values.get('text/plain')).toBe('session-a');
    expect(
      writeSplitGroupSessionDragData(dataTransfer, 'session-remote', { deviceId: 'device-b' }),
    ).toBe(true);
    expect(values.get(SPLIT_GROUP_SESSION_LINK_MIME)).toBe(
      'cindy://session/session-remote?device=device-b',
    );
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

  it('项目子任务被 data-no-drag 隔离时仍可作为分屏拖拽源', () => {
    expect(
      isSplitGroupDragSource({
        editing: false,
        orcaRole: null,
        inSortableContainer: true,
        sortableDragBlocked: true,
      }),
    ).toBe(true);
  });

  it('置顶排序行提供独立起手区后仍可作为分屏拖拽源', () => {
    const context = {
      editing: false,
      orcaRole: null,
      inSortableContainer: true,
      sortableDragBlocked: false,
      hasDedicatedHandle: true,
    };

    expect(needsDedicatedSplitGroupDragHandle(context)).toBe(true);
    expect(isSplitGroupDragSource(context)).toBe(true);
    expect(
      shouldStartSplitGroupDrag({
        enabled: true,
        needsDedicatedHandle: true,
        startedOnDedicatedHandle: true,
        startedOnInteractiveElement: false,
      }),
    ).toBe(true);
  });

  it('原生 Sortable 行不再需要分开的分屏起手区', () => {
    const context = {
      editing: false,
      orcaRole: null,
      inSortableContainer: true,
      sortableDragBlocked: false,
      nativeSortable: true,
    };

    expect(needsDedicatedSplitGroupDragHandle(context)).toBe(false);
    expect(isSplitGroupDragSource(context)).toBe(true);
    expect(
      shouldStartSplitGroupDrag({
        enabled: true,
        needsDedicatedHandle: false,
        startedOnDedicatedHandle: false,
        startedOnInteractiveElement: false,
      }),
    ).toBe(true);
  });

  it('置顶排序行的非起手区和交互元素不会启动分屏拖拽', () => {
    expect(
      shouldStartSplitGroupDrag({
        enabled: true,
        needsDedicatedHandle: true,
        startedOnDedicatedHandle: false,
        startedOnInteractiveElement: false,
      }),
    ).toBe(false);
    expect(
      shouldStartSplitGroupDrag({
        enabled: true,
        needsDedicatedHandle: true,
        startedOnDedicatedHandle: true,
        startedOnInteractiveElement: true,
      }),
    ).toBe(false);
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
