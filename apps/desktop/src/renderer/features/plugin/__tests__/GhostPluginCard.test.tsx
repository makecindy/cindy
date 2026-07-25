/**
 * Regression coverage for installed Plugin card actions.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, mode: 'signed-out', dataOwnerId: null }),
}));
vi.mock('@/components/ui/tooltip', () => ({
  Tip: ({ text, children }: { text: string; children: ReactNode }) => (
    <span data-tooltip={text}>{children}</span>
  ),
}));

import { GhostPluginCard, InstalledGhostShortcut } from '../GhostPluginPage';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';

const installedPlugin: GhostPluginListItem = {
  id: 'filo-google',
  name: 'Filo Google',
  description: 'Google services',
  version: '1.0.0',
  enabled: true,
  canUse: true,
};

describe('GhostPluginCard', () => {
  it('shows the installed shortcut name through the shared Tooltip', () => {
    const onSelect = vi.fn();
    const { container } = render(
      <InstalledGhostShortcut item={installedPlugin} onSelect={onSelect} />,
    );

    const button = screen.getByRole('button', { name: 'Filo Google' });
    expect(container.querySelector('[data-tooltip="Filo Google"]')).toBeTruthy();
    expect(button.getAttribute('title')).toBeNull();
    fireEvent.click(button);
    expect(onSelect).toHaveBeenCalledWith('filo-google');
  });

  it('opens the plugin detail from the card body without firing the action', () => {
    const onSelect = vi.fn();
    const onAction = vi.fn();
    render(<GhostPluginCard item={installedPlugin} onSelect={onSelect} onAction={onAction} />);

    const detailButton = screen.getByRole('button', { name: 'Filo Google' });
    fireEvent.click(detailButton);

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
  });

  it('surfaces the market update state with a badge and a direct update action', () => {
    const onAction = vi.fn();
    const onUpdate = vi.fn();
    render(
      <GhostPluginCard
        item={installedPlugin}
        onSelect={vi.fn()}
        onAction={onAction}
        onUpdate={onUpdate}
        updateVersion="1.1.1"
      />,
    );

    expect(screen.getByText('settings.ghosts.market.updateAvailable')).toBeTruthy();
    // Metadata keeps only the installed version; the pending version stays out of
    // the crowded metadata row (surfaced by the badge and the detail header instead).
    expect(screen.getByText('v1.0.0')).toBeTruthy();
    expect(screen.queryByText('v1.1.1')).toBeNull();

    const updateButton = screen.getByRole('button', {
      name: 'settings.ghosts.market.updateAria',
    });
    fireEvent.click(updateButton);
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onAction).not.toHaveBeenCalled();
    // The direct Use entry is replaced by Update while a new release is pending.
    expect(screen.queryByRole('button', { name: 'settings.ghosts.page.useAria' })).toBeNull();
  });

  it('keeps the update action interactive while Use is locked, and blocks it when busy', () => {
    const onUpdate = vi.fn();
    render(
      <GhostPluginCard
        item={{ ...installedPlugin, enabled: false, canUse: false }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        onUpdate={onUpdate}
        updateVersion="1.1.1"
        updateBusy
      />,
    );

    const updateButton = screen.getByRole('button', {
      name: 'settings.ghosts.market.updateAria',
    }) as HTMLButtonElement;
    expect(updateButton.disabled).toBe(true);
    fireEvent.click(updateButton);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('disables Use when an installed plugin has no command', () => {
    render(
      <GhostPluginCard
        item={{ ...installedPlugin, canUse: false }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(
      (screen.getByRole('button', { name: 'settings.ghosts.page.useAria' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  it('renders project-scope enabled state and respects the global-disabled lock', () => {
    render(
      <GhostPluginCard
        item={{ ...installedPlugin, enabled: false, canUse: false }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        onToggle={vi.fn()}
        effectiveEnabled={false}
        toggleDisabled
      />,
    );

    const toggle = screen.getByRole('switch', { name: 'settings.ghosts.enableAria' });
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(toggle.getAttribute('data-state')).toBe('unchecked');
  });

  it('renders a functional media symbol when the plugin package has no icon', () => {
    const { container } = render(
      <GhostPluginCard
        item={{ ...installedPlugin, id: 'lizi-mivo', name: 'Lizi Mivo' }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    expect(container.querySelector('.lucide-image')).toBeTruthy();
    expect(screen.queryByText('M')).toBeNull();
  });

  it('renders the Mermaid fallback symbol on the theme elevated surface', () => {
    const { container } = render(
      <GhostPluginCard
        item={{ ...installedPlugin, id: 'cindy-mermaid', name: 'Cindy Mermaid' }}
        onSelect={vi.fn()}
        onAction={vi.fn()}
      />,
    );

    const fallbackIcon = container.querySelector('.lucide-workflow');
    expect(fallbackIcon).toBeTruthy();
    expect(fallbackIcon?.parentElement?.className).toContain('var(--surface-elevated)');
  });
});
