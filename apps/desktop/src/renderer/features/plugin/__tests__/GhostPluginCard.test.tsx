/**
 * Regression coverage for installed Plugin card actions (redesigned card:
 * whole-card primary action, kind-specific primary button, manage entry),
 * market card actions, and the legacy recovery notice.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // 页面经批量更新控制器引 @/i18n,其 init 链路需要这些导出。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, mode: 'signed-out', dataOwnerId: null }),
}));

import {
  GhostPluginCard,
  MarketPluginCard,
  LegacyGhostRecoveryNotice,
} from '../GhostPluginPage';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

const commandPlugin: GhostPluginListItem = {
  id: 'filo-google',
  name: 'Filo Google',
  description: 'Google services',
  version: '1.0.0',
  enabled: true,
  canUse: true,
  tabPanel: false,
};

const panelPlugin: GhostPluginListItem = {
  ...commandPlugin,
  id: 'signoff-board',
  name: 'Signoff Board',
  tabPanel: true,
};

const toolPlugin: GhostPluginListItem = {
  ...commandPlugin,
  id: 'pure-tool',
  name: 'Pure Tool',
  canUse: false,
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

describe('GhostPluginCard', () => {
  it('fires the primary action from the whole card for a command plugin', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={commandPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Filo Google' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();
    // 指令型主按钮 = 「对话」。
    expect(screen.getByRole('button', { name: 'settings.ghosts.page.chatAria' })).toBeTruthy();
  });

  it('labels the primary button 使用 for a tab-panel plugin', () => {
    const onPrimary = vi.fn();
    render(<GhostPluginCard item={panelPlugin} onPrimary={onPrimary} onManage={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.useAria' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
  });

  it('routes the manage icon to detail without firing the primary action', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={commandPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.manageAria' }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('shows the update pill and keeps it from triggering the card action', () => {
    const onPrimary = vi.fn();
    const onUpdate = vi.fn();
    render(
      <GhostPluginCard
        item={commandPlugin}
        updateVersion="1.1.0"
        onPrimary={onPrimary}
        onManage={vi.fn()}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.updateAria' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
    // 有更新时不显示「已是最新」。
    expect(screen.queryByText(/upToDate/)).toBeNull();
  });

  it('blocks the update pill while a market operation is running', () => {
    render(
      <GhostPluginCard
        item={commandPlugin}
        updateVersion="1.1.0"
        updateBusy
        onPrimary={vi.fn()}
        onManage={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.page.updateAria',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('sends a tool-only plugin to manage and renders no primary button', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={toolPlugin} onPrimary={onPrimary} onManage={onManage} />);

    expect(screen.getByText('settings.ghosts.page.agentInvoked')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Pure Tool' }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('sends a disabled plugin to manage and shows no enable switch on the card', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(
      <GhostPluginCard
        item={{ ...commandPlugin, enabled: false }}
        effectiveEnabled={false}
        onPrimary={onPrimary}
        onManage={onManage}
      />,
    );

    // 启用开关收进详情页(设计定稿):卡片上不再有 switch。
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filo Google' }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: 'settings.ghosts.page.manageAction' }),
    ).toBeTruthy();
  });

  it('routes projected icon failures to market recovery', () => {
    const onIconLoadError = vi.fn();
    const projected = {
      ...commandPlugin,
      iconDataUrl: 'https://plugins.example.invalid/icon.png?signature=current',
    };
    const { container } = render(
      <GhostPluginCard
        item={projected}
        onPrimary={vi.fn()}
        onManage={vi.fn()}
        onIconLoadError={onIconLoadError}
      />,
    );

    fireEvent.error(container.querySelector('img') as HTMLImageElement);
    expect(onIconLoadError).toHaveBeenCalledTimes(1);
  });

  it('renders a functional media symbol when the plugin package has no icon', () => {
    const { container } = render(
      <GhostPluginCard
        item={{ ...commandPlugin, id: 'lizi-mivo', name: 'Lizi Mivo' }}
        onPrimary={vi.fn()}
        onManage={vi.fn()}
      />,
    );

    expect(container.querySelector('.lucide-image')).toBeTruthy();
    expect(screen.queryByText('M')).toBeNull();
  });

  it('renders the Mermaid fallback symbol on the theme elevated surface', () => {
    const { container } = render(
      <GhostPluginCard
        item={{ ...commandPlugin, id: 'cindy-mermaid', name: 'Cindy Mermaid' }}
        onPrimary={vi.fn()}
        onManage={vi.fn()}
      />,
    );

    const fallbackIcon = container.querySelector('.lucide-workflow');
    expect(fallbackIcon).toBeTruthy();
    expect(fallbackIcon?.parentElement?.className).toContain('var(--surface-elevated)');
  });
});

describe('MarketPluginCard', () => {
  it('exposes both 详情 and 安装 actions for a not-installed plugin', () => {
    const onSelect = vi.fn();
    const onInstall = vi.fn();
    render(
      <MarketPluginCard
        item={marketPlugin}
        busy={false}
        onSelect={onSelect}
        onInstall={onInstall}
        onIconLoadError={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.installAria' }));
    expect(onInstall).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByText('settings.ghosts.market.details'));
    expect(onSelect).toHaveBeenCalledTimes(1);
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
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const cardBody = screen.getByRole('button', { name: 'Google Calendar' });
    expect((cardBody as HTMLButtonElement).disabled).toBe(true);
    expect(cardBody.className).toContain('disabled:cursor-not-allowed');
    expect(cardBody.className).not.toContain('disabled:cursor-wait');
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.page.installAria',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    rerender(
      <MarketPluginCard
        item={marketPlugin}
        busy
        onSelect={vi.fn()}
        onInstall={vi.fn()}
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
