// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { anySessionInTurn } = vi.hoisted(() => ({
  anySessionInTurn: vi.fn<() => Promise<boolean>>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/hooks/useUpdateStatus', () => ({
  useUpdateStatus: () => ({
    status: 'ready',
    version: '1.2.3',
    errorCode: null,
  }),
}));

vi.mock('@/hooks/useUpdateBannerDismiss', () => ({
  useUpdateBannerDismiss: () => ({
    dismissed: false,
    dismiss: vi.fn(),
    restore: vi.fn(),
    isNewUpdateAfterDismiss: vi.fn(() => false),
  }),
}));

vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ children }: { children: React.ReactNode }) => children,
}));

import { UpdateBanner } from '@/components/sidebar/UpdateBanner';

beforeEach(() => {
  anySessionInTurn.mockReset();
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      anySessionInTurn,
      relaunchToUpdate: vi.fn(),
      clientEndpoints: { websiteUrl: 'https://cindy.ai' },
    } as unknown as Window['electronAPI'],
  });
});

afterEach(cleanup);

describe('UpdateBanner busy-turn restart hint', () => {
  it('shows the warning hint in the semantic warning color while any turn is running', async () => {
    anySessionInTurn.mockResolvedValue(true);
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    const hint = await screen.findByText('update.banner.confirmBusyHint');
    expect(anySessionInTurn).toHaveBeenCalledTimes(1);
    expect(hint.className).toContain('text-[var(--warning-fg)]');
  });

  it('keeps the existing neutral hint when no turn is running', async () => {
    anySessionInTurn.mockResolvedValue(false);
    render(<UpdateBanner isCollapsed={false} />);

    fireEvent.click(screen.getByRole('button', { name: 'update.banner.ariaExpanded' }));

    await waitFor(() => expect(anySessionInTurn).toHaveBeenCalledTimes(1));
    const hint = screen.getByText('update.banner.confirmHint');
    expect(hint.className).toContain('text-sidebar-muted');
    expect(hint.className).not.toContain('text-[var(--warning-fg)]');
  });
});
