// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  SPLIT_GROUP_SESSION_MIME,
  SPLIT_GROUP_SESSION_LINK_MIME,
  hasSplitGroupSessionType,
  isSplitGroupComposerDropTarget,
  isSplitGroupDragSource,
  needsDedicatedSplitGroupDragHandle,
  resolveSplitDropSide,
  shouldStartSplitGroupDrag,
  finishSessionDrag,
  startSessionDrag,
  writeSplitGroupSessionDragData,
} from '../splitGroupDnd';

const RECT = { left: 100, top: 50, width: 400, height: 300 };
const PREVIEW_PALETTE = {
  surface: 'rgb(248, 248, 248)',
  border: 'rgb(220, 223, 227)',
  text: 'rgb(60, 63, 67)',
};

function mockPreviewPalette(): void {
  vi.spyOn(window, 'getComputedStyle').mockReturnValue({
    backgroundColor: PREVIEW_PALETTE.surface,
    borderTopColor: PREVIEW_PALETTE.border,
    color: PREVIEW_PALETTE.text,
  } as unknown as CSSStyleDeclaration);
}

describe('splitGroupDnd', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  it('只写入 Cindy 专用 MIME，避免系统把任务拖拽落成桌面文件', () => {
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      clearData: (format?: string) => {
        if (format === undefined) values.clear();
        else values.delete(format);
      },
      setData: (format: string, data: string) => values.set(format, data),
    };

    values.set('text/plain', 'stale-text');
    values.set('text/uri-list', 'https://example.com/dragged');

    expect(writeSplitGroupSessionDragData(dataTransfer, ' session-a ')).toBe(true);
    expect(dataTransfer.effectAllowed).toBe('copyMove');
    expect(values.get(SPLIT_GROUP_SESSION_MIME)).toBe('session-a');
    expect(values.get(SPLIT_GROUP_SESSION_LINK_MIME)).toBe('cindy://session/session-a');
    expect(values.has('text/plain')).toBe(false);
    expect(values.has('text/uri-list')).toBe(false);
    expect(
      writeSplitGroupSessionDragData(dataTransfer, 'session-remote', { deviceId: 'device-b' }),
    ).toBe(true);
    expect(values.get(SPLIT_GROUP_SESSION_LINK_MIME)).toBe(
      'cindy://session/session-remote?device=device-b',
    );
    expect(writeSplitGroupSessionDragData(dataTransfer, '   ')).toBe(false);
  });

  it('共享原生拖拽 helper 保留任务 payload 并在结束时请求窗口外判定', () => {
    mockPreviewPalette();
    const row = document.createElement('div');
    const title = document.createElement('span');
    row.append(title);
    const values = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      setData: (format: string, data: string) => values.set(format, data),
      setDragImage: vi.fn(),
    };
    const beginPreview = vi.fn().mockResolvedValue(undefined);
    const endPreview = vi.fn();
    const openOutside = vi.fn().mockResolvedValue(false);
    const electronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          beginSessionDragPreview: beginPreview,
          endSessionDragPreview: endPreview,
          openSessionInNewWindowIfDroppedOutside: openOutside,
        },
      },
    });
    const dragStartEvent = {
      target: title,
      currentTarget: row,
      dataTransfer,
      preventDefault: vi.fn(),
    };
    expect(
      startSessionDrag(dragStartEvent, {
        sessionId: 'session-a',
        deviceId: 'device-b',
        label: '任务 A',
        enabled: true,
        needsDedicatedHandle: false,
      }),
    ).toBe(true);
    expect(values.get(SPLIT_GROUP_SESSION_MIME)).toBe('session-a');
    expect(row.dataset.sessionDragging).toBe('true');
    expect(dataTransfer.setDragImage).toHaveBeenCalledOnce();
    const preview = dataTransfer.setDragImage.mock.calls[0]?.[0];
    expect(preview).toBeInstanceOf(HTMLCanvasElement);
    expect((preview as HTMLCanvasElement).width).toBe(1);
    expect((preview as HTMLCanvasElement).height).toBe(1);
    expect((preview as HTMLCanvasElement).dataset.sessionDragPreviewTransparent).toBe('true');
    expect(document.querySelector('[data-session-drag-preview-transparent]')).toBe(preview);
    expect(beginPreview).toHaveBeenCalledWith('任务 A', 'session-a', 'device-b', PREVIEW_PALETTE);
    expect(document.querySelector('[data-session-drag-preview-palette-probe]')).toBeNull();

    window.dispatchEvent(new Event('pointerup'));
    window.dispatchEvent(new Event('dragend'));
    expect(row.dataset.sessionDragging).toBeUndefined();
    expect(endPreview).toHaveBeenCalledOnce();
    expect(endPreview).toHaveBeenCalledWith(expect.any(Number));
    expect(openOutside).toHaveBeenCalledWith('session-a', 'device-b');
    expect(document.querySelector('[data-session-drag-preview-transparent]')).toBeNull();
    if (electronApiDescriptor) {
      Object.defineProperty(window, 'electronAPI', electronApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });

  it('macOS waits for the native mouse-up path before ending the drag', () => {
    const row = document.createElement('div');
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
      setDragImage: vi.fn(),
    };
    const beginPreview = vi.fn().mockResolvedValue(undefined);
    const endPreview = vi.fn();
    const openOutside = vi.fn().mockResolvedValue(false);
    const electronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        platform: 'darwin',
        maker: {
          beginSessionDragPreview: beginPreview,
          endSessionDragPreview: endPreview,
          openSessionInNewWindowIfDroppedOutside: openOutside,
        },
      },
    });

    startSessionDrag(
      {
        target: row,
        currentTarget: row,
        dataTransfer,
        preventDefault: vi.fn(),
      },
      {
        sessionId: 'session-a',
        enabled: true,
        needsDedicatedHandle: false,
      },
    );
    window.dispatchEvent(new Event('pointerup'));
    expect(endPreview).not.toHaveBeenCalled();
    expect(openOutside).not.toHaveBeenCalled();

    window.dispatchEvent(new Event('dragend'));
    expect(endPreview).toHaveBeenCalledOnce();
    expect(openOutside).toHaveBeenCalledWith('session-a', undefined);
    if (electronApiDescriptor) {
      Object.defineProperty(window, 'electronAPI', electronApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'electronAPI');
    }
  });

  it('按 Escape 取消原生拖拽时不会请求窗口外开窗', () => {
    mockPreviewPalette();
    const row = document.createElement('div');
    const dataTransfer = {
      effectAllowed: 'none',
      setData: vi.fn(),
    };
    const openOutside = vi.fn().mockResolvedValue(false);
    const beginPreview = vi.fn().mockResolvedValue(undefined);
    const endPreview = vi.fn();
    const electronApiDescriptor = Object.getOwnPropertyDescriptor(window, 'electronAPI');
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        maker: {
          beginSessionDragPreview: beginPreview,
          endSessionDragPreview: endPreview,
          openSessionInNewWindowIfDroppedOutside: openOutside,
        },
      },
    });

    startSessionDrag(
      {
        target: row,
        currentTarget: row,
        dataTransfer,
        preventDefault: vi.fn(),
      },
      {
        sessionId: 'session-a',
        enabled: true,
        needsDedicatedHandle: false,
      },
    );
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    finishSessionDrag({ currentTarget: row }, 'session-a');

    expect(beginPreview).toHaveBeenCalledWith('session-a', 'session-a', undefined, PREVIEW_PALETTE);
    expect(endPreview).toHaveBeenCalledOnce();
    expect(endPreview).toHaveBeenCalledWith(expect.any(Number));
    expect(openOutside).not.toHaveBeenCalled();
    if (electronApiDescriptor) {
      Object.defineProperty(window, 'electronAPI', electronApiDescriptor);
    } else {
      Reflect.deleteProperty(window, 'electronAPI');
    }
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
