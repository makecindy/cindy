// @vitest-environment jsdom

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { RightSidebarToggle } from '../RightSidebarToggle';

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
});
