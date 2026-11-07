// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TabDragController } from '../TabDragController';

vi.mock('../moveTab', () => ({ moveTabToGroup: vi.fn() }));

/**
 * 拖页签期间按 Esc：取消拖动，并把这次按键标记为已处理，其它只接「无人认领」Esc
 * 的处理者（决策卡片、侧栏「自定义」面板）不会被同一次按键一起触发。
 */
function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

afterEach(cleanup);

describe('TabDragController Esc', () => {
  it('Esc 取消拖页签时标记为已处理，后续的 window 监听看到 defaultPrevented', () => {
    const { getByTestId } = render(
      <div>
        <div data-tab-group-strip="right" data-testid="strip">
          <div data-tab-pill="files" data-testid="pill">Files</div>
        </div>
        <div data-panel-drag-root="chat-main" data-testid="chat" />
        <TabDragController sessionId="s1" enabled />
      </div>,
    );
    getByTestId('strip').getBoundingClientRect = () => rect(800, 0, 400, 32);
    getByTestId('chat').getBoundingClientRect = () => rect(0, 0, 800, 800);

    act(() => {
      fireEvent.pointerDown(getByTestId('pill'), { button: 0, clientX: 820, clientY: 16 });
      // Leaving the tab strip turns the press into a drag.
      fireEvent.pointerMove(document, { clientX: 400, clientY: 400 });
    });
    expect(document.body.classList.contains('resizing-pane')).toBe(true);

    const seen = vi.fn((event: KeyboardEvent) => event.defaultPrevented);
    window.addEventListener('keydown', seen);
    try {
      act(() => {
        fireEvent.keyDown(document.body, { key: 'Escape' });
      });
      expect(document.body.classList.contains('resizing-pane')).toBe(false);
      expect(seen).toHaveReturnedWith(true);
      // 拖动结束后不再接管 Esc。
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(seen).toHaveLastReturnedWith(false);
    } finally {
      window.removeEventListener('keydown', seen);
    }
  });
});
