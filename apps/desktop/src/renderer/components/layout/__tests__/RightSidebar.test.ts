// @vitest-environment jsdom

import { createElement, createRef, type ComponentProps, type Ref } from 'react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/features/right-sidebar/RightSidebarShell', () => ({
  RightSidebarShell: () => null,
}));

import { CHAT_AREA_MIN_WIDTH } from '@/hooks/useRightSidebarResize';
import { RightSidebar, type RightSidebarHandle } from '../RightSidebar';

function renderSidebar(
  props: Partial<ComponentProps<typeof RightSidebar>> = {},
  ref?: Ref<RightSidebarHandle>,
) {
  return render(
    createElement(RightSidebar, {
      isCollapsed: false,
      width: 320,      isMac: false,
      onCloseSidebar: vi.fn(),
      onMaximize: vi.fn(),
      isMaximized: false,
      sessionId: 'session-a',
      workdir: '/repo',
      remoteHostId: null,
      ...props,
      ref,
    }),
  );
}

function getSidebar(): HTMLElement {
  return screen.getByLabelText('rightSidebar.ariaLabel');
}

function getContent(sidebar = getSidebar()): HTMLElement {
  const content = sidebar.firstElementChild;
  if (!(content instanceof HTMLElement)) throw new Error('missing right sidebar content');
  return content;
}

describe('RightSidebar width guard', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) =>
      window.setTimeout(() => cb(performance.now()), 0),
    );
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps non-maximized width as a shrinkable preferred width', () => {
    renderSidebar({ width: 320 });

    const sidebar = getSidebar();
    const content = getContent(sidebar);

    expect(sidebar.style.width).toBe('320px');
    expect(sidebar.style.flexBasis).toBe('');
    expect(sidebar.style.flexShrink).toBe('1');
    expect(sidebar.style.maxWidth).toBe(
      `max(0px, calc(100% - var(--layout-chat-min, ${CHAT_AREA_MIN_WIDTH}px)))`,
    );
    expect(sidebar.className).toContain('min-w-0');
    expect(sidebar.className).toContain('max-w-full');
    expect(content.className).toContain('w-full');
    expect(content.className).toContain('min-h-0');
    expect(content.className).toContain('overflow-hidden');
    expect(content.style.width).toBe('');
  });

  it('keeps the Windows titlebar spacer fixed so tall review content cannot squeeze chrome', () => {
    renderSidebar({ isMac: false });

    const spacer = screen.getByTestId('right-sidebar-titlebar-spacer');
    // 46px:随 #650 全局 chrome 行高 50→46(该改动当时漏更本断言,长期红着)。
    expect(spacer.className).toContain('h-[46px]');
    expect(spacer.className).toContain('shrink-0');
    expect(spacer.className).toContain('flex-none');
  });

  it('does not render the old titlebar spacer on mac because the shell owns the unified topbar', () => {
    renderSidebar({ isMac: true });

    expect(screen.queryByTestId('right-sidebar-titlebar-spacer')).toBeNull();
  });

  it('does not apply inline width in maximized mode', () => {
    renderSidebar({ width: 360, isMaximized: true });

    const sidebar = getSidebar();
    const content = getContent(sidebar);

    expect(sidebar.className).toContain('flex-1');
    expect(sidebar.style.width).toBe('');
    expect(sidebar.style.flexBasis).toBe('');
    expect(content.style.width).toBe('');
  });

  it('pins content width only during the collapse animation and clears it afterwards', () => {
    const ref = createRef<RightSidebarHandle>();
    const view = renderSidebar({ width: 320, isCollapsed: false }, ref);
    const sidebar = getSidebar();
    vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      width: 300,
      height: 600,
      top: 0,
      right: 300,
      bottom: 600,
      left: 0,
      toJSON: () => ({}),
    });

    act(() => {
      ref.current?.requestAnimateNextChange();
      view.rerender(
        createElement(RightSidebar, {
          isCollapsed: true,
          width: 320,          isMac: false,
          onCloseSidebar: vi.fn(),
          onMaximize: vi.fn(),
          isMaximized: false,
          sessionId: 'session-a',
          workdir: '/repo',
          remoteHostId: null,
          ref,
        }),
      );
    });

    expect(getContent(sidebar).style.width).toBe('300px');

    act(() => {
      vi.advanceTimersByTime(0);
    });
    expect(getContent(sidebar).style.width).toBe('300px');

    act(() => {
      vi.advanceTimersByTime(280);
    });
    expect(getContent(sidebar).style.width).toBe('');
  });
});
