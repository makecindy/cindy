/**
 * Regression coverage for installed Plugin card actions (redesigned card:
 * whole-card opens detail, kind-specific primary button, manage entry),
 * market card actions, the legacy recovery notice, and market success navigation
 * (first install opens detail; update stays put).
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      (key === 'settings.ghosts.market.detailsAria' ||
        key === 'settings.ghosts.market.replaceAria') &&
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
  diffMarketUpdatePermissionItems,
  GhostPluginCard,
  LegacyGhostRecoveryNotice,
  marketUpdateAllowsPermissionExpansion,
  MarketPluginCard,
  shouldOpenInstalledDetailAfterMarketSuccess,
} from '../GhostPluginPage';
import {
  __ingestGhostBadgeForTest,
  __resetGhostUnreadForTest,
} from '@/cindy-brain/ghostUnreadStore';
import type { GhostPluginListItem } from '../lib/ghostPluginViewModel';
import type { InstalledGhost } from '../../../../shared/ghost';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

const {
  InstalledPluginDisclosure,
  InstalledPluginOverflow,
  MAX_COLLAPSED_INSTALLED_PLUGIN_PREVIEWS,
  MAX_VISIBLE_INSTALLED_PLUGINS,
  visibleInstalledPluginItems,
} = __installedPluginLayoutForTests;

describe('diffMarketUpdatePermissionItems', () => {
  it.each(['legacy-unapproved', 'invalid'] as const)(
    'reviews every target permission for a %s install',
    (approvalState) => {
      const manifest = {
        schemaVersion: 2 as const,
        id: 'legacy-plugin',
        name: 'Legacy Plugin',
        description: 'Legacy approval regression fixture',
        author: 'Cindy',
        version: '1.0.0',
        kind: 'chip' as const,
        entry: 'main.js',
        slots: ['notify'] as ['notify'],
      };
      const installed = {
        manifest,
        dir: 'C:\\plugins\\legacy-plugin',
        enabled: false,
        approval: { state: approvalState },
      };
      const next = {
        ...manifest,
        version: '2.0.0',
        slots: ['notify', 'fs'] as ['notify', 'fs'],
      };

      const diff = diffMarketUpdatePermissionItems(installed, next);
      expect(diff.added.map((item) => item.key)).toEqual(expect.arrayContaining(['notify', 'fs']));
      expect(diff.removed).toEqual([]);
      expect(diff.unchanged).toEqual([]);
    },
  );
});

describe('marketUpdateAllowsPermissionExpansion', () => {
  const installed = (approvalState: 'approved' | 'legacy-unapproved' | 'invalid') =>
    ({ approval: { state: approvalState } }) as InstalledGhost;

  it.each(['legacy-unapproved', 'invalid'] as const)(
    'allows the full reapproval of a no-permission %s install',
    (approvalState) => {
      expect(marketUpdateAllowsPermissionExpansion(installed(approvalState), 0)).toBe(true);
    },
  );

  it('only allows approved installs when the reviewed diff adds permissions', () => {
    expect(marketUpdateAllowsPermissionExpansion(installed('approved'), 0)).toBe(false);
    expect(marketUpdateAllowsPermissionExpansion(installed('approved'), 1)).toBe(true);
  });
});

describe('shouldOpenInstalledDetailAfterMarketSuccess', () => {
  it('opens the installed detail after a first-time market install', () => {
    expect(shouldOpenInstalledDetailAfterMarketSuccess(false)).toBe(true);
  });

  it('stays on the current page after an update or replacement', () => {
    expect(shouldOpenInstalledDetailAfterMarketSuccess(true)).toBe(false);
  });
});

const commandPlugin: GhostPluginListItem = {
  id: 'filo-google',
  name: 'Filo Google',
  description: 'Google services',
  version: '1.0.0',
  enabled: true,
  canUse: true,
  approvalState: 'approved',
  builtin: false,
  tabPanel: false,
  hostCapability: null,
  oauthAuthorizationExpired: false,
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

  it('opens plugin details from the whole card for a command plugin', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={commandPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Filo Google' }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
    // 指令型主按钮仍是「对话」,不随整卡改成详情。
    expect(screen.getByRole('button', { name: 'settings.ghosts.page.chatAria' })).toBeTruthy();
  });

  it('keeps the conversation pill as the command plugin primary action', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={commandPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.chatAria' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();
  });

  it.each(['Enter', ' '] as const)(
    'opens plugin details when the card itself is activated with %s',
    (key) => {
      const onPrimary = vi.fn();
      const onManage = vi.fn();
      render(<GhostPluginCard item={commandPlugin} onPrimary={onPrimary} onManage={onManage} />);

      fireEvent.keyDown(screen.getByRole('button', { name: 'Filo Google' }), { key });
      expect(onManage).toHaveBeenCalledTimes(1);
      expect(onPrimary).not.toHaveBeenCalled();
    },
  );

  it.each(['Enter', ' '] as const)(
    'does not treat a nested pill %s as a card activation',
    (key) => {
      const onPrimary = vi.fn();
      const onManage = vi.fn();
      render(<GhostPluginCard item={commandPlugin} onPrimary={onPrimary} onManage={onManage} />);

      fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.page.chatAria' }), {
        key,
      });
      expect(onManage).not.toHaveBeenCalled();
    },
  );

  it('labels the primary button 使用 for a tab-panel plugin', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={panelPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.useAria' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();
  });

  it('opens plugin details from the whole card for a tab-panel plugin', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={panelPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByRole('button', { name: 'Signoff Board' }));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('offers a conversation entry for a Host capability plugin', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={simulatorPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.chatAria' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onManage).not.toHaveBeenCalled();
    expect(screen.queryByText('settings.ghosts.page.agentInvoked')).toBeNull();
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
    const onManage = vi.fn();
    const onUpdate = vi.fn();
    render(
      <GhostPluginCard
        item={commandPlugin}
        updateVersion="1.1.0"
        onPrimary={onPrimary}
        onManage={onManage}
        onUpdate={onUpdate}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.page.updateAria' }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
    expect(onManage).not.toHaveBeenCalled();
    // 有更新时不显示「已是最新」。
    expect(screen.queryByText(/upToDate/)).toBeNull();
  });

  it('shows an expired OAuth status instead of the up-to-date status', () => {
    render(
      <GhostPluginCard
        item={{ ...commandPlugin, oauthAuthorizationExpired: true }}
        onPrimary={vi.fn()}
        onManage={vi.fn()}
      />,
    );

    expect(screen.getByText('settings.ghosts.page.oauthAuthorizationExpired')).toBeTruthy();
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

  it('replaces the update pill with a spinner while this card is pending', () => {
    render(
      <GhostPluginCard
        item={commandPlugin}
        updateVersion="1.1.0"
        updateBusy
        updatePending
        onPrimary={vi.fn()}
        onManage={vi.fn()}
        onUpdate={vi.fn()}
      />,
    );

    const update = screen.getByRole('button', {
      name: 'settings.ghosts.page.updateAria',
    });
    expect(update.getAttribute('aria-busy')).toBe('true');
    expect(update.querySelector('.animate-spin')).toBeTruthy();
    expect(update.textContent).toBe('');
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

  it('opens details from the non-interactive agent-invoked hint', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={toolPlugin} onPrimary={onPrimary} onManage={onManage} />);

    fireEvent.click(screen.getByText('settings.ghosts.page.agentInvoked'));
    expect(onManage).toHaveBeenCalledTimes(1);
    expect(onPrimary).not.toHaveBeenCalled();
  });

  it('opens details from empty space in the right action rail', () => {
    const onPrimary = vi.fn();
    const onManage = vi.fn();
    render(<GhostPluginCard item={commandPlugin} onPrimary={onPrimary} onManage={onManage} />);

    const manage = screen.getByRole('button', { name: 'settings.ghosts.page.manageAria' });
    fireEvent.click(manage.parentElement as HTMLElement);
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
    expect(screen.getByRole('button', { name: 'settings.ghosts.page.manageAction' })).toBeTruthy();
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

  // ── 未读角标(badge 槽)────────────────────────────────────────────
  it('无未读时不画点,描述位仍是静态描述', () => {
    const { container } = render(
      <GhostPluginCard item={commandPlugin} onPrimary={vi.fn()} onManage={vi.fn()} />,
    );
    expect(container.querySelector('.session-card-dot')).toBeNull();
    expect(screen.getByText('Google services')).toBeTruthy();
  });

  it('有未读时:呼吸绿点 + 摘要顶替静态描述', () => {
    __ingestGhostBadgeForTest('filo-google', { unread: true, summary: '2 封新邮件', at: 1 });
    const { container } = render(
      <GhostPluginCard item={commandPlugin} onPrimary={vi.fn()} onManage={vi.fn()} />,
    );
    // 单条卡片走呼吸形态(session-card-dot 带呼吸关键帧),绿色走 done token。
    const dot = container.querySelector('.session-card-dot');
    expect(dot).toBeTruthy();
    expect(dot?.className).toContain('var(--card-status-done)');
    // 摘要顶替静态描述:静态描述用户早读过了,"新内容是什么"才是这一刻的信息。
    expect(screen.getByText('2 封新邮件')).toBeTruthy();
    expect(screen.queryByText('Google services')).toBeNull();
  });

  it('有未读但插件没给摘要:只点亮,静态描述保留(不留空白)', () => {
    __ingestGhostBadgeForTest('filo-google', { unread: true, at: 1 });
    const { container } = render(
      <GhostPluginCard item={commandPlugin} onPrimary={vi.fn()} onManage={vi.fn()} />,
    );
    expect(container.querySelector('.session-card-dot')).toBeTruthy();
    expect(screen.getByText('Google services')).toBeTruthy();
  });

  it('未读只认本插件的 id:别的插件亮着不影响本卡', () => {
    __ingestGhostBadgeForTest('signoff-board', { unread: true, summary: '别人的', at: 1 });
    const { container } = render(
      <GhostPluginCard item={commandPlugin} onPrimary={vi.fn()} onManage={vi.fn()} />,
    );
    expect(container.querySelector('.session-card-dot')).toBeNull();
    expect(screen.getByText('Google services')).toBeTruthy();
  });
});

describe('MarketPluginCard', () => {
  it('uses an icon-only details action in the card-level right action rail', () => {
    render(
      <MarketPluginCard
        item={marketPlugin}
        busy={false}
        onSelect={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const details = screen.getByRole('button', {
      name: 'settings.ghosts.market.detailsAria:Google Calendar',
    });
    expect(details.textContent).toBe('');
    expect(details.parentElement?.className).toContain('flex-col');
    expect(details.parentElement?.className).toContain('items-end');
    expect(screen.queryByText('settings.ghosts.market.details')).toBeNull();
    expect(screen.getByRole('button', { name: 'Google Calendar' }).tagName).toBe('BUTTON');
    expect(
      screen
        .getByRole('button', { name: 'Google Calendar' })
        .closest('article')
        ?.hasAttribute('role'),
    ).toBe(false);
  });

  it('exposes both details and install actions for a not-installed plugin', () => {
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

    const details = screen.getByRole('button', {
      name: 'settings.ghosts.market.detailsAria:Google Calendar',
    });
    const install = screen.getByRole('button', { name: 'settings.ghosts.page.installAria' });
    expect(details.className).toContain('absolute');
    expect(details.className).toContain('inset-0');

    fireEvent.click(details);
    expect(onSelect).toHaveBeenCalledTimes(1);

    fireEvent.click(install);
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('gives each icon-only market action a plugin-specific accessible name', () => {
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
        name: 'settings.ghosts.market.detailsAria:GitHub',
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

  it('offers explicit replacement while still blocking actions during busy operations', () => {
    const onInstall = vi.fn();
    const { rerender } = render(
      <MarketPluginCard
        item={{ ...marketPlugin, installState: 'conflict' }}
        busy={false}
        onSelect={vi.fn()}
        onInstall={onInstall}
        onIconLoadError={vi.fn()}
      />,
    );

    const cardBody = screen.getByRole('button', { name: 'Google Calendar' });
    expect((cardBody as HTMLButtonElement).disabled).toBe(false);
    expect(cardBody.className).toContain('cursor-pointer');
    expect(cardBody.className).not.toContain('cursor-wait');
    const replacementDescription = screen.getByText('settings.ghosts.market.replaceDescription');
    expect(replacementDescription.id).toBeTruthy();
    expect(cardBody.getAttribute('aria-describedby')).toBe(replacementDescription.id);
    const replaceAction = screen.getByRole('button', {
      name: 'settings.ghosts.market.replaceAria:Google Calendar',
    });
    expect((replaceAction as HTMLButtonElement).disabled).toBe(false);
    expect(replaceAction.getAttribute('aria-describedby')).toBe(replacementDescription.id);
    expect(replaceAction.textContent).toBe('settings.ghosts.market.replace');
    fireEvent.click(replaceAction);
    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.page.installAria' })).toBeNull();
    expect(screen.queryByText(marketPlugin.description ?? '')).toBeNull();

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
    expect(busyCardBody.className).toContain('cursor-wait');
    expect(busyCardBody.className).not.toContain('cursor-not-allowed');
  });

  it('replaces the install label with a spinner while this card is pending', () => {
    render(
      <MarketPluginCard
        item={marketPlugin}
        busy
        pending
        onSelect={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const install = screen.getByRole('button', {
      name: 'settings.ghosts.page.installAria',
    });
    expect(install.getAttribute('aria-busy')).toBe('true');
    expect(install.querySelector('.animate-spin')).toBeTruthy();
    expect(install.textContent).toBe('');
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
