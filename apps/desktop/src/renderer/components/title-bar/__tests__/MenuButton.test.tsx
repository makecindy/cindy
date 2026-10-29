// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

const approvals = vi.hoisted(() => ({ ids: [] as string[], navigate: vi.fn() }));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  useNavigate: () => approvals.navigate,
}));

vi.mock('@/lib/checkForUpdateWithToast', () => ({
  checkForUpdateWithToast: vi.fn(),
}));

import { MenuButton } from '@/components/title-bar/MenuButton';
vi.mock('@/features/device-link/useSharedTaskTasks', () => ({ useSharedTaskTasks: vi.fn() }));
vi.mock('@/features/device-link/JoinSharedTaskDialog', () => ({ JoinSharedTaskDialog: () => null }));
vi.mock('@/features/device-link/SharedTaskEndedNotice', () => ({ SharedTaskEndedNotice: () => null }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  approvals.ids = [];
});

describe('MenuButton tooltip and dropdown interaction', () => {
  it('dismisses the tooltip when the menu opens', async () => {
    const user = userEvent.setup();
    render(<MenuButton />);

    const trigger = screen.getByRole('button', { name: 'titleBar.menu' });
    await user.hover(trigger);

    expect((await screen.findByRole('tooltip')).textContent).toContain('titleBar.menu');

    await user.click(trigger);

    expect(screen.getByRole('menu')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('tooltip')).toBeNull());
  });
});

vi.mock('@/features/approvals/useApprovalSessionIds', () => ({ useApprovalSessionIds: () => approvals.ids }));

/**
 * Approval inbox (#7695): the title bar must show that approvals are waiting from any page without
 * widening the 28 px menu button (the chrome cluster geometry and its no-drag holes depend on it).
 */
describe('MenuButton approvals indicator', () => {
  it('shows no indicator and keeps the plain label when nothing is waiting', () => {
    render(<MenuButton />);
    expect(screen.getByRole('button', { name: 'titleBar.menu' })).toBeTruthy();
    expect(screen.queryByTestId('approvals-indicator')).toBeNull();
  });

  it('shows the waiting count on the menu button, capped at 99+, and names it for assistive tech', () => {
    approvals.ids = ['a', 'b', 'c'];
    const { rerender } = render(<MenuButton />);
    expect(screen.getByTestId('approvals-indicator').textContent).toBe('3');
    expect(screen.getByRole('button', { name: 'approvalsInbox.menuButtonLabel' })).toBeTruthy();
    approvals.ids = Array.from({ length: 120 }, (_, i) => String(i));
    rerender(<MenuButton />);
    expect(screen.getByTestId('approvals-indicator').textContent).toBe('99+');
  });

  it('keeps the menu entry with its count and opens the inbox from it', async () => {
    approvals.ids = ['a', 'b'];
    const user = userEvent.setup();
    render(<MenuButton />);
    await user.click(screen.getByRole('button', { name: 'approvalsInbox.menuButtonLabel' }));
    const item = screen.getByRole('menuitem', { name: /approvalsInbox.title/ });
    expect(item.textContent).toContain('2');
    await user.click(item);
    expect(approvals.navigate).toHaveBeenCalledWith('/approvals');
  });
});
