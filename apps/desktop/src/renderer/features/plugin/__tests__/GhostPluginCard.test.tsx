/**
 * Regression coverage for Plugin card actions, compact metadata, and queue focus continuity.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useState, type ReactNode } from 'react';

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

import {
  GhostPluginCard,
  InstalledGhostQueue,
  InstalledGhostShortcut,
  MarketPluginCard,
  LegacyGhostRecoveryNotice,
} from '../GhostPluginPage';
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
  sourceType: 'server',
  sourceMarketName: null,
};

function InstalledQueueHarness({ items }: { items: readonly GhostPluginListItem[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <InstalledGhostQueue
      items={items}
      expanded={expanded}
      onExpandedChange={setExpanded}
      onSelect={vi.fn()}
    />
  );
}

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

  it('puts the collapse control after every installed plugin in the expanded queue', () => {
    const plugins = Array.from({ length: 7 }, (_, index) => ({
      ...installedPlugin,
      id: `plugin-${index + 1}`,
      name: `Plugin ${index + 1}`,
    }));
    const { container } = render(<InstalledQueueHarness items={plugins} />);

    expect(screen.getByRole('button', { name: 'Plugin 5' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Plugin 6' })).toBeNull();

    const expand = screen.getByRole('button', {
      name: 'settings.ghosts.page.installedExpand',
    });
    expand.focus();
    fireEvent.click(expand);

    const queue = container.querySelector('[data-testid="installed-plugin-queue"]');
    const collapse = screen.getByRole('button', {
      name: 'settings.ghosts.page.installedCollapse',
    });
    expect(screen.getByRole('button', { name: 'Plugin 7' })).toBeTruthy();
    expect(queue?.lastElementChild).toBe(collapse);
    expect(within(collapse).queryByText('+2')).toBeNull();
    expect(collapse.querySelector('.lucide-chevron-up')).toBeTruthy();
    expect(document.activeElement).toBe(collapse);

    fireEvent.click(collapse);
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'settings.ghosts.page.installedExpand' }),
    );
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

  it('routes projected icon failures from installed cards and shortcuts to market recovery', () => {
    const onIconLoadError = vi.fn();
    const projected = {
      ...installedPlugin,
      iconDataUrl: 'https://plugins.example.invalid/icon.png?signature=current',
    };
    const { container, rerender } = render(
      <GhostPluginCard
        item={projected}
        onSelect={vi.fn()}
        onAction={vi.fn()}
        onIconLoadError={onIconLoadError}
      />,
    );

    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(onIconLoadError).toHaveBeenCalledTimes(1);

    rerender(
      <InstalledGhostQueue
        items={[projected]}
        expanded={false}
        onExpandedChange={vi.fn()}
        onSelect={vi.fn()}
        onIconLoadError={onIconLoadError}
      />,
    );
    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(onIconLoadError).toHaveBeenCalledTimes(2);
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

  it('distinguishes unavailable conflicts from busy market operations', () => {
    const { rerender } = render(
      <MarketPluginCard
        item={{ ...marketPlugin, installState: 'conflict' }}
        busy={false}
        onSelect={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const cardBody = screen.getByRole('button', { name: 'Google Calendar' });
    expect((cardBody as HTMLButtonElement).disabled).toBe(true);
    expect(cardBody.className).toContain('disabled:cursor-not-allowed');
    expect(cardBody.className).not.toContain('disabled:cursor-wait');

    rerender(
      <MarketPluginCard
        item={marketPlugin}
        busy
        onSelect={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const busyCardBody = screen.getByRole('button', { name: 'Google Calendar' });
    expect((busyCardBody as HTMLButtonElement).disabled).toBe(true);
    expect(busyCardBody.className).toContain('disabled:cursor-wait');
    expect(busyCardBody.className).not.toContain('disabled:cursor-not-allowed');
  });
});

describe('LegacyGhostRecoveryNotice', () => {
  it('shows a retry action for deferred recovery', () => {
    const onRetry = vi.fn();
    render(
      <LegacyGhostRecoveryNotice
        status={{ state: 'deferred', legacyPluginCount: 2, canRetry: true }}
        retrying={false}
        onRetry={onRetry}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.legacyRecovery.retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByText('settings.ghosts.legacyRecovery.partial')).toBeTruthy();
  });

  it('renders nothing for the none state', () => {
    const { container } = render(
      <LegacyGhostRecoveryNotice
        status={{ state: 'none', legacyPluginCount: 0, canRetry: false }}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );

    expect(container.firstChild).toBeNull();
  });

  it('does not offer retry for data claimed by another owner', () => {
    render(
      <LegacyGhostRecoveryNotice
        status={{ state: 'claimed-by-other-owner', legacyPluginCount: 1, canRetry: false }}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );

    expect(screen.getByText('settings.ghosts.legacyRecovery.claimedByOtherOwner')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('does not offer retry when every legacy plugin has a destination conflict', () => {
    render(
      <LegacyGhostRecoveryNotice
        status={{ state: 'partial', legacyPluginCount: 2, canRetry: false }}
        retrying={false}
        onRetry={vi.fn()}
      />,
    );

    expect(
      screen.getByText('settings.ghosts.legacyRecovery.partialBlocked'),
    ).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
