/**
 * Regression coverage for Plugin card actions and compact marketplace metadata.
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

import { GhostPluginCard, InstalledGhostShortcut, MarketPluginCard } from '../GhostPluginPage';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

const installedPlugin: GhostPluginListItem = {
  id: 'filo-google',
  name: 'Filo Google',
  description: 'Google services',
  version: '1.0.0',
  enabled: true,
  canUse: true,
};

const marketPlugin: PluginMarketItem = {
  pluginId: 'release-google-calendar',
  ghostId: 'google-calendar',
  name: 'Google Calendar',
  description: 'Connect Google Calendar',
  author: 'Cindy',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'release-1',
  version: '1.3.11',
  publishedAt: '2026-07-25T00:00:00.000Z',
  icon: null,
  installState: 'not-installed',
  enabled: null,
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

  it('keeps fixed market metadata on one line while truncating long identities', () => {
    render(
      <MarketPluginCard
        item={marketPlugin}
        busy={false}
        onSelect={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const origin = screen.getByText('settings.ghosts.page.origin.public');
    const metadata = origin.parentElement;
    expect(metadata?.className).toContain('whitespace-nowrap');
    expect(metadata?.className).toContain('overflow-hidden');
    expect(origin.className).toContain('shrink-0');
    expect(screen.getByText('v1.3.11').className).toContain('shrink-0');
    expect(screen.getByText('google-calendar').className).toContain('truncate');
    expect(screen.getByText('google-calendar').className).toContain('min-w-0');
    expect(screen.getByText('Cindy').className).toContain('truncate');
  });
});
