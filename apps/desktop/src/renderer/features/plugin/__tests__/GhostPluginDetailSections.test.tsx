/**
 * Regression coverage for Plugin detail section content and interaction behavior.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: toastMocks }));
vi.mock('@/cindy-brain/GhostSettingsWebview', () => ({
  GhostSettingsWebview: () => <div data-testid="ghost-settings-webview" />,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'settings.ghosts.detail.openTool': `Open ${String(options?.name ?? '')}`,
        'settings.ghosts.detail.toolsTitle': 'Tools',
        'settings.ghosts.detail.alwaysAllow': 'Always allow',
        'settings.ghosts.detail.needsApproval': 'Needs approval',
        'settings.ghosts.detail.blocked': 'Blocked',
        'settings.ghosts.detail.custom': 'Custom',
        'settings.ghosts.detail.chooseToolPermission':
          'Choose when the Agent is allowed to use these tools',
        'settings.ghosts.detail.toolPermissionGroup': `Permission for Tool ${String(options?.name ?? '')}`,
        'settings.ghosts.detail.toolPermissionSaveFailed':
          "Couldn't save the tool permission. Please try again.",
        'settings.ghosts.detail.toolPermissionUnavailable':
          'Tool permissions are temporarily unavailable. Please try again later.',
        'settings.ghosts.detail.noToolDescription': 'No description',
        'settings.ghosts.detail.permissionsTitle': 'Permissions',
        'settings.ghosts.detail.viewAllPermissions': 'See All',
        'settings.ghosts.detail.permissionsDialogDescription': `${String(options?.count ?? '')} permissions`,
        'settings.ghosts.detail.closeDialog': 'Close dialog',
        'settings.ghosts.perm.networkHost': `Access ${String(options?.host ?? '')}`,
        'settings.ghosts.perm.networkHostDetail': 'Can access this declared domain.',
        'settings.ghosts.perm.cindyTextOneshotModelDetail': `Takes effect when the model (${String(options?.model ?? '')}) is available in the catalog.`,
        'settings.ghosts.perm.command': `Command ${String(options?.command ?? '')}`,
        'settings.ghosts.perm.tool': `Tool ${String(options?.name ?? '')}`,
        'settings.ghosts.perm.cindyImageGenerate': 'Generate images',
        'settings.ghosts.perm.cindyTextOneshot': 'Quick Q&A',
        'settings.ghosts.detail.infoTitle': 'Details',
        'settings.ghosts.detail.byAuthor': `By ${String(options?.author ?? '')}`,
        'settings.ghosts.detail.infoVersion': 'Version',
        'settings.ghosts.detail.infoAuthor': 'Author',
        'settings.ghosts.detail.infoId': 'Identifier',
        'settings.ghosts.detail.infoContents': 'Contents',
        'settings.ghosts.contents.code': 'Executable Code',
        'settings.ghosts.detail.infoPanel': 'Panel',
        'settings.ghosts.detail.infoLocation': 'Install Location',
        'settings.ghosts.detail.copyLocation': 'Copy Install Location',
        'settings.ghosts.detail.locationCopied': 'Install location copied',
        'settings.ghosts.detail.locationCopyFailed': 'Could not copy install location',
        'settings.ghosts.detail.openLocation': 'Open Install Location',
        'settings.ghosts.detail.expandInfoValue': `Show full ${String(options?.label ?? '')}`,
        'settings.ghosts.detail.collapseInfoValue': `Collapse ${String(options?.label ?? '')}`,
        'settings.ghosts.detail.panelNotDocked': 'Not docked',
        'settings.ghosts.detail.cindyPrefs.noModels': 'No models available',
        'settings.defaults.restore': 'Restore default',
        'settings.ghosts.detail.oauthScopeStale':
          'This authorization does not include newly added permissions. Reconnect to enable them.',
      };
      return labels[key] ?? key;
    },
  }),
}));

import type { GhostPermissionItem } from '../../../../shared/ghost';
import { CindyCapabilityPrefs } from '@/cindy-brain/CindyCapabilityPrefs';
import {
  DetailsSection,
  GhostPluginDetailView,
  GhostPluginMetadata,
  PermissionSummary,
  ToolDescriptionChip,
  ToolsSection,
} from '../GhostPluginDetailView';
import type { GhostPluginDetail } from '../lib/ghostPluginViewModel';

const permissions: GhostPermissionItem[] = [
  {
    key: 'network:api.example.com',
    kind: 'network',
    labelKey: 'networkHost',
    labelArgs: { host: 'api.example.com' },
    detailKey: 'networkHostDetail',
  },
  {
    key: 'command:render',
    kind: 'command',
    labelKey: 'command',
    labelArgs: { command: 'render' },
  },
  {
    key: 'tool:render',
    kind: 'tool',
    labelKey: 'tool',
    labelArgs: { name: 'render' },
    detail: 'Render an image.',
  },
  {
    key: 'cindy:image.generate',
    kind: 'cindy',
    labelKey: 'cindyImageGenerate',
  },
  {
    key: 'cindy:text.oneshot',
    kind: 'cindy',
    labelKey: 'cindyTextOneshot',
    detailKey: 'cindyTextOneshotModelDetail',
    detailArgs: { model: 'codex/gpt-5.5' },
  },
];

const detail: GhostPluginDetail = {
  id: 'builtin.example',
  name: 'Example',
  description: 'Example plugin',
  version: '1.2.3',
  enabled: true,
  canUse: true,
  approvalState: 'approved',
  builtin: false,
  tabPanel: false,
  hasMainView: false,
  mainViewTitle: null,
  hostCapability: null,
  author: 'XD',
  contents: ['code'],
  permissions: [],
  tools: [],
  hasSettingsUi: false,
  cindyCapabilities: [],
  hasErrand: false,
  panelMinWidth: 320,
  installDir: '/tmp/cindy-brain/builtin.example',
  trust: {
    level: 'cindy-official',
    publisherSigned: true,
    publisherVerified: true,
    reviewed: true,
    publisherName: 'Cindy',
  },
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('Ghost plugin detail sections', () => {
  it('shows the main-view preference alongside the plugin settings UI', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onVisibilityChange = vi.fn();
    render(
      <GhostPluginDetailView
        ghost={{
          manifest: {
            schemaVersion: 2,
            id: detail.id,
            name: detail.name,
            version: detail.version,
            kind: 'chip',
            entry: 'main.js',
            minCindyVersion: '1.2.3',
            slots: ['main-view'],
            settingsHtml: 'settings.html',
            mainView: { html: 'main-view.html', title: 'Workspace' },
          },
          dir: detail.installDir ?? '/tmp/plugin',
          enabled: true,
          approval: { state: 'approved', revision: 'rev-1' },
        }}
        detail={{
          ...detail,
          hasMainView: true,
          mainViewTitle: 'Workspace',
          hasSettingsUi: true,
        }}
        panelStatus={null}
        mainViewSidebarVisible
        onMainViewSidebarVisibleChange={onVisibilityChange}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    const toggle = screen.getByRole('switch', {
      name: 'settings.ghosts.detail.showInSidebar',
    });
    expect(toggle.getAttribute('data-state')).toBe('checked');
    fireEvent.click(toggle);
    expect(onVisibilityChange).toHaveBeenCalledWith(false);
    expect(screen.getByText('settings.ghosts.detail.sidebarEntryTitle')).toBeTruthy();
    expect(screen.getByTestId('ghost-settings-webview')).toBeTruthy();
  });

  it('keeps the existing command action when the plugin also declares main-view', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onUse = vi.fn();
    render(
      <GhostPluginDetailView
        ghost={null}
        detail={{ ...detail, hasMainView: true, mainViewTitle: 'Workspace' }}
        panelStatus={null}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={onUse}
        onUpdate={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    const chat = screen.getByRole('button', { name: 'settings.ghosts.detail.chatAction' });
    expect((chat as HTMLButtonElement).disabled).toBe(false);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.openAction' })).toBeNull();
    fireEvent.click(chat);
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it('shows a non-blocking stale OAuth scope badge inside the configuration section', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    render(
      <GhostPluginDetailView
        ghost={{
          manifest: {
            schemaVersion: 2,
            id: detail.id,
            name: detail.name,
            version: detail.version,
            kind: 'chip',
            entry: 'main.js',
            settingsHtml: 'settings.html',
          },
          dir: detail.installDir ?? '/tmp/plugin',
          enabled: true,
          approval: { state: 'approved', revision: 'rev-1' },
          oauthScopeStale: { secretKey: 'account', missingScopeCount: 2 },
        }}
        detail={{ ...detail, hasSettingsUi: true }}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    const badge = screen.getByRole('status');
    expect(badge.textContent).toContain('newly added permissions');
    expect(badge.className).toContain('bg-[var(--warning-bg-soft)]');
    expect(screen.getByTestId('ghost-settings-webview')).toBeTruthy();
  });

  it('keeps the detail surface on one centered content grid', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );

    const { container } = render(
      <GhostPluginDetailView
        ghost={null}
        detail={detail}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onReapprove={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    const scrollSurface = container.querySelector('main');
    const detailFrame = container.querySelector('article');
    // 返回按钮住在吸顶顶栏里(mac 的窗口拖拽区)。顶栏内层复用同一条 824px
    // 内容框,与正文左缘对齐。
    const topBar = container.querySelector('[data-testid="plugin-detail-top-bar"]');
    const topBarFrame = topBar?.querySelector(':scope > div');
    const backButton = topBar?.querySelector('button');
    const detailHero = detailFrame?.querySelector('.plugin-detail-hero');
    const detailActions = detailFrame?.querySelector('.plugin-detail-actions');
    expect(scrollSurface?.className).toContain('[scrollbar-gutter:stable_both-edges]');
    expect(detailFrame?.className).toContain('plugin-detail-frame');
    expect(detailFrame?.className).toContain('mx-auto');
    expect(detailFrame?.className).toContain('max-w-[824px]');
    expect(topBar?.className).toContain('sticky');
    expect(topBarFrame?.className).toContain('mx-auto');
    expect(topBarFrame?.className).toContain('max-w-[824px]');
    expect(backButton?.className).toContain('-ml-3');
    expect(detailHero?.className).toContain('grid-cols-[64px_minmax(0,1fr)_auto]');
    expect(detailActions?.className).toContain('flex-nowrap');
  });

  it('renders an enabled Host capability as a conversation action', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onUse = vi.fn();
    render(
      <GhostPluginDetailView
        ghost={null}
        detail={{ ...detail, canUse: false, hostCapability: 'ios-simulator' }}
        panelStatus={null}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={onUse}
        onUpdate={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.chatAction' }));
    expect(onUse).toHaveBeenCalledTimes(1);
  });

  it('routes a projected detail icon failure to market recovery', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onIconLoadError = vi.fn();
    const { container } = render(
      <GhostPluginDetailView
        ghost={null}
        detail={{
          ...detail,
          iconDataUrl: 'https://plugins.example.invalid/icon.png?signature=current',
        }}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onReapprove={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
        onIconLoadError={onIconLoadError}
      />,
    );

    fireEvent.error(container.querySelector('img') as HTMLImageElement);

    expect(onIconLoadError).toHaveBeenCalledTimes(1);
  });

  it('keeps the market replacement action for a same-version legacy install', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onUpdate = vi.fn();
    render(
      <GhostPluginDetailView
        ghost={null}
        detail={detail}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={onUpdate}
        onReapprove={vi.fn()}
        onUpdateFromFile={vi.fn()}
        updateVersion={detail.version}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    const updateButton = screen.getByRole('button', {
      name: 'settings.ghosts.market.update',
    });
    fireEvent.click(updateButton);

    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.market.updateTo' })).toBeNull();
  });

  it.each([
    ['legacy-unapproved', 'settings.ghosts.reapproval.bodyLegacy'],
    ['invalid', 'settings.ghosts.reapproval.bodyInvalid'],
  ] as const)(
    'explains the %s approval state and routes to a fresh review',
    (approvalState, bodyKey) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      const onReapprove = vi.fn();
      const onUpdate = vi.fn();
      const onToggle = vi.fn();
      render(
        <GhostPluginDetailView
          ghost={null}
          detail={{ ...detail, approvalState }}
          panelStatus="Docked"
          onBack={vi.fn()}
          onToggle={onToggle}
          onUse={vi.fn()}
          onUpdate={onUpdate}
          onReapprove={onReapprove}
          onUpdateFromFile={vi.fn()}
          updateVersion="1.2.4"
          onUninstall={vi.fn()}
          toggleDisabled={false}
        />,
      );

      expect(screen.getByText('settings.ghosts.reapproval.noticeTitle')).toBeTruthy();
      expect(screen.getByText(bodyKey)).toBeTruthy();
      // 缺批准时"使用"与"更新"都不该顶在最前面,主动作是重新确认。
      expect(screen.queryByRole('button', { name: 'settings.ghosts.market.updateTo' })).toBeNull();
      // detail fixture 是指令型插件(canUse:true / tabPanel:false → 'command'),主动作按钮
      // 标 chatAction;缺批准时 primaryEnabled=false → 禁用。
      expect(
        (
          screen.getByRole('button', {
            name: 'settings.ghosts.detail.chatAction',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);

      // 启用区域是单个 switch 按钮；点文字或轨道都由同一交互处理。
      const toggle = screen.getByRole('switch', {
        name: 'settings.ghosts.enableAria',
      }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(true);
      fireEvent.click(toggle);
      expect(onToggle).not.toHaveBeenCalled();

      fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.reapproval.action' }));
      expect(onReapprove).toHaveBeenCalledTimes(1);
      expect(onUpdate).not.toHaveBeenCalled();
    },
  );

  it('disables every market update entry while an update is busy', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onUpdate = vi.fn();

    render(
      <GhostPluginDetailView
        ghost={null}
        detail={detail}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={onUpdate}
        onReapprove={vi.fn()}
        onUpdateFromFile={vi.fn()}
        updateVersion="1.2.4"
        updateBusy
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.market.updateTo',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
      { button: 0, ctrlKey: false },
    );
    // ⋮ 菜单固定为「从文件更新」兜底路径(市场更新已提级到头部 CTA),
    // 更新进行中同样置灰。
    const menuUpdate = screen.getByRole('menuitem', {
      name: 'settings.ghosts.detail.updateFromFile',
    });
    expect(menuUpdate.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(menuUpdate);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('hides the local .cindy update entry for reserved official ids outside dev builds', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // packaged 构建上 Main 会对 cindy- / filo- / xd- 前缀直接 GHOST_ID_RESERVED,
    // 把这个必失败动作留在菜单里等于让用户选完文件才吃错误。
    // vitest 默认 DEV=true,这里显式模拟打包产物(DEV=false)。
    vi.stubEnv('DEV', false);
    // 显式标注类型:JSX prop 位置的内联展开会让 tsc 现推一个巨大的匿名类型,
    // desktop 的 typecheck 本就贴着 CI 的 4GB 堆上限跑,能省则省。
    const officialDetail: GhostPluginDetail = { ...detail, id: 'cindy-art' };
    render(
      <GhostPluginDetailView
        ghost={null}
        detail={officialDetail}
        panelStatus={null}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
      { button: 0, ctrlKey: false },
    );
    expect(
      screen.queryByRole('menuitem', { name: 'settings.ghosts.detail.updateFromFile' }),
    ).toBeNull();
    // 只剩卸载一项时不画悬空分割线。
    expect(screen.queryByRole('separator')).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'settings.ghosts.uninstall' })).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it('keeps the local .cindy update entry for ordinary third-party plugins', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    // 同样是打包产物,但非保留前缀:Main 不会拒,入口必须留着。
    vi.stubEnv('DEV', false);
    render(
      <GhostPluginDetailView
        ghost={null}
        detail={detail}
        panelStatus={null}
        onBack={vi.fn()}
        onToggle={vi.fn()}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={false}
      />,
    );

    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
      { button: 0, ctrlKey: false },
    );
    expect(
      screen.getByRole('menuitem', { name: 'settings.ghosts.detail.updateFromFile' }),
    ).toBeTruthy();
    expect(screen.getByRole('separator')).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it('renders an export menu item only when onExport is provided', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const baseProps = {
      ghost: null,
      detail,
      panelStatus: 'Docked',
      onBack: vi.fn(),
      onToggle: vi.fn(),
      onUse: vi.fn(),
      onUpdate: vi.fn(),
      onUpdateFromFile: vi.fn(),
      onUninstall: vi.fn(),
      onReapprove: vi.fn(),
      toggleDisabled: false,
    };

    // 未提供 onExport(纯市场视图):菜单里不出现导出项。
    const { unmount } = render(<GhostPluginDetailView {...baseProps} />);
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
      { button: 0, ctrlKey: false },
    );
    expect(
      screen.queryByRole('menuitem', { name: 'settings.ghosts.detail.exportPackage' }),
    ).toBeNull();
    unmount();

    // 提供 onExport(已装插件):点击触发导出回调。
    const onExport = vi.fn();
    render(<GhostPluginDetailView {...baseProps} onExport={onExport} />);
    fireEvent.pointerDown(
      screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
      { button: 0, ctrlKey: false },
    );
    fireEvent.click(screen.getByRole('menuitem', { name: 'settings.ghosts.detail.exportPackage' }));
    expect(onExport).toHaveBeenCalledTimes(1);
  });

  it('uses one metadata color and orders author, then version', () => {
    const { container } = render(<GhostPluginMetadata author="Cindy" version="1.1.4" />);

    const metadata = container.firstElementChild as HTMLElement;
    expect(metadata.textContent).toBe('By Cindy·v1.1.4');
    expect(metadata.className).toContain('text-[var(--text-tertiary)]');
    expect(metadata.innerHTML).not.toContain('text-[var(--text-secondary)]');
    expect(screen.getByText('By Cindy').className).toContain('min-w-0');
    expect(screen.getByText('By Cindy').className).toContain('truncate');
  });

  it('uses each Cindy capability catalog in the responsive control group', () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          cindyPrefsSync: () => ({
            overrides: {},
            image: {
              options: [
                {
                  id: 'image-default',
                  label: 'Image Default',
                  providerId: 'xd',
                  providerName: 'Cindy AI',
                },
                {
                  id: 'image-option',
                  label: 'Image Option',
                  providerId: 'xd',
                  providerName: 'Cindy AI',
                },
              ],
              defaultModel: {
                id: 'image-default',
                label: 'Image Default',
                providerId: 'xd',
                providerName: 'Cindy AI',
              },
            },
            imageEdit: {
              options: [
                {
                  id: 'image-edit',
                  label: 'Image Edit',
                  providerId: 'xd',
                  providerName: 'Cindy AI',
                },
                {
                  id: 'image-edit-option',
                  label: 'Image Edit Option',
                  providerId: 'xd',
                  providerName: 'Cindy AI',
                },
              ],
              defaultModel: {
                id: 'image-edit',
                label: 'Image Edit',
                providerId: 'xd',
                providerName: 'Cindy AI',
              },
            },
            video: {
              options: [{ id: 'video-default', label: 'Video Default' }],
              defaultModel: { id: 'video-default', label: 'Video Default' },
            },
            videoEdit: {
              options: [{ id: 'video-edit', label: 'Video Edit' }],
              defaultModel: { id: 'video-edit', label: 'Video Edit' },
            },
          }),
          setCindyPref: vi.fn(),
        },
      },
    });

    const { container } = render(
      <CindyCapabilityPrefs
        ghostId="builtin.example"
        capabilities={['image.generate', 'image.edit']}
        appearance="plugin"
      />,
    );

    expect(container.querySelector('.cindy-capability-prefs')).toBeTruthy();
    expect(container.querySelector('.cindy-capability-row')).toBeTruthy();
    const pickers = screen.getAllByRole('combobox');
    expect(pickers).toHaveLength(2);
    fireEvent.click(pickers[0]!);
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('Image Option')).toBeTruthy();
    fireEvent.click(pickers[0]!);
    fireEvent.click(pickers[1]!);
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);
    expect(screen.getByText('Image Edit Option')).toBeTruthy();
    expect(pickers[0]!.className).toContain('max-w-[60%]');
  });

  // 2026-08-05:快问快答钉档扩展为目录全量文本模型——富列表选择器(供应商
  // 分组 / 折扣与订阅徽标 / 搜索),身份卡声明偏好时"跟随默认"行如实展示。
  it('text capability renders the rich pin picker with provider groups and budget badge', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const setCindyPref = vi.fn(async () => ({ overrides: {} }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          cindyPrefsSync: () => ({
            overrides: {},
            image: { options: [], defaultModel: null },
            imageEdit: { options: [], defaultModel: null },
            video: { options: [], defaultModel: null },
            videoEdit: { options: [], defaultModel: null },
            text: {
              options: [
                {
                  id: 'cat:xd:codex:codex/gpt-5.5',
                  label: 'Codex · GPT 5.5 折扣 · GW',
                  group: 'GW',
                  providerId: 'xd',
                  agentKind: 'codex',
                  modelId: 'codex/gpt-5.5',
                  modelName: 'GPT 5.5 折扣',
                  agentSuffix: 'Codex',
                  budget: true,
                  subscription: false,
                },
                {
                  id: 'cat:openai:codex:gpt-5.5',
                  label: 'Codex · GPT 5.5 · OpenAI',
                  group: 'OpenAI',
                  providerId: 'openai',
                  agentKind: 'codex',
                  modelId: 'gpt-5.5',
                  modelName: 'GPT 5.5',
                  agentSuffix: 'Codex',
                  budget: false,
                  subscription: true,
                },
                {
                  id: 'cat:openai:codex:chatgpt/gpt-5.5',
                  label: 'Codex · GPT 5.5 · OpenAI',
                  group: 'OpenAI',
                  providerId: 'openai',
                  agentKind: 'codex',
                  modelId: 'chatgpt/gpt-5.5',
                  modelName: 'GPT 5.5',
                  agentSuffix: 'Codex',
                  budget: false,
                  subscription: true,
                },
                {
                  id: 'cat:openai:claude-code:chatgpt/gpt-5.5',
                  label: 'Claude Code · GPT 5.5 · OpenAI',
                  group: 'OpenAI',
                  providerId: 'openai',
                  agentKind: 'claude-code',
                  modelId: 'chatgpt/gpt-5.5',
                  modelName: 'GPT 5.5',
                  agentSuffix: 'Claude Code',
                  budget: false,
                  subscription: true,
                },
              ],
              defaultModel: { id: 'codex-gpt-5.4-mini', label: 'gpt-5.4-mini · Codex' },
              declaredModel: { id: 'cat:xd:codex:codex/gpt-5.5', label: 'codex/gpt-5.5' },
            },
          }),
          setCindyPref,
        },
      },
    });

    render(
      <CindyCapabilityPrefs
        ghostId="xdt-knowledge"
        capabilities={['text.oneshot']}
        appearance="plugin"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.ghosts.detail.cindyPrefs.cap.text.oneshot' }),
    );

    const agentList = await screen.findByRole('listbox');
    // 第一层只显示自动选择和 Agent，不混入模型排列组合。
    expect(within(agentList).queryByText('GW')).toBeNull();
    expect(within(agentList).queryByText('OpenAI')).toBeNull();
    const defaultRow = within(agentList).getAllByRole('option')[0]!;
    expect(defaultRow.textContent).toContain(
      'settings.ghosts.detail.cindyPrefs.defaultOptionDeclared',
    );
    fireEvent.click(agentList.querySelector('[data-agent-kind="codex"]')!);

    let codexModels = await screen.findByRole('listbox');
    expect(within(codexModels).getByText('GW')).toBeTruthy();
    expect(within(codexModels).getByText('OpenAI')).toBeTruthy();
    expect(codexModels.querySelector('[data-pin-id*="claude-code"]')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.auxiliaryModels.backToAgents' }),
    );
    const agentListAgain = await screen.findByRole('listbox');
    fireEvent.click(agentListAgain.querySelector('[data-agent-kind="claude-code"]')!);
    const claudeModels = await screen.findByRole('listbox');
    expect(claudeModels.querySelector('[data-pin-id*="claude-code"]')).toBeTruthy();
    expect(claudeModels.querySelector('[data-pin-id*="openai:codex:"]')).toBeNull();

    fireEvent.click(
      screen.getByRole('button', { name: 'settings.auxiliaryModels.backToAgents' }),
    );
    fireEvent.click(
      (await screen.findByRole('listbox')).querySelector('[data-agent-kind="codex"]')!,
    );
    codexModels = await screen.findByRole('listbox');
    // 同 Agent 的同名别名折叠；另一个 Agent 的同名模型不混在本层。
    const budgetRow = within(codexModels).getByText('GPT 5.5 折扣').closest('button')!;
    expect(within(budgetRow).getByText('settings.ghosts.detail.cindyPrefs.budgetBadge')).toBeTruthy();
    const plainRow = within(codexModels).getByText('GPT 5.5', { exact: true }).closest('button')!;
    expect(
      within(plainRow).queryByText('settings.ghosts.detail.cindyPrefs.budgetBadge'),
    ).toBeNull();
    expect(within(plainRow).getByText('settings.providers.models.subscription')).toBeTruthy();
    // 点行钉档:写回 cat: 编码钉值。
    fireEvent.click(plainRow);
    expect(setCindyPref).toHaveBeenCalledWith(
      'xdt-knowledge',
      'text.oneshot',
      'cat:openai:codex:gpt-5.5',
    );
    vi.unstubAllEnvs();
  });

  // 2026-08-05 review:存量轻量档位钉(目录扩展前的合法钉值)回显友好名,
  // 不当 stale 露原始 id。
  it('text capability shows a friendly label for a legacy utility-profile pin', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          cindyPrefsSync: () => ({
            overrides: { 'text.oneshot': 'litellm-kimi-k2.6' },
            image: { options: [], defaultModel: null },
            imageEdit: { options: [], defaultModel: null },
            video: { options: [], defaultModel: null },
            videoEdit: { options: [], defaultModel: null },
            text: {
              options: [
                {
                  id: 'cat:xd:codex:codex/gpt-5.5',
                  label: 'Codex · GPT 5.5 折扣 · GW',
                  group: 'GW',
                  providerId: 'xd',
                  agentKind: 'codex',
                  modelId: 'codex/gpt-5.5',
                  modelName: 'GPT 5.5 折扣',
                  budget: true,
                  subscription: false,
                },
              ],
              defaultModel: { id: 'codex-gpt-5.4-mini', label: 'gpt-5.4-mini · Codex' },
              utilityProfiles: [{ id: 'litellm-kimi-k2.6', label: 'kimi-k2.6 · Gateway' }],
            },
          }),
          setCindyPref: vi.fn(async () => ({ overrides: {} })),
        },
      },
    });

    render(
      <CindyCapabilityPrefs
        ghostId="xdt-knowledge"
        capabilities={['text.oneshot']}
        appearance="plugin"
      />,
    );
    const trigger = screen.getByRole('button', {
      name: 'settings.ghosts.detail.cindyPrefs.cap.text.oneshot',
    });
    expect(trigger.textContent).toContain('kimi-k2.6 · Gateway');
    expect(trigger.textContent).not.toContain('litellm-kimi-k2.6');
    vi.unstubAllEnvs();
  });

  // 2026-08-05 review:stale 目录钉(模型已下架)点中 = 当前值,只收起不回写
  // (回写必被白名单拒成「操作失败」);清钉走「跟随默认」行。
  it('stale catalog pin row closes without rewriting; clearing goes through the default row', async () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const setCindyPref = vi.fn(async () => ({ overrides: {} }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          cindyPrefsSync: () => ({
            overrides: { 'text.oneshot': 'cat:gone:codex:retired-model' },
            image: { options: [], defaultModel: null },
            imageEdit: { options: [], defaultModel: null },
            video: { options: [], defaultModel: null },
            videoEdit: { options: [], defaultModel: null },
            text: {
              options: [
                {
                  id: 'cat:xd:codex:codex/gpt-5.5',
                  label: 'Codex · GPT 5.5 折扣 · GW',
                  group: 'GW',
                  providerId: 'xd',
                  agentKind: 'codex',
                  modelId: 'codex/gpt-5.5',
                  modelName: 'GPT 5.5 折扣',
                  budget: true,
                  subscription: false,
                },
              ],
              defaultModel: { id: 'codex-gpt-5.4-mini', label: 'gpt-5.4-mini · Codex' },
              utilityProfiles: [],
            },
          }),
          setCindyPref,
        },
      },
    });

    render(
      <CindyCapabilityPrefs
        ghostId="xdt-knowledge"
        capabilities={['text.oneshot']}
        appearance="plugin"
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.ghosts.detail.cindyPrefs.cap.text.oneshot' }),
    );
    const agentList = await screen.findByRole('listbox');
    fireEvent.click(agentList.querySelector('[data-agent-kind="codex"]')!);
    const listbox = await screen.findByRole('listbox');
    // stale 行如实显示原值且为当前选中;点它不回写。
    const staleRow = within(listbox).getByText('cat:gone:codex:retired-model').closest('button')!;
    expect(staleRow.getAttribute('aria-selected')).toBe('true');
    fireEvent.click(staleRow);
    expect(setCindyPref).not.toHaveBeenCalled();

    // 重新展开,点「跟随默认」清钉(model=null)。
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.ghosts.detail.cindyPrefs.cap.text.oneshot' }),
    );
    const reopened = await screen.findByRole('listbox');
    fireEvent.click(within(reopened).getAllByRole('option')[0]!);
    expect(setCindyPref).toHaveBeenCalledWith('xdt-knowledge', 'text.oneshot', null);
    vi.unstubAllEnvs();
  });

  it('keeps a reset entry for a stale media override when the catalog has no models', async () => {
    const setCindyPref = vi.fn(async () => ({ overrides: {} }));
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          cindyPrefsSync: () => ({
            overrides: { 'video.generate': 'retired-video-model' },
            image: {
              options: [
                {
                  id: 'image-default',
                  label: 'Image Default',
                  providerId: 'xd',
                  providerName: 'Cindy AI',
                },
              ],
              defaultModel: {
                id: 'image-default',
                label: 'Image Default',
                providerId: 'xd',
                providerName: 'Cindy AI',
              },
            },
            imageEdit: {
              options: [{ id: 'image-edit', label: 'Image Edit' }],
              defaultModel: { id: 'image-edit', label: 'Image Edit' },
            },
            // 目录没给视频清单 = 能力暂不可用。
            video: { options: [], defaultModel: null },
            videoEdit: { options: [], defaultModel: null },
          }),
          setCindyPref,
        },
      },
    });

    const { container } = render(
      <CindyCapabilityPrefs
        ghostId="builtin.example"
        capabilities={['image.generate', 'video.generate', 'video.edit']}
        appearance="plugin"
      />,
    );

    // 三行都在(插件确实申请了这三项能力),但只有图像那行给下拉。
    expect(container.querySelectorAll('.cindy-capability-row')).toHaveLength(3);
    expect(screen.getAllByRole('combobox')).toHaveLength(1);

    const empties = container.querySelectorAll('.cindy-capability-empty');
    expect(empties).toHaveLength(1);
    expect(empties[0]!.textContent).toBe('No models available');
    expect(empties[0]!.className).toContain('text-[var(--text-tertiary)]');

    fireEvent.click(screen.getByRole('button', { name: 'Restore default' }));
    await waitFor(() => {
      expect(setCindyPref).toHaveBeenCalledWith('builtin.example', 'video.generate', null);
    });
  });

  it('shows only the Tool description after an explicit click', async () => {
    render(
      <ToolDescriptionChip
        tool={{
          name: 'render_image',
          description: 'Render an image from the current prompt.',
          parameters: {
            type: 'object',
            properties: { prompt: { type: 'string' } },
          },
        }}
      />,
    );

    const trigger = screen.getByRole('button', { name: 'Open render_image' });
    fireEvent.mouseEnter(trigger);
    fireEvent.focus(trigger);
    expect(screen.queryByText('Render an image from the current prompt.')).toBeNull();

    fireEvent.click(trigger);

    expect(await screen.findByText('Render an image from the current prompt.')).toBeTruthy();
    expect(screen.queryByText('prompt')).toBeNull();
    expect(screen.queryByText('JSON Schema')).toBeNull();
  });

  function stubToolPermissionApi(overrides?: {
    config?: Record<string, unknown> | ((id: string) => Record<string, unknown>);
    readStatus?: 'missing' | 'readable' | 'unreadable';
    setToolPermissions?: (id: string, config: unknown) => Promise<unknown>;
  }) {
    const setToolPermissions = vi.fn(
      overrides?.setToolPermissions ?? (async () => ({ config: {} })),
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        ghosts: {
          toolPermissionsSync: (id: string) => ({
            config:
              typeof overrides?.config === 'function'
                ? overrides.config(id)
                : (overrides?.config ?? {}),
            readStatus: overrides?.readStatus ?? 'readable',
          }),
          setToolPermissions,
        },
      },
    });
    return setToolPermissions;
  }

  const sevenTools = Array.from({ length: 7 }, (_, index) => ({
    name: `tool_${index}`,
    description: `Tool ${index}`,
  }));

  it('keeps the Tools title count-free and puts the count in its own badge', () => {
    stubToolPermissionApi();
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const heading = screen.getByRole('heading', { name: 'Tools' });
    expect(heading).toBeTruthy();
    expect(heading.closest('section')?.className).not.toContain('border-t');
    // 计数是独立 badge,不写进标题文本。
    expect(screen.queryByRole('heading', { name: /Tools.*7/ })).toBeNull();
    expect(screen.getByText('7')).toBeTruthy();
    expect(screen.getByText('tool_0')).toBeTruthy();
  });

  // 回归锚点:档位值是 `always-allow` / `needs-approval`,locale 键名是 camelCase。
  // 按档位值拼 i18n key 会把原始 key 字符串显示给用户。
  it('labels the global policy with translated copy, never a raw i18n key', () => {
    stubToolPermissionApi();
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    expect(screen.getByText('Needs approval')).toBeTruthy();
    expect(screen.queryByText(/settings\.ghosts\.detail\./)).toBeNull();
  });

  it('exposes the selected permission through aria-pressed, not colour alone', () => {
    stubToolPermissionApi({ config: { tools: { tool_0: 'blocked' } } });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstRowGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    const pressed = within(firstRowGroup)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute('aria-label')).toBe('Blocked');
  });

  it('shows a newly added tool as needs-approval even when older tools were always-allow', () => {
    stubToolPermissionApi({
      config: {
        globalPolicy: 'always-allow',
        tools: { tool_0: 'always-allow' },
      },
    });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const newToolGroup = screen.getAllByRole('group', { name: /tool_1/ })[0];
    const pressed = within(newToolGroup)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute('aria-label')).toBe('Needs approval');
  });

  // 回归锚点:config 经 IPC 反序列化后是普通对象,工具名与 Object.prototype
  // 成员撞名(constructor/toString/valueOf/hasOwnProperty/__proto__)时,裸
  // 下标 `tools?.[toolName]` 会读到原型链上的方法(truthy 但不是合法档位),
  // 把 globalPolicy 的继承短路掉。旧 bug 下没有任何按钮命中 mode(函数值
  // 不等于任何档位字符串);修复后必须落回 globalPolicy 的 blocked。
  it('does not let a tool named "constructor" bypass a blocked global policy', () => {
    stubToolPermissionApi({ config: { globalPolicy: 'blocked', tools: {} } });
    render(
      <ToolsSection
        ghostId="demo-ghost"
        tools={[{ name: 'constructor', description: 'Collides with Object.prototype' }]}
      />,
    );

    const group = screen.getAllByRole('group', { name: /constructor/ })[0];
    const pressed = within(group)
      .getAllByRole('button')
      .filter((button) => button.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(1);
    expect(pressed[0].getAttribute('aria-label')).toBe('Blocked');
  });

  it('materializes inherited blocked tools before saving one customized row', async () => {
    const setToolPermissions = stubToolPermissionApi({
      config: {
        globalPolicy: 'blocked',
        tools: { tool_0: 'blocked' },
      },
    });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    fireEvent.click(within(firstGroup).getByRole('button', { name: 'Always allow' }));

    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(1));
    expect(setToolPermissions).toHaveBeenCalledWith('demo-ghost', {
      globalPolicy: 'custom',
      tools: {
        tool_0: 'always-allow',
        tool_1: 'blocked',
        tool_2: 'blocked',
        tool_3: 'blocked',
        tool_4: 'blocked',
        tool_5: 'blocked',
        tool_6: 'blocked',
      },
    });
  });

  it('drops permission keys removed from the current manifest when saving', async () => {
    const setToolPermissions = stubToolPermissionApi({
      config: {
        globalPolicy: 'custom',
        tools: { removed_tool: 'always-allow', tool_0: 'blocked' },
      },
    });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    fireEvent.click(within(firstGroup).getByRole('button', { name: 'Always allow' }));

    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(1));
    const saved = setToolPermissions.mock.calls[0]?.[1] as {
      tools?: Record<string, unknown>;
    };
    expect(saved.tools).not.toHaveProperty('removed_tool');
    expect(Object.keys(saved.tools ?? {})).toEqual(sevenTools.map((tool) => tool.name));
  });

  it('disables tool permission editing when the config file is unreadable', () => {
    stubToolPermissionApi({ readStatus: 'unreadable' });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    expect(screen.getByText('Tool permissions are temporarily unavailable. Please try again later.')).toBeTruthy();
    const buttons = screen.getAllByRole('button', { name: /Always allow|Needs approval|Blocked/ });
    for (const button of buttons) {
      expect(button).toHaveProperty('disabled', true);
    }
    // 不可读状态下点击不会触发保存。
    fireEvent.click(buttons[0]);
    expect(window.electronAPI.ghosts.setToolPermissions).not.toHaveBeenCalled();
  });

  it('collapses the tool list without losing the global policy control', () => {
    stubToolPermissionApi();
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const toggle = screen.getByRole('button', { expanded: true });
    fireEvent.click(toggle);

    expect(screen.queryByText('tool_0')).toBeNull();
    expect(screen.getByText('Needs approval')).toBeTruthy();
  });

  it('rolls the switch back and warns when the permission fails to persist', async () => {
    // 安全设置写盘失败却把 UI 留在新档位 = 告诉用户"已阻止"而实际没拦。
    const setToolPermissions = vi.fn(async () => {
      throw new Error('ipc denied');
    });
    stubToolPermissionApi({ setToolPermissions });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstRowGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    const blockedButton = within(firstRowGroup).getByRole('button', { name: 'Blocked' });
    fireEvent.click(blockedButton);

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalled());
    expect(setToolPermissions).toHaveBeenCalledWith(
      'demo-ghost',
      expect.objectContaining({ tools: expect.objectContaining({ tool_0: 'blocked' }) }),
    );
    await waitFor(() =>
      expect(blockedButton.getAttribute('aria-pressed')).toBe('false'),
    );
  });

  it('does not let an older failed save roll back a newer successful policy', async () => {
    let rejectFirst!: (reason?: unknown) => void;
    const firstSave = new Promise<unknown>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const setToolPermissions = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockResolvedValueOnce({ config: {} });
    stubToolPermissionApi({ setToolPermissions });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    const secondGroup = screen.getAllByRole('group', { name: /tool_1/ })[0];
    fireEvent.click(within(firstGroup).getByRole('button', { name: 'Blocked' }));
    fireEvent.click(within(secondGroup).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(2));

    rejectFirst(new Error('older write failed late'));
    await Promise.resolve();

    expect(
      within(firstGroup).getByRole('button', { name: 'Blocked' }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      within(secondGroup)
        .getByRole('button', { name: 'Always allow' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('rolls back to the last disk-confirmed config, not an unconfirmed intermediate value, when two consecutive saves both fail', async () => {
    // 回归 Greptile P1:旧实现的回滚目标是"上一次点击时的乐观值"
    // (configRef.current)，不是磁盘上真正确认过的配置。连续两次写都失败
    // 时，第二次的回滚会退到第一次那个同样从未落盘成功的中间态——UI 显示
    // 的安全策略（"已阻止"/"总是允许"）会和磁盘实际生效的策略不一致，这是
    // 安全设置，不能凭空停在一个磁盘上从未真正出现过的状态。
    let rejectFirst!: (reason?: unknown) => void;
    let rejectSecond!: (reason?: unknown) => void;
    const firstSave = new Promise<unknown>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const secondSave = new Promise<unknown>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const setToolPermissions = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockImplementationOnce(() => secondSave);
    stubToolPermissionApi({ setToolPermissions });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    const secondGroup = screen.getAllByRole('group', { name: /tool_1/ })[0];
    fireEvent.click(within(firstGroup).getByRole('button', { name: 'Blocked' }));
    fireEvent.click(within(secondGroup).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(2));

    rejectFirst(new Error('first write failed'));
    await Promise.resolve();
    rejectSecond(new Error('second write failed'));
    await Promise.resolve();
    await Promise.resolve();

    // 只有最新一次(第二次)的失败才应该触发回滚与提示；第一次是被后一次
    // 请求取代的旧请求，它的失败必须被忽略，不能再弹一次。
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));
    // 磁盘上从未真正出现过 tool_0=blocked(两次写都失败)，必须退回到最初
    // 的确认态(needs-approval)，不能停在中间那个从未确认过的乐观值上。
    expect(
      within(firstGroup)
        .getByRole('button', { name: 'Needs approval' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(
      within(secondGroup)
        .getByRole('button', { name: 'Needs approval' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('records a stale-dispatched success into the confirmed baseline so a later failure rolls back to it, not to the pre-edit config', async () => {
    // 回归 Greptile 又发现的 P1:上一条修复给成功路径也套用了"只有序号匹配
    // 当前最新一次请求才生效"的过滤，但这是错的——第一次请求真的成功落盘
    // 了，只是它发起时不再是"当前最新"（第二次此时已经发起），如果因此把
    // 这次成功当没发生过而丢弃，第二次失败时的回滚就会拿一个"两次编辑前"
    // 的过期快照，而不是真正落盘的状态。
    let resolveFirst!: (value: unknown) => void;
    let rejectSecond!: (reason?: unknown) => void;
    const firstSave = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const secondSave = new Promise<unknown>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const setToolPermissions = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockImplementationOnce(() => secondSave);
    stubToolPermissionApi({ setToolPermissions });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    const secondGroup = screen.getAllByRole('group', { name: /tool_1/ })[0];
    fireEvent.click(within(firstGroup).getByRole('button', { name: 'Blocked' }));
    fireEvent.click(within(secondGroup).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(2));

    resolveFirst({ config: {} });
    await Promise.resolve();
    await Promise.resolve();
    rejectSecond(new Error('second write failed'));
    await Promise.resolve();
    await Promise.resolve();

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));
    // 第一次真的落盘成功了：tool_0 必须还是 Blocked，不能被第二次的回滚
    // 抹掉、退回最初的 needs-approval。
    expect(
      within(firstGroup).getByRole('button', { name: 'Blocked' }).getAttribute('aria-pressed'),
    ).toBe('true');
    // 第二次没有成功落盘：tool_1 必须回到确认过的状态(needs-approval)，
    // 不能停在它自己那次失败的乐观值(always-allow)上。
    expect(
      within(secondGroup)
        .getByRole('button', { name: 'Needs approval' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('redisplays a late-arriving success after an earlier rollback, instead of leaving the UI on the rolled-back state', async () => {
    // 回归 Greptile 又发现的 P1:上一条修复让成功回执更新 confirmedConfigRef
    // 这本账，但没有同步更新真正渲染到界面上的 loaded/configRef。如果顺序
    // 是"较新请求先失败(把界面回滚到旧状态)、较早请求后成功(只更新了账，
    // 没碰界面)"，界面会停在回滚后的旧状态，而磁盘上其实是较早请求成功
    // 写入的新状态——界面和磁盘又对不上了。
    let rejectSecond!: (reason?: unknown) => void;
    let resolveFirst!: (value: unknown) => void;
    const firstSave = new Promise<unknown>((resolve) => {
      resolveFirst = resolve;
    });
    const secondSave = new Promise<unknown>((_resolve, reject) => {
      rejectSecond = reject;
    });
    const setToolPermissions = vi
      .fn()
      .mockImplementationOnce(() => firstSave)
      .mockImplementationOnce(() => secondSave);
    stubToolPermissionApi({ setToolPermissions });
    render(<ToolsSection ghostId="demo-ghost" tools={sevenTools} />);

    const firstGroup = screen.getAllByRole('group', { name: /tool_0/ })[0];
    const secondGroup = screen.getAllByRole('group', { name: /tool_1/ })[0];
    fireEvent.click(within(firstGroup).getByRole('button', { name: 'Blocked' }));
    fireEvent.click(within(secondGroup).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(2));

    // 较新的请求(第二次)先失败，回滚界面到"两次编辑之前"。
    rejectSecond(new Error('second write failed'));
    await Promise.resolve();
    await Promise.resolve();
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));
    expect(
      within(firstGroup)
        .getByRole('button', { name: 'Needs approval' })
        .getAttribute('aria-pressed'),
    ).toBe('true');

    // 较早的请求(第一次)姗姗来迟才成功——它真的落盘了，界面必须补画出来。
    resolveFirst({ config: {} });
    await waitFor(() =>
      expect(
        within(firstGroup).getByRole('button', { name: 'Blocked' }).getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    // 第二次没有成功，tool_1 仍然停在回滚后的确认态。
    expect(
      within(secondGroup)
        .getByRole('button', { name: 'Needs approval' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    // 迟到的成功不应该再弹一次失败提示。
    expect(toastMocks.error).toHaveBeenCalledTimes(1);
  });

  it('does not let a failed save from the previous ghost poison the current config ref', async () => {
    let rejectPreviousGhost!: (reason?: unknown) => void;
    const previousSave = new Promise<unknown>((_resolve, reject) => {
      rejectPreviousGhost = reject;
    });
    const setToolPermissions = vi
      .fn()
      .mockImplementationOnce(() => previousSave)
      .mockResolvedValueOnce({ config: {} });
    stubToolPermissionApi({
      config: (id) =>
        id === 'ghost-a'
          ? { tools: { tool_0: 'blocked' } }
          : { tools: { tool_2: 'always-allow' } },
      setToolPermissions,
    });
    const { rerender } = render(<ToolsSection ghostId="ghost-a" tools={sevenTools} />);

    const ghostAGroup = screen.getAllByRole('group', { name: /tool_1/ })[0];
    fireEvent.click(within(ghostAGroup).getByRole('button', { name: 'Always allow' }));
    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(1));

    rerender(<ToolsSection ghostId="ghost-b" tools={sevenTools} />);
    await waitFor(() => {
      const ghostBSeedGroup = screen.getAllByRole('group', { name: /tool_2/ })[0];
      expect(
        within(ghostBSeedGroup)
          .getByRole('button', { name: 'Always allow' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
    });

    rejectPreviousGhost(new Error('ghost-a write failed after navigation'));
    await Promise.resolve();

    const ghostBEditGroup = screen.getAllByRole('group', { name: /tool_3/ })[0];
    fireEvent.click(within(ghostBEditGroup).getByRole('button', { name: 'Blocked' }));
    await waitFor(() => expect(setToolPermissions).toHaveBeenCalledTimes(2));
    expect(setToolPermissions).toHaveBeenLastCalledWith(
      'ghost-b',
      expect.objectContaining({
        tools: expect.objectContaining({ tool_2: 'always-allow', tool_3: 'blocked' }),
      }),
    );
    const lastConfig = setToolPermissions.mock.calls[1]?.[1] as {
      tools?: Record<string, unknown>;
    };
    // 当前 manifest 的所有工具会被实体化；tool_0 必须是 ghost-b
    // 自己的默认 needs-approval，不能泄入 ghost-a 的 blocked。
    expect(lastConfig.tools).toHaveProperty('tool_0', 'needs-approval');
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it('rolls a failed first save on a freshly switched ghost back to its own disk config, not the previous ghost’s', async () => {
    // 回归 Greptile 又发现的 P1:切插件那一轮渲染里，`setLoaded(...)` 只是
    // 排了队还没真正生效(React 丢弃本轮渲染输出、带新 state 重渲染)，这一轮
    // 的 `config` 变量此刻仍是"上一个插件"的值。`confirmedConfigRef` 的重置
    // 逻辑当时直接拿这个还没更新的 `config` 当新插件的确认基准存了进去——
    // ref 是直接赋值，不会跟着被丢弃的渲染输出一起撤销，于是新插件的确认
    // 基准被错误地钉死成了上一个插件的档位。如果新插件的第一次保存又失败，
    // 回滚会把上一个插件的档位错误地画到新插件身上。
    const setToolPermissions = vi.fn(async () => {
      throw new Error('first save on the new ghost failed');
    });
    stubToolPermissionApi({
      config: (id) =>
        id === 'ghost-a'
          ? { tools: { tool_0: 'blocked' } }
          : { tools: { tool_2: 'always-allow' } },
      setToolPermissions,
    });
    const { rerender } = render(<ToolsSection ghostId="ghost-a" tools={sevenTools} />);

    rerender(<ToolsSection ghostId="ghost-b" tools={sevenTools} />);
    await waitFor(() => {
      const ghostBSeedGroup = screen.getAllByRole('group', { name: /tool_2/ })[0];
      expect(
        within(ghostBSeedGroup)
          .getByRole('button', { name: 'Always allow' })
          .getAttribute('aria-pressed'),
      ).toBe('true');
    });

    // ghost-b 的第一次保存(切换后从未成功过任何一次写)失败。
    const ghostBEditGroup = screen.getAllByRole('group', { name: /tool_3/ })[0];
    fireEvent.click(within(ghostBEditGroup).getByRole('button', { name: 'Blocked' }));
    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledTimes(1));

    // 回滚必须退到 ghost-b 自己磁盘上的配置(tool_2=always-allow，其余默认
    // needs-approval)，不能是 ghost-a 的 tool_0=blocked。
    const tool0Group = screen.getAllByRole('group', { name: /tool_0/ })[0];
    expect(
      within(tool0Group).getByRole('button', { name: 'Needs approval' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const tool2Group = screen.getAllByRole('group', { name: /tool_2/ })[0];
    expect(
      within(tool2Group).getByRole('button', { name: 'Always allow' }).getAttribute('aria-pressed'),
    ).toBe('true');
    const tool3Group = screen.getAllByRole('group', { name: /tool_3/ })[0];
    expect(
      within(tool3Group).getByRole('button', { name: 'Needs approval' }).getAttribute('aria-pressed'),
    ).toBe('true');
  });

  it('shows every host permission except Tools and opens the same complete details', async () => {
    render(<PermissionSummary items={permissions} />);

    const networkLabel = screen.getByText('Access api.example.com');
    const permissionCard = networkLabel.closest('button');
    const commandLabel = screen.getByText('Command render');
    const cindyLabel = screen.getByText('Generate images');
    expect(permissionCard).toBeTruthy();
    expect(commandLabel.closest('button')).toBe(permissionCard);
    expect(cindyLabel.closest('button')).toBe(permissionCard);
    expect(within(permissionCard as HTMLButtonElement).queryByText('Tool render')).toBeNull();
    expect(permissionCard?.className).toContain('grid-cols-2');
    expect(permissionCard?.className).toContain('var(--surface-elevated)');
    expect(permissionCard?.className).toContain('p-4');
    expect(permissionCard?.className).toContain('gap-y-0');
    expect(networkLabel.parentElement?.className).toContain('min-h-9');
    expect(networkLabel.className).toContain('text-13');
    expect(networkLabel.className).toContain('font-normal');
    expect(networkLabel.className).toContain('break-words');
    expect(networkLabel.className).not.toContain('truncate');
    expect(networkLabel.className).not.toContain('font-medium');

    fireEvent.click(permissionCard as HTMLButtonElement);

    const dialog = await screen.findByRole('dialog');
    expect(dialog.querySelector('.lucide-globe')).toBeTruthy();
    expect(dialog.innerHTML).toContain('border-b-[0.5px]');
    expect(dialog.innerHTML).toContain('divide-y-[0.5px]');
    expect(within(dialog).getByText('Access api.example.com')).toBeTruthy();
    expect(within(dialog).getByText('Can access this declared domain.')).toBeTruthy();
    expect(within(dialog).getByText('Command render')).toBeTruthy();
    expect(within(dialog).queryByText('Tool render')).toBeNull();
    expect(within(dialog).getByText('Generate images')).toBeTruthy();
    // detailArgs 的 model 插值必须替换占位符,不能显示裸 {{model}}(Greptile 2026-08-07)。
    expect(
      within(dialog).getByText(
        'Takes effect when the model (codex/gpt-5.5) is available in the catalog.',
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByText(/Takes effect when the model \(\{\{model\}\}\)/)).toBeNull();
  });

  it('uses the same elevated theme surface for Tool bubbles and Permission cards', () => {
    render(
      <>
        <ToolDescriptionChip tool={{ name: 'render_image', description: 'Render an image.' }} />
        <PermissionSummary items={permissions} />
      </>,
    );

    expect(screen.getByRole('button', { name: 'Open render_image' }).className).toContain(
      'var(--surface-elevated)',
    );
    expect(screen.getByText('Access api.example.com').closest('button')?.className).toContain(
      'var(--surface-elevated)',
    );
  });

  it('lets the install location use the full details row and preserves its actions', async () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(300);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    render(<DetailsSection detail={detail} panelStatus="Docked" />);

    expect(screen.getByRole('heading', { name: 'Details' })).toBeTruthy();
    expect(screen.getByText('Version')).toBeTruthy();
    expect(screen.getByText('Author')).toBeTruthy();
    expect(screen.getByText('Identifier')).toBeTruthy();
    const detailsGrid = screen.getByText('Version').parentElement?.parentElement;
    expect(detailsGrid?.className).toContain('grid-cols-3');
    expect(detailsGrid?.className).not.toContain('border');
    expect(screen.getByText('v1.2.3').className).toContain('truncate');
    expect(screen.getByText('Contents')).toBeTruthy();
    expect(screen.queryByText('Source')).toBeNull();
    expect(screen.getByText('Panel')).toBeTruthy();
    expect(screen.getByText('Install Location')).toBeTruthy();
    const installLocation = screen.getByText('/tmp/cindy-brain/builtin.example');
    expect(installLocation.closest('.col-span-full')).toBeTruthy();
    expect(installLocation.className).toContain('truncate');
    expect(installLocation.className).toContain('whitespace-nowrap');
    expect(screen.queryByRole('button', { name: 'See All' })).toBeNull();

    const expandButton = screen.getByRole('button', { name: 'Show full Install Location' });
    expect(expandButton.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(expandButton);
    expect(installLocation.className).toContain('whitespace-pre-wrap');
    expect(installLocation.className).not.toContain('truncate');
    const collapseButton = screen.getByRole('button', { name: 'Collapse Install Location' });
    expect(collapseButton.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(collapseButton);
    expect(installLocation.className).toContain('truncate');
    expect(installLocation.className).toContain('whitespace-nowrap');

    fireEvent.click(screen.getByRole('button', { name: 'Copy Install Location' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('/tmp/cindy-brain/builtin.example'));

    const openPath = vi.fn().mockResolvedValue({ success: false, error: 'file locked' });
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { openPath },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open Install Location' }));
    await waitFor(() => expect(openPath).toHaveBeenCalledWith('/tmp/cindy-brain/builtin.example'));
    expect(toastMocks.error).toHaveBeenCalledWith('settings.ghosts.errors.generic');
  });

  it('does not add expand controls when detail values fit on one line', () => {
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(300);
    vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100);

    render(<DetailsSection detail={detail} panelStatus="Docked" />);

    expect(screen.queryByRole('button', { name: /Show full/ })).toBeNull();
  });

  it('keeps host permission guidance and author-provided OAuth scopes together', async () => {
    render(
      <PermissionSummary
        items={[
          permissions[0],
          {
            key: 'network:oauth',
            kind: 'network',
            labelKey: 'networkSecretOauth',
            detailKey: 'networkHostDetail',
            detail: 'scope.read\nscope.write',
          },
        ]}
      />,
    );

    fireEvent.click(
      screen.getByText('Access api.example.com').closest('button') as HTMLButtonElement,
    );
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getAllByText('Can access this declared domain.')).toHaveLength(2);
    expect(
      within(dialog).getByText((_, element) => element?.textContent === 'scope.read\nscope.write'),
    ).toBeTruthy();
  });
});
