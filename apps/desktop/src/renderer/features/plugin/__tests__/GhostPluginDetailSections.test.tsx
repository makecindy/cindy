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
        'settings.ghosts.detail.viewAllTools': 'See All',
        'settings.ghosts.detail.collapseTools': 'Show Less',
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
        'settings.providers.openai.title': 'OpenAI',
        'settings.providers.xd.title': 'Cindy AI',
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
                  label: 'Codex · GPT 5.5 折扣 · Cindy AI',
                  group: 'Cindy AI',
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
    expect(within(codexModels).getByText('Cindy AI')).toBeTruthy();
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
                  label: 'Codex · GPT 5.5 折扣 · Cindy AI',
                  group: 'Cindy AI',
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
                  label: 'Codex · GPT 5.5 折扣 · Cindy AI',
                  group: 'Cindy AI',
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

  it('keeps the Tools title count-free and puts See All beside the title', () => {
    render(
      <ToolsSection
        tools={Array.from({ length: 7 }, (_, index) => ({
          name: `tool_${index}`,
          description: `Tool ${index}`,
        }))}
      />,
    );

    const heading = screen.getByRole('heading', { name: 'Tools' });
    expect(heading).toBeTruthy();
    expect(heading.closest('section')?.className).not.toContain('border-t');
    expect(screen.queryByRole('heading', { name: /Tools.*7/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'See All' })).toBeTruthy();
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
