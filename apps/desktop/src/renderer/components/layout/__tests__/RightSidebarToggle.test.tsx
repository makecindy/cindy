// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { RightSidebarToggle } from '../RightSidebarToggle';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RightSidebarToggle', () => {
  it.each([true, false])(
    'uses one stable show label for the fixed trigger when collapsed=%s',
    (collapsed) => {
      const onToggle = vi.fn();
      render(
        <RightSidebarToggle
          action="show"
          collapsed={collapsed}
          onToggle={onToggle}
        />,
      );

      const button = screen.getByRole('button', {
        name: 'rightSidebar.tabs.controls.showAria',
      });
      expect(button.getAttribute('title')).toBeNull();
      fireEvent.click(button);
      expect(onToggle).toHaveBeenCalledOnce();
    },
  );

  it('keeps the panel-owned toggle labels stateful', () => {
    const { rerender } = render(
      <RightSidebarToggle collapsed onToggle={vi.fn()} />,
    );
    expect(screen.getByRole('button', { name: 'contentHeader.expandPanel' })).toBeTruthy();

    rerender(<RightSidebarToggle collapsed={false} onToggle={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'contentHeader.collapsePanel' })).toBeTruthy();
  });

  // Long press is a separate activation from the click toggle; a missing click
  // guard would both toggle the panel and persist the new state.
  function renderLongPressToggle() {
    const onToggle = vi.fn();
    const onLongPress = vi.fn();
    const view = render(
      <RightSidebarToggle
        collapsed
        onToggle={onToggle}
        onLongPress={onLongPress}
      />,
    );
    return { button: view.getByRole('button'), onToggle, onLongPress };
  }

  function pointerDown(button: HTMLElement) {
    fireEvent.pointerDown(button, {
      button: 0,
      pointerId: 1,
      isPrimary: true,
      clientX: 1,
      clientY: 1,
    });
  }

  it('keeps a short press as a normal toggle', () => {
    const { button, onToggle, onLongPress } = renderLongPressToggle();
    pointerDown(button);
    fireEvent.pointerUp(button, { pointerId: 1 });
    fireEvent.click(button);
    expect(onToggle).toHaveBeenCalledTimes(1);
    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('activates persistence after two seconds and suppresses the release click', () => {
    vi.useFakeTimers();
    const { button, onToggle, onLongPress } = renderLongPressToggle();
    pointerDown(button);
    act(() => vi.advanceTimersByTime(2000));
    expect(onLongPress).toHaveBeenCalledTimes(1);
    fireEvent.pointerUp(button, { pointerId: 1 });
    fireEvent.click(button);
    expect(onToggle).not.toHaveBeenCalled();
  });
});
