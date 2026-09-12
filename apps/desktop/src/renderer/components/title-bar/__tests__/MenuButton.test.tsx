// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/checkForUpdateWithToast', () => ({
  checkForUpdateWithToast: vi.fn(),
}));

import { MenuButton } from '@/components/title-bar/MenuButton';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
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
