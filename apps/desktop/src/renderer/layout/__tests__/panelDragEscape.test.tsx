// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDefaultLayout } from '../../../shared/layoutTree';
import { PanelDragController } from '../PanelDragController';

// A stable t, like the real hook: the controller's effect depends on it.
const i18n = vi.hoisted(() => ({ t: (key: string) => key }));
vi.mock('react-i18next', () => ({ useTranslation: () => i18n }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

/**
 * 拖面板换位期间按 Esc：取消拖动，并把这次按键标记为已处理，其它只接「无人认领」
 * Esc 的处理者（决策卡片、侧栏「自定义」面板）不会被同一次按键一起触发。
 */
function sizedRect(left: number): DOMRect {
  return {
    left, top: 0, width: 600, height: 600, right: left + 600, bottom: 600, x: left, y: 0,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    layout: {
      getStateSync: () => ({ layout: createDefaultLayout() }),
      set: vi.fn(() => Promise.resolve({ persisted: true })),
    },
  };
});

afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const rowRef = createRef<HTMLDivElement>();
const sidebarBlockRef = createRef<HTMLDivElement>();

describe('PanelDragController Esc', () => {
  it('Esc 取消拖动时标记为已处理，后续的 window 监听看到 defaultPrevented', () => {
    const { getByTestId } = render(
      <div>
        <div data-panel-drag-root="chat-main" data-testid="chat">
          <div data-panel-drag-handle data-testid="handle" />
        </div>
        <div data-panel-drag-root="right-tabs" data-testid="tools" />
        <PanelDragController rowRef={rowRef} sidebarBlockRef={sidebarBlockRef} enabled />
      </div>,
    );
    getByTestId('chat').getBoundingClientRect = () => sizedRect(0);
    getByTestId('tools').getBoundingClientRect = () => sizedRect(600);

    act(() => {
      fireEvent.pointerDown(getByTestId('handle'), { button: 0, clientX: 10, clientY: 10 });
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
