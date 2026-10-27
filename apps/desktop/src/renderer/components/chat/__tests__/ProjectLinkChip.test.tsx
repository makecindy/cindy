// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), focus: vi.fn(), writeText: vi.fn() }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useLocation: () => ({ pathname: '/settings' }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/state/pendingProjectFocus', () => ({ requestProjectFocus: mocks.focus }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { ProjectLinkChip } from '../ProjectLinkChip';
import { SessionNavigationModeProvider } from '@/features/cc-agent/embeddedSessionNavigation';

const href = 'cindy://project/%2Fwork%2FMy%20Project';
beforeEach(() => {
  vi.clearAllMocks();
  mocks.writeText.mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: mocks.writeText },
  });
});
afterEach(cleanup);

describe('ProjectLinkChip actions', () => {
  it('keeps normal activation focused on the project', () => {
    render(<ProjectLinkChip href={href} />);
    fireEvent.click(screen.getByRole('button', { name: 'My Project' }));
    expect(mocks.focus).toHaveBeenCalledWith('/work/My Project');
    expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent');
  });

  it('copies a project link from the keyboard menu without navigating', async () => {
    render(<ProjectLinkChip href={href} />);
    fireEvent.keyDown(screen.getByRole('button', { name: 'My Project' }), { key: 'ContextMenu' });
    fireEvent.click(
      await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyLink' }),
    );
    await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(href));
    expect(mocks.focus).not.toHaveBeenCalled();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it.each(['pointer', 'ContextMenu', 'Shift+F10'])(
    'offers embedded copy via %s without advertising a primary action',
    async (gesture) => {
      render(
        <SessionNavigationModeProvider mode="sidebar-embedded">
          <ProjectLinkChip href={href} />
        </SessionNavigationModeProvider>,
      );
      const chip = screen
        .getByText('My Project')
        .closest('[data-inline-reference-chip]') as HTMLElement;
      expect(screen.queryByRole('button', { name: 'My Project' })).toBeNull();
      expect(chip.classList.contains('underline')).toBe(false);
      expect(chip.classList.contains('cursor-pointer')).toBe(false);
      expect(chip.tabIndex).toBe(0);
      act(() => chip.focus());
      fireEvent.click(chip);
      fireEvent.keyDown(chip, { key: 'Enter' });
      fireEvent.keyDown(chip, { key: ' ' });
      expect(screen.queryByRole('menu')).toBeNull();
      if (gesture === 'pointer') fireEvent.contextMenu(chip);
      else
        fireEvent.keyDown(chip, {
          key: gesture === 'ContextMenu' ? 'ContextMenu' : 'F10',
          shiftKey: gesture === 'Shift+F10',
        });
      const copy = await screen.findByRole('menuitem', { name: 'chat.markdownRenderer.copyLink' });
      expect(
        screen.queryByRole('menuitem', { name: 'chat.markdownRenderer.locateProject' }),
      ).toBeNull();
      fireEvent.click(copy);
      await waitFor(() => expect(mocks.writeText).toHaveBeenCalledWith(href));
      await waitFor(() => expect(document.activeElement).toBe(chip));
      expect(mocks.focus).not.toHaveBeenCalled();
      expect(mocks.navigate).not.toHaveBeenCalled();
    },
  );
});
