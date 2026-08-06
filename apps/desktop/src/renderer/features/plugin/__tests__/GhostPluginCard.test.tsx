/**
 * Coverage for installed Plugin card actions (redesigned 2026-08-06:
 * card body → detail, toggle switch for enable/disable, auth-status color),
 * market card actions, and the legacy recovery notice.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      (key === 'settings.ghosts.market.detailsAria' ||
        key === 'settings.ghosts.market.conflictAria') &&
      options?.name
        ? `${key}:${options.name}`
        : key,
  }),
  // 页面经批量更新控制器引 @/i18n,其 init 链路需要这些导出。
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: null, mode: 'signed-out', dataOwnerId: null }),
}));

import {
  __installedPluginLayoutForTests,
  GhostPluginCard,
  LegacyGhostRecoveryNotice,
  MarketPluginCard,
} from '../GhostPluginPage';
import {
  __ingestGhostBadgeForTest,
  __resetGhostUnreadForTest,
} from '@/cindy-brain/ghostUnreadStore';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

const {
  InstalledPluginDisclosure,
  InstalledPluginOverflow,
  MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS,
  MAX_VISIBLE_INSTALLED_PLUGINS,
  visibleInstalledPluginItems,
} = __installedPluginLayoutForTests;

const commandPlugin: GhostPluginListItem = {
  id: 'filo-google',
  name: 'Filo Google',
  description: 'Google services',
  version: '1.0.0',
  enabled: true,
  canUse: true,
  tabPanel: false,
hostCapability: null,
  hasSetupRequirements: false,
  setupReady: true,
  setupState: 'ready',
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

const simulatorPlugin: GhostPluginListItem = {
  ...toolPlugin,
  id: 'ios-simulator',
  name: 'iOS Simulator',
  hostCapability: 'ios-simulator',
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
  // 未读是模块级 store,用例间必须互不串味。
  afterEach(() => __resetGhostUnreadForTest());

  it('点击卡片主体进入详情(整卡可点)', () => {
    const onOpenDetail = vi.fn();
    render(
      <GhostPluginCard
        item={commandPlugin}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Filo Google' }));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });

  it('就绪插件右侧显示对话图标(MessageCircle)', () => {
    render(
      <GhostPluginCard
        item={commandPlugin}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

// 无开关;右侧是图标按钮,aria-label 走 chatAria。
    expect(screen.queryByRole('switch')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'settings.ghosts.page.chatAria' }),
    ).toBeTruthy();
  });

  it('offers a conversation entry for a Host capability plugin', () => {
    const onOpenDetail = vi.fn();
    render(
      <GhostPluginCard
        item={simulatorPlugin}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'iOS Simulator' }));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
  });
  });

  it('停用或未配置插件——停用时不显示右侧图标', () => {
    const { container } = render(
      <GhostPluginCard
        item={{ ...commandPlugin, enabled: false }}
        effectiveEnabled={false}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(screen.queryByRole('switch')).toBeNull();
    const buttonsInRight = container.querySelectorAll('article > span button');
    expect(buttonsInRight.length).toBe(0);
  });

  it('未配置授权时显示 Link 图标并走 manageAria', () => {
    render(
      <GhostPluginCard
        item={{ ...commandPlugin, hasSetupRequirements: true, setupReady: false }}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(
      screen.getByRole('button', { name: 'settings.ghosts.page.manageAria' }),
    ).toBeTruthy();
  });

  it('点击就绪插件的对话图标触发 onChat', () => {
    const onChat = vi.fn();
    render(
      <GhostPluginCard
        item={commandPlugin}
        onConfigure={vi.fn()}
        onChat={onChat}
        onOpenDetail={vi.fn()}
      />,
    );

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.ghosts.page.chatAria' }),
    );
    expect(onChat).toHaveBeenCalledTimes(1);
  });

  it('shows the update corner badge and keeps it from triggering the card action', () => {
    const onOpenDetail = vi.fn();
    const onUpdate = vi.fn();
    render(
      <GhostPluginCard
        item={commandPlugin}
        updateVersion="1.1.0"
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={onOpenDetail}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.updateAria' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onOpenDetail).not.toHaveBeenCalled();
  });

  it('blocks the update corner badge while a market operation is running', () => {
    render(
      <GhostPluginCard
        item={commandPlugin}
        updateVersion="1.1.0"
        updateBusy
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
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

  it('停用插件点击卡片同样进入详情', () => {
    const onOpenDetail = vi.fn();
    render(
      <GhostPluginCard
        item={{ ...commandPlugin, enabled: false }}
        effectiveEnabled={false}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={onOpenDetail}
      />,
    );

    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Filo Google' }));
    expect(onOpenDetail).toHaveBeenCalledTimes(1);
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
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
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
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    expect(container.querySelector('.lucide-image')).toBeTruthy();
    expect(screen.queryByText('M')).toBeNull();
  });

  it('renders the Mermaid fallback symbol on the theme elevated surface', () => {
    const { container } = render(
      <GhostPluginCard
        item={{ ...commandPlugin, id: 'cindy-mermaid', name: 'Cindy Mermaid' }}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );

    const fallbackIcon = container.querySelector('.lucide-workflow');
    expect(fallbackIcon).toBeTruthy();
    expect(fallbackIcon?.parentElement?.className).toContain('var(--surface-elevated)');
  });

  // ── 未读角标(badge 槽)────────────────────────────────────────────
  it('无未读时不画点,描述位仍是静态描述', () => {
    const { container } = render(
      <GhostPluginCard
        item={commandPlugin}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(container.querySelector('.session-card-dot')).toBeNull();
    expect(screen.getByText('Google services')).toBeTruthy();
  });

  it('有未读时:呼吸绿点 + 摘要顶替静态描述', () => {
    __ingestGhostBadgeForTest('filo-google', { unread: true, summary: '2 封新邮件', at: 1 });
    const { container } = render(
      <GhostPluginCard
        item={commandPlugin}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    const dot = container.querySelector('.session-card-dot');
    expect(dot).toBeTruthy();
    expect(dot?.className).toContain('var(--card-status-done)');
    expect(screen.getByText('2 封新邮件')).toBeTruthy();
    expect(screen.queryByText('Google services')).toBeNull();
  });

  it('有未读但插件没给摘要:只点亮,静态描述保留(不留空白)', () => {
    __ingestGhostBadgeForTest('filo-google', { unread: true, at: 1 });
    const { container } = render(
      <GhostPluginCard
        item={commandPlugin}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(container.querySelector('.session-card-dot')).toBeTruthy();
    expect(screen.getByText('Google services')).toBeTruthy();
  });

  it('未读只认本插件的 id:别的插件亮着不影响本卡', () => {
    __ingestGhostBadgeForTest('signoff-board', { unread: true, summary: '别人的', at: 1 });
    const { container } = render(
      <GhostPluginCard
        item={commandPlugin}
        onConfigure={vi.fn()}
        onChat={vi.fn()}
        onOpenDetail={vi.fn()}
      />,
    );
    expect(container.querySelector('.session-card-dot')).toBeNull();
    expect(screen.getByText('Google services')).toBeTruthy();
  });
});

describe('MarketPluginCard', () => {
  it('右侧显示 Plus 图标进入详情', () => {
    render(
      <MarketPluginCard
        item={marketPlugin}
        busy={false}
        onSelect={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const details = screen.getByRole('button', {
      name: 'settings.ghosts.market.detailsAria:Google Calendar',
    });
    expect(details.querySelector('.lucide-plus')).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.market.install')).toBeNull();
  });

  it('整卡可点 + Plus 都进入详情', () => {
    const onSelect = vi.fn();
    render(
      <MarketPluginCard
        item={marketPlugin}
        busy={false}
        onSelect={onSelect}
        onIconLoadError={vi.fn()}
      />,
    );

    const details = screen.getByRole('button', {
      name: 'settings.ghosts.market.detailsAria:Google Calendar',
    });
    fireEvent.click(details);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('gives each plugin-specific accessible name', () => {
    render(
      <>
        <MarketPluginCard
          item={marketPlugin}
          busy={false}
          onSelect={vi.fn()}
          onIconLoadError={vi.fn()}
        />
        <MarketPluginCard
          item={{
            ...marketPlugin,
            pluginId: 'release-github',
            ghostId: 'github',
            name: 'GitHub',
            installState: 'conflict',
          }}
          busy={false}
          onSelect={vi.fn()}
          onIconLoadError={vi.fn()}
        />
      </>,
    );

    expect(
      screen.getByRole('button', {
        name: 'settings.ghosts.market.detailsAria:Google Calendar',
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', {
        name: 'settings.ghosts.market.conflictAria:GitHub',
      }),
    ).toBeTruthy();
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
    expect(cardBody.className).toContain('cursor-not-allowed');
    expect(cardBody.className).not.toContain('cursor-wait');
    const conflictDescription = screen.getByText('settings.ghosts.market.conflictDescription');
    expect(conflictDescription.id).toBeTruthy();
    expect(cardBody.getAttribute('aria-describedby')).toBe(conflictDescription.id);
    const conflictAction = screen.getByRole('button', {
      name: 'settings.ghosts.market.conflictAria:Google Calendar',
    });
    expect((conflictAction as HTMLButtonElement).disabled).toBe(true);
    expect(conflictAction.getAttribute('aria-describedby')).toBe(conflictDescription.id);
    expect(screen.getByRole('status').textContent).toBe('settings.ghosts.market.conflict');
    expect(screen.queryByText('settings.ghosts.market.install')).toBeNull();
    expect(screen.queryByText(marketPlugin.description ?? '')).toBeNull();

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
    expect(busyCardBody.className).toContain('cursor-wait');
    expect(busyCardBody.className).not.toContain('cursor-not-allowed');
  });
});

describe('installed Plugin disclosure', () => {
  it('shows at most eight installed plugins until the user expands the section', () => {
    const items = Array.from({ length: MAX_VISIBLE_INSTALLED_PLUGINS + 3 }, (_, index) => index);

    expect(visibleInstalledPluginItems(items)).toEqual(
      items.slice(0, MAX_VISIBLE_INSTALLED_PLUGINS),
    );
  });

  it('links the disclosure to its overflow and previews at most three hidden avatars', () => {
    const onToggle = vi.fn();
    const previewItems = Array.from(
      { length: MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS + 2 },
      (_, index) => ({
        ...commandPlugin,
        id: `preview-${index}`,
        name: `Preview ${index}`,
        origin: 'public' as const,
        marketUpdate: null,
      }),
    );
    const { container, rerender } = render(
      <InstalledPluginDisclosure
        expanded={false}
        controlsId="installed-overflow"
        totalCount={11}
        previewItems={previewItems}
        onToggle={onToggle}
      />,
    );

    const collapsedButton = screen.getByRole('button', {
      name: 'settings.ghosts.page.installedExpand',
    });
    expect(collapsedButton.getAttribute('aria-expanded')).toBe('false');
    expect(collapsedButton.getAttribute('aria-controls')).toBe('installed-overflow');
    expect(container.querySelectorAll('.plugin-installed-preview-card')).toHaveLength(
      MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS,
    );
    fireEvent.click(collapsedButton);
    expect(onToggle).toHaveBeenCalledTimes(1);

    rerender(
      <InstalledPluginDisclosure
        expanded
        controlsId="installed-overflow"
        totalCount={11}
        previewItems={previewItems}
        onToggle={onToggle}
      />,
    );
    expect(
      screen
        .getByRole('button', { name: 'settings.ghosts.page.installedCollapse' })
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(container.querySelector('.plugin-installed-preview-stack')).toBeNull();
  });

  it('keeps collapsed overflow hidden and inert until expanded', () => {
    const { rerender, container } = render(
      <InstalledPluginOverflow id="installed-overflow" expanded={false}>
        <button type="button">Hidden plugin</button>
      </InstalledPluginOverflow>,
    );

    const collapsedOverflow = container.querySelector('#installed-overflow');
    expect(collapsedOverflow?.getAttribute('aria-hidden')).toBe('true');
    expect(collapsedOverflow?.hasAttribute('inert')).toBe(true);
    expect(collapsedOverflow?.getAttribute('data-expanded')).toBe('false');

    rerender(
      <InstalledPluginOverflow id="installed-overflow" expanded>
        <button type="button">Hidden plugin</button>
      </InstalledPluginOverflow>,
    );
    const expandedOverflow = container.querySelector('#installed-overflow');
    expect(expandedOverflow?.getAttribute('aria-hidden')).toBe('false');
    expect(expandedOverflow?.hasAttribute('inert')).toBe(false);
    expect(expandedOverflow?.getAttribute('data-expanded')).toBe('true');
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

    expect(screen.getByText('settings.ghosts.legacyRecovery.partialBlocked')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});
