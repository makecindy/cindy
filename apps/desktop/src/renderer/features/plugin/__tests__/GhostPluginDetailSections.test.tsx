/**
 * Regression coverage for Plugin detail sections, optional Host task settings and interaction behavior.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import path from 'node:path';
import type { InstalledGhost } from '../../../../shared/ghost';
import type { PreparedPluginContribution } from '../../../../shared/pluginContributions';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

// This section fixture has no auth/device-link host. Source discovery has dedicated hook coverage.
vi.mock('@/hooks/useModelRouteDevices', () => ({
  useModelRouteDevices: () => ({ leadAgentDeviceId: null, devices: undefined }),
}));

vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [], providerOrder: [], loading: false }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: [], loading: false, unsupported: false }),
}));
vi.mock('@/hooks/useAgentCapabilities', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useAgentCapabilities')>()),
  useAgentCapabilities: () => ({ capabilities: null, loading: false }),
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));

vi.mock('@/lib/toast', () => ({ toast: toastMocks }));
vi.mock('@/cindy-brain/GhostSettingsWebview', () => ({
  GhostSettingsWebview: ({ account, reloadKey }: { account?: ReactNode; reloadKey?: number }) => (
    <>
      {account}
      <div key={reloadKey} data-testid="ghost-settings-webview" />
    </>
  ),
}));

// The shared-quota rail observes auth; this component fixture has no auth host.
const ownerGeneration = vi.hoisted(() => ({ value: 1 }));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuthUser: () => null,
  useOptionalDataOwnerGeneration: () => ownerGeneration.value,
}));

// 本文件只测详情页其它区块;介绍区带着完整 Markdown 渲染器(会初始化真实 i18n),另有专门测试。
vi.mock('../PluginReadmeSection', () => ({
  PluginReadmeSection: () => null,
  usePluginReadme: () => ({ readme: null, pending: false }),
}));

vi.mock('react-i18next', async () => {
  const { createInstance } = await import('i18next');
  const { default: common } = await import('../../../i18n/locales/en/common.json');
  const localized = createInstance();
  await localized.init({ lng: 'en', interpolation: { escapeValue: false }, resources: { en: { translation: common } } });
  return ({
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
        'settings.ghosts.detail.panelDismissed': 'Not docked',
        'settings.providers.openai.title': 'OpenAI',
        'settings.providers.xd.title': 'Cindy AI',
        'settings.defaults.restore': 'Restore default',
        'settings.ghosts.detail.oauthScopeStale':
          'This authorization does not include newly added permissions. Reconnect to enable them.',
      };
      return key.startsWith('settings.ghosts.perm.hostUi.') || key === 'settings.ghosts.detail.toolCount' ||
        key.startsWith('settings.ghosts.detail.infoPackageSize') ? localized.t(key, options) :
        labels[key] ?? (options?.value !== undefined ? `${options.value} ${key}` : key);
    },
    i18n: { language: 'en' },
  }),
  });
});

import type { GhostPermissionItem } from '../../../../shared/ghost';
import {
  DetailsSection,
  GhostPluginDetailView,
  PermissionSummary,
  ToolDescriptionChip,
  ToolsSection,
} from '../GhostPluginDetailView';
import { PluginDetailHero } from '../PluginDetailHero';
import { toGhostPluginDetail, type GhostPluginDetail } from '../lib/ghostPluginViewModel';
import { PLUGIN_MANAGEMENT_FRAME_CLASS } from '../PluginManagementLayout';
import { RemotePluginReadOnlyDetail } from '../RemotePluginReadOnlyDetail';
import { GhostAccountReuseSection } from '../GhostAccountReuseSection';

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
  ghostId: 'builtin.example',
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
  author: 'XD',
  contents: ['code'],
  permissions: [],
  tools: [],
  hasSettingsUi: false,
  hasTaskPreferences: false,
  hasPluginTasks: false,
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

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {

    },
  });
});

// Unit / round2 §4.2. Real detail markup with controlled viewport/record heights
// distinguishes successive layout passes and catches remeasurement after opening.
describe('detail content defaults', () => {
  const summary = 'Full description for the plugin with useful context.';
  const update = { version: '1.2.3', publishedAt: '2026-11-25T12:00:00Z', releaseNotes: 'Release notes' };
  const local = { ...detail, description: summary, origin: 'local' as const };
  const props = {
    ghost: null, detail: local, panelStatus: null, toggleDisabled: false,
    onBack: vi.fn(), onToggle: vi.fn(), onUse: vi.fn(), onUpdate: vi.fn(), onUpdateFromFile: vi.fn(), onUninstall: vi.fn(),
  };
  const recordRow = (name: string) => within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }))
    .getByText(name).closest('details')!;

  function geometry(height: number, bottom: (article: HTMLElement) => number, lines = 4) {
    const viewport = { height };
    const getStyle = window.getComputedStyle;
    const getRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, 'clientHeight', 'get').mockImplementation(function (this: Element) {
      return this.tagName === 'MAIN' ? viewport.height : 0;
    });
    vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = getStyle(element, pseudo);
      if (element.textContent === summary) style.lineHeight = '20px';
      return style;
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-plugin-detail-end')) return DOMRect.fromRect({ height: bottom(this.closest('article')!) });
      if (this.textContent === summary) return DOMRect.fromRect({ width: 400, height: lines * 20 });
      return getRect.call(this);
    });
    return viewport;
  }

  it.each([0, 800])('weighs no automatic expansion in a %i-pixel viewport without free space', height => {
    const measure = vi.fn(() => 820);
    geometry(height, measure);
    const { container } = render(<GhostPluginDetailView {...props} releaseUpdates={[update]} />);
    expect(recordRow('Permissions').open).toBe(false);
    expect(recordRow('Details').open).toBe(false);
    expect(screen.getByText(summary).classList.contains('line-clamp-2')).toBe(true);
    expect(screen.getByText(update.releaseNotes).classList.contains('line-clamp-4')).toBe(true);
    expect(measure).toHaveBeenCalledTimes(height ? 1 : 0);
    expect([...container.querySelectorAll('header dl dt')].map(label => label.textContent)).toEqual([
      'Version', 'Permissions', 'mcpApps.sourceLabel',
    ]);
  });

  it('leaves a three-line compact description in full', () => {
    geometry(800, () => 800, 3);
    render(<GhostPluginDetailView {...props} />);
    expect(screen.getByText(summary).classList.contains('line-clamp-2')).toBe(false);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.descriptionExpand' })).toBeNull();
  });

  it.each([[670, 2], [510, 3]])('measures each visible step from %i pixels and stops after %i passes', (initial, passes) => {
    const measure = vi.fn((article: HTMLElement) => {
      const description = article.querySelector('header p.line-clamp-6');
      const notes = article.querySelector('p[class~="line-clamp-[10]"]');
      return initial + (description ? 50 : 0) + (notes ? 170 : 0);
    });
    geometry(800, measure, 8);
    render(<GhostPluginDetailView {...props} releaseUpdates={[update]} />);
    expect(measure).toHaveBeenCalledTimes(passes);
    expect(screen.getByText(summary).classList.contains('line-clamp-6')).toBe(true);
    expect(screen.getByText(update.releaseNotes).classList.contains(passes === 3 ? 'line-clamp-[10]' : 'line-clamp-4')).toBe(true);
    expect(recordRow('Details').open).toBe(false);
    const collapse = within(screen.getByText(summary).closest('header')!)
      .getByRole('button', { name: 'settings.ghosts.detail.descriptionCollapse' });
    fireEvent.click(collapse);
    expect(screen.getByText(summary).classList.contains('line-clamp-2')).toBe(true);
  });

  it('skips missing blocks and retains the fitted layout, late data limits and user choices', () => {
    const measure = vi.fn(() => 430);
    const viewport = geometry(800, measure);
    const permissionsInput = Array.from({ length: 22 }, (_, index): GhostPermissionItem => ({
      key: `requested-${index}`, kind: 'code', labelKey: 'code',
    }));
    const tools = Array.from({ length: 60 }, (_, index) => ({ name: `tool_${index}`, description: 'Tool description' }));
    const model = { ...local, permissions: permissionsInput, tools };
    const { rerender } = render(<GhostPluginDetailView {...props} detail={model} />);
    const permissions = recordRow('Permissions');
    const facts = recordRow('Details');
    expect(measure).toHaveBeenCalledTimes(4); // compact, description, permissions, facts
    expect(permissions.open).toBe(true);
    expect(facts.open).toBe(true);
    expect(within(permissions).getAllByRole('listitem')).toHaveLength(3);
    expect(within(facts).getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(within(facts).getByRole('button', { name: 'settings.ghosts.detail.remainingPermissions' }));
    expect(within(facts).getAllByRole('listitem')).toHaveLength(60);
    fireEvent.click(within(facts).getByRole('button', { name: 'settings.ghosts.detail.descriptionCollapse' }));
    expect(within(facts).getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(permissions.querySelector('summary')!);
    expect(permissions.open).toBe(false);
    viewport.height = 450;
    fireEvent(window, new Event('resize'));
    rerender(<GhostPluginDetailView {...props} detail={model} releaseUpdates={[update]} publishingSection={<p>Publication status</p>} />);
    expect(measure).toHaveBeenCalledTimes(4);
    expect(screen.getByText(update.releaseNotes).classList.contains('line-clamp-4')).toBe(true);
    expect(facts.open).toBe(true);
    expect(permissions.open).toBe(false);
    fireEvent.click(permissions.querySelector('summary')!);
    expect(within(permissions).getAllByRole('listitem')).toHaveLength(5);
    fireEvent.click(within(permissions).getByRole('button', { name: 'settings.ghosts.detail.remainingPermissions' }));
    expect(within(permissions).getAllByRole('listitem')).toHaveLength(22);
  });

  it.each([false, true])('shares more plugins with a local installed detail only (remote=%s)', async remote => {
    const item: PluginMarketItem = {
      pluginId: 'example-more', ghostId: 'example-more', name: 'Nearby plugin', description: null, author: null,
      scope: 'public', publisherKind: 'personal', organizationId: null, defaultInstall: false,
      releaseId: 'release-more', version: '1.0', publishedAt: update.publishedAt,
      icon: null, installState: 'not-installed', enabled: null, sourceType: 'server', sourceMarketName: null,
    };
    const loadPage = vi.fn(async () => ({
      items: [item], nextCursor: null, counts: null, unavailableReason: null,
      customSourceNames: [], unavailableCustomSourceNames: [],
    }));
    render(<GhostPluginDetailView {...props} remote={remote}
      relatedCatalog={{ cache: {}, ownerKey: 'owner', catalogKey: 'en', local: true, loadPage }} onOpenRelated={vi.fn()} />);
    if (remote) {
      expect(screen.queryByRole('region', { name: 'settings.ghosts.detail.morePlugins' })).toBeNull();
      expect(loadPage).not.toHaveBeenCalled();
    } else {
      expect(await screen.findByRole('button', { name: item.name })).toBeTruthy();
      expect(loadPage).toHaveBeenCalledOnce();
    }
  });
});

// Tier 1: the real Host account controls must submit an exact chosen reference,
// revoke only the consuming account, and discard another owner's late reply.
// #10130: an ordinary credential declaration must not add an empty section to
// an existing plugin. Prior cases only exercised controls with usable sources.
it.each(['empty', 'available', 'in-use'] as const)('shows account reuse controls only for %s groups', async state => {
  const source = { instanceKey: 'source', secretKey: 'google', accountId: 'original',
    pluginName: 'Source', label: 'Saved account', scopes: ['read'] };
  const reusableAccounts = vi.fn(async () => [
    { key: 'unused', label: 'Unused credential', options: [], accounts: [] },
    { key: 'google', label: 'Google', options: state === 'available' ? [source] : [],
      accounts: state === 'in-use' ? [{ id: 'reference', label: 'Used account', status: 'connected' as const }] : [] },
  ]);
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts, reuseAccount: vi.fn() } });
  const { container } = render(<GhostAccountReuseSection ghostId="consumer" declared enabled={state !== 'in-use'} />);
  await act(async () => {});
  expect(reusableAccounts).toHaveBeenCalledOnce();
  expect(screen.queryByText('Unused credential')).toBeNull();
  if (state === 'empty') {
    expect(container.childElementCount).toBe(0);
  } else {
    expect(screen.getByText('settings.ghosts.detail.reuseAccountTitle')).toBeTruthy();
    if (state === 'available') expect(screen.getByRole('combobox')).toBeTruthy();
    else expect((screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' }) as HTMLButtonElement).disabled).toBe(false);
  }
});

// #10130 / 4560156890: backend revocation must project through the existing
// Refresh action, without inventing another UI state or reconnecting a source.
it.each(['archived', 'removed', 'replacement'] as const)('refreshes revoked source reuse as %s', async state => {
  const source = { kind: 'secret' as const, instanceKey: 'source', secretKey: 'token', accountId: 'saved',
    pluginName: 'Source', label: 'PAT', scopes: [] };
  let groups = [{ key: 'token', label: 'PAT', options: [source],
    accounts: [{ id: 'saved', label: 'PAT', status: 'connected' as 'connected' | 'expired' }] }];
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts: vi.fn(async () => groups), reuseAccount: vi.fn() } });
  const view = render(<GhostAccountReuseSection ghostId="consumer" declared enabled />);
  expect(await screen.findByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' })).toBeTruthy();
  groups = [{ key: 'token', label: 'PAT', options: state === 'replacement' ? [source] : [],
    accounts: state === 'archived' ? [{ id: 'saved', label: 'PAT', status: 'expired' }] : [] }];
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountRefresh' }));
  await waitFor(() => {
    if (state === 'removed') expect(view.container.childElementCount).toBe(0);
    else if (state === 'archived') {
      expect(screen.getByText('settings.ghosts.detail.reuseAccountUnavailable')).toBeTruthy();
      expect((screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' }) as HTMLButtonElement).disabled).toBe(false);
    } else {
      expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' })).toBeNull();
      expect((screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountUse' }) as HTMLButtonElement).disabled).toBe(true);
    }
  });
});

// A failed catalogue read is not a successful empty result: preserve the
// existing error and refresh path, then hide only after an empty read succeeds.
it('keeps the account catalogue error and refresh until a successful empty read', async () => {
  const reusableAccounts = vi.fn().mockRejectedValueOnce(new Error('PRECONDITION_FAILED')).mockResolvedValue([]);
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts, reuseAccount: vi.fn() } });
  const { container } = render(<GhostAccountReuseSection ghostId="consumer" declared enabled />);
  expect(await screen.findByText('settings.ghosts.detail.reuseAccountLoadFailed')).toBeTruthy();
  const refresh = screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountRefresh' }) as HTMLButtonElement;
  expect(refresh.disabled).toBe(false);
  fireEvent.click(refresh);
  await waitFor(() => expect(container.childElementCount).toBe(0));
  expect(reusableAccounts).toHaveBeenCalledTimes(2);
});

// #10130 / 5c89: initial-state cases miss an enabled flip after empty hiding.
// Unit tier: use the real section to expose newly available choices and discard
// a disabled catalogue reply, while retaining the existing Stop action.
it.each(['empty', 'pending'] as const)('reloads the account catalogue when enabling from %s', async initial => {
  let finish!: (value: unknown) => void;
  const reusableAccounts = vi.fn().mockImplementationOnce(() => initial === 'empty' ? Promise.resolve([])
    : new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue([{ key: 'google', label: 'Google', accounts: [], options: [
      { instanceKey: 'source', secretKey: 'google', accountId: 'original', pluginName: 'Source', scopes: ['read'] },
    ] }]);
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts, reuseAccount: vi.fn() } });
  const { container, rerender } = render(<GhostAccountReuseSection ghostId="consumer" declared enabled={false} />);
  await act(async () => {});
  expect(container.childElementCount).toBe(0);
  rerender(<GhostAccountReuseSection ghostId="consumer" declared enabled />);
  await act(async () => {});
  expect(reusableAccounts).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('combobox')).toBeTruthy();
  if (initial === 'pending') {
    await act(async () => { finish([]); });
    expect(screen.getByRole('combobox')).toBeTruthy();
  }
});

// #10130 / 4577503125: updating an enabled plugin can change its compatible
// sources without changing id, enabled or the presence of credential declarations.
// Unit tier: exercise the actual detail parent and existing unmount cleanup.
it.each(['empty', 'pending'] as const)('reloads a hidden account catalogue after an install revision changes from %s', async initial => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  let finish!: (value: unknown) => void;
  const reusableAccounts = vi.fn().mockImplementationOnce(() => initial === 'empty' ? Promise.resolve([])
    : new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue([{ key: 'token', label: 'PAT', accounts: [], options: [
      { kind: 'secret', instanceKey: 'source', secretKey: 'token', accountId: 'saved', pluginName: 'Source', scopes: [] },
    ] }]);
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts, reuseAccount: vi.fn() } });
  const detailAt = (revision: string) => <GhostPluginDetailView
    ghost={{ manifest: { schemaVersion: 2, id: detail.id, name: detail.name, version: detail.version,
      kind: 'chip', entry: 'main.js', network: { hosts: ['api.example.test'], secrets: [
        { key: 'token', label: 'PAT', inject: { header: 'Authorization', format: 'Bearer {value}' } },
      ] } },
      dir: detail.installDir!, enabled: true, approval: { state: 'approved', revision } }}
    detail={detail} panelStatus={null} onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()}
    onUpdate={vi.fn()} onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />;
  const { rerender } = render(detailAt('first-install'));
  await act(async () => {});
  expect(screen.queryByText('settings.ghosts.detail.reuseAccountTitle')).toBeNull();
  rerender(detailAt('updated-install'));
  await act(async () => {});
  expect(reusableAccounts).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('combobox')).toBeTruthy();
  if (initial === 'pending') {
    await act(async () => { finish([]); });
    expect(screen.getByRole('combobox')).toBeTruthy();
  }
});

it('keeps Stop using functional after disabling with an existing reference', async () => {
  let connected = true;
  const reusableAccounts = vi.fn(async () => [{ key: 'google', label: 'Google', options: [],
    accounts: connected ? [{ id: 'reference', label: 'Used account', status: 'connected' as const }] : [] }]);
  const reuseAccount = vi.fn(async () => { connected = false; return { ok: true }; });
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts, reuseAccount } });
  const { rerender } = render(<GhostAccountReuseSection ghostId="consumer" declared enabled />);
  await act(async () => {});
  rerender(<GhostAccountReuseSection ghostId="consumer" declared enabled={false} />);
  await act(async () => {});
  const stop = screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' }) as HTMLButtonElement;
  expect(stop.disabled).toBe(false);
  await act(async () => { fireEvent.click(stop); });
  expect(reuseAccount).toHaveBeenCalledWith('consumer', { kind: 'disconnect', secretKey: 'google', accountId: 'reference' });
  expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' })).toBeNull();
});

it.each([undefined, 'secret', 'connection'] as const)('selects an existing Host account or %s credential and stops only its consumer reference', async (kind) => {
  const scroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  try {
  const source = { ...(kind ? { kind } : {}), instanceKey: 'source', secretKey: 'google', accountId: 'original', pluginName: 'Source', label: 'account@example.test', scopes: ['read'] };
  let connected = false;
  const reusableAccounts = vi.fn(async () => [{ key: 'google', label: 'Google', options: [source],
    accounts: connected ? [{ id: 'consumer-reference', label: 'account@example.test', status: 'connected' as const }] : [] }]);
  const reuseAccount = vi.fn(async (_id: string, request: { kind: string }) => { connected = request.kind === 'connect'; return { ok: true }; });
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts, reuseAccount } });
  render(<GhostAccountReuseSection ghostId="consumer" declared enabled />);
  fireEvent.click(await screen.findByRole('combobox'));
  fireEvent.click(await screen.findByRole('option', { name: 'Source · account@example.test' }));
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountUse' }));
  await screen.findByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' });
  expect(reuseAccount).toHaveBeenCalledWith('consumer', { kind: 'connect', secretKey: 'google', source: { ...(kind ? { kind } : {}), instanceKey: 'source', secretKey: 'google', accountId: 'original' } });
  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.reuseAccountStop' })).toBeNull());
  expect(reuseAccount).toHaveBeenLastCalledWith('consumer', { kind: 'disconnect', secretKey: 'google', accountId: 'consumer-reference' });
  } finally {
    if (scroll) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scroll);
    else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

it('discards a late account catalogue after switching data owners', async () => {
  let finish!: (value: unknown) => void;
  const reusableAccounts = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue([{ key: 'new', label: 'Current owner credential', options: [],
      accounts: [{ id: 'new-reference', label: 'Current owner account', status: 'connected' }] }]);
  Object.assign(window.electronAPI, { ghosts: { reusableAccounts, reuseAccount: vi.fn() } });
  const view = <GhostAccountReuseSection ghostId="consumer" declared enabled />;
  const { rerender } = render(view);
  await waitFor(() => expect(reusableAccounts).toHaveBeenCalledOnce());
  ownerGeneration.value += 1;
  rerender(<GhostAccountReuseSection ghostId="consumer" declared enabled />);
  await waitFor(() => expect(reusableAccounts).toHaveBeenCalledTimes(2));
  await act(async () => { finish([{ key: 'old', label: 'Old owner credential', options: [],
    accounts: [{ id: 'old-reference', label: 'Old owner account', status: 'connected' }] }]); });
  expect(screen.queryByText('Old owner account')).toBeNull();
  expect(await screen.findByText('Current owner account')).toBeTruthy();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  toastMocks.success.mockReset();
  toastMocks.error.mockReset();
  Reflect.deleteProperty(window, 'electronAPI');
});

describe('Ghost plugin detail sections', () => {
  // Unit: the installed Host declarations previously added a supplementary
  // consent button. Only the pre-existing legacy page confirmation may remain.
  it.each([true, undefined] as const)('keeps Host UI out of the legacy page confirmation (%s)', uiCapabilityApproved => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved,
      approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'board', name: 'Board',
        version: '1', kind: 'chip', entry: 'main.js', tools: [], mcpApps: {
          ui: { resources: [{ uri: 'ui://board', file: 'board.html' }], tools: {} },
          host: { views: [{ id: 'board', title: 'Board', resourceUri: 'ui://board' }], capabilities: ['draft'] },
        } } };
    render(<GhostPluginDetailView ghost={ghost} detail={toGhostPluginDetail(ghost)} panelStatus={null}
      onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.installConsent.updateNeedsConsent' }) !== null).toBe(uiCapabilityApproved !== true);
  });

  // Unit: the real permission summary previously interpolated raw Host subjects.
  it('renders readable host capability details in the plugin permission summary', () => {
    const view = render(<PermissionSummary items={[{ key: 'ui:host:capability:draft', kind: 'panel',
      labelKey: 'uiHost', detailKey: 'uiHostAccess', detailArgs: { subject: 'capability:draft', access: 'draft' } }]} />);
    fireEvent.click(screen.getByText('Permissions').closest('summary')!);
    expect(screen.getByText('Read and edit the message draft')).toBeTruthy();
    expect(view.container.textContent).not.toContain('capability:draft');
  });

  // Unit / round2 §4.2: linked MCP tools have their own five-row limit,
  // independent of the tools in the facts accordion.
  it('reveals interaction-page tools after the first five without opening details', () => {
    const tools = Array.from({ length: 6 }, (_, index) => ({ name: `view_${index}`, description: 'Open a view' }));
    const ghost: InstalledGhost = { enabled: true, dir: '/fixture', uiCapabilityApproved: true,
      approval: { state: 'approved', revision: 'one' }, manifest: { schemaVersion: 3, id: 'board', name: 'Board',
        version: '1', kind: 'chip', entry: 'main.js', tools, mcpApps: {
          ui: { resources: [{ uri: 'ui://board', file: 'board.html' }],
            tools: Object.fromEntries(tools.map(tool => [tool.name, { resourceUri: 'ui://board' }])) },
        } } };
    render(<GhostPluginDetailView ghost={ghost} detail={toGhostPluginDetail(ghost)} panelStatus={null}
      onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    const heading = screen.getByRole('heading', { name: 'settings.ghosts.perm.mcpUi' });
    const interaction = within(heading.closest('section')!);
    expect(interaction.getAllByRole('listitem')).toHaveLength(5);
    const more = interaction.getByRole('button', { name: 'settings.ghosts.detail.remainingPermissions' });
    fireEvent.click(more);
    expect(interaction.getByText('view_5')).toBeTruthy();
    expect(screen.getByText('Details').closest('details')?.open).toBe(false);
    fireEvent.click(more);
    expect(interaction.queryByText('view_5')).toBeNull();
  });
  // Unit / round-4: installed detail no longer exposes personal call history.
  // Extend the remote-only regression to local detail; retain shared header metrics.
  it.each([false, true])('shows shared counts without personal usage for an installation (remote=%s)', remote => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const usageSummary = vi.fn();
    Object.assign(window.electronAPI, { ghosts: { usageSummary } });
    render(
      <GhostPluginDetailView
        remote={remote}
        ghost={{ manifest: { id: detail.ghostId }, enabled: true } as InstalledGhost}
        detail={detail}
        marketItem={
          {
            sourceType: 'server',
            scope: 'organization',
            downloadStatistics: { requestCount: '1284' },
          } as import('../../../../shared/pluginMarket').PluginMarketItem
        }
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
    expect(screen.getByRole('group', { name: '1,284 settings.ghosts.usage.downloadsValue' })).toBeTruthy();
    expect(screen.queryByText('settings.ghosts.usage.title')).toBeNull();
    expect(usageSummary).not.toHaveBeenCalled();
  });

  it('keeps unknown older-Host details honest and renders no local configuration or file actions', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const { container } = render(<RemotePluginReadOnlyDetail
      detail={{ id: '_ns__team__notes', name: 'Team notes', description: 'Installed on A' }}
      notice={<p>Read only on A</p>} loading={false} failed={false} online
      onBack={vi.fn()} onRetry={vi.fn()}
    />);
    expect(screen.getByRole('heading', { name: 'Team notes' })).toBeTruthy();
    expect(screen.getByText('_ns__team__notes')).toBeTruthy();
    expect(screen.getByText('settings.ghosts.remote.detailUnavailable')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('settings.ghosts.detail.configurationTitle')).toBeNull();
    expect(screen.queryByLabelText('Open Install Location')).toBeNull();
    expect(container.textContent).not.toMatch(/undefined|unverified|已停用|Disabled/);
  });
  it('renders Host permission descriptions in the read-only permission row and disables retry offline', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    render(<RemotePluginReadOnlyDetail
      detail={{ id: 'notes', name: 'Notes', description: '', permissions: [{ title: 'Read service', description: 'Only the declared service' }] }}
      notice={<p>Offline</p>} loading={false} failed online={false}
      onBack={vi.fn()} onRetry={vi.fn()}
    />);
    expect((screen.getByRole('button', { name: 'settings.ghosts.remote.refreshDetail' }) as HTMLButtonElement).disabled).toBe(true);
    const row = screen.getByText('Permissions').closest('details')!;
    expect(row.open).toBe(false);
    fireEvent.click(row.querySelector('summary')!);
    expect(row.open).toBe(true);
    expect(within(row).getByText('Only the declared service')).toBeTruthy();
  });
  it('shows installed notes immediately with tools inside the collapsed details row', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    render(<GhostPluginDetailView ghost={null} detail={{ ...detail, releaseNotes: 'Only version changes', tools: [{ name: 'example', description: 'Example tool' }] }} panelStatus={null}
      onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()}
      onUninstall={vi.fn()} toggleDisabled={false} />);
    expect(screen.getByText(detail.description)).toBeTruthy();
    const facts = screen.getByText('Details').closest('details')!;
    expect(facts.open).toBe(false);
    expect(within(facts).getByText('Tools').closest('details')).toBe(facts);
    const version = screen.getByRole('heading', { name: /recentUpdates/ }).closest('section')!;
    expect(within(version).getByText(`v${detail.version}`)).toBeTruthy();
    expect(within(version).getByText('Only version changes')).toBeTruthy();
  });

  it.each(['Changes in the target release', undefined])('shows the version of the available notes when target notes are %j', updateNotes => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    render(<GhostPluginDetailView ghost={null} detail={{ ...detail, releaseNotes: 'Installed release notes' }} panelStatus={null}
      onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()}
      updateVersion="1.2.4" updateNotes={updateNotes} onUninstall={vi.fn()} toggleDisabled={false} />);

    const version = screen.getByRole('heading', { name: /recentUpdates/ }).closest('section')!;
    expect(within(version).getByText(updateNotes ? 'v1.2.4' : `v${detail.version}`)).toBeTruthy();
    expect(within(version).getByText(updateNotes ?? 'Installed release notes')).toBeTruthy();
    if (updateNotes) expect(screen.getAllByText(updateNotes)).toHaveLength(1);

    const header = screen.getByRole('heading', { name: detail.name }).closest('header')!;
    const facts = screen.getByText('Details').closest('details')!;
    expect(within(header).getByText('settings.ghosts.detail.heroInstalledVersion', { selector: 'dt' })).toBeTruthy();
    expect(within(header).getByText('Permissions', { selector: 'dt' })).toBeTruthy();
    expect(within(facts).getByText(`v${detail.version}`)).toBeTruthy();
  });

  it.each(['pending', 'approved', 'rejected', 'cancelled'] as const)(
    'hides a submission that cannot be repeated for the %s version without showing publishing details', (status) => {
      vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
      const publish = vi.fn();
      const preview: PreparedPluginContribution = {
        preparedId: 'preview', instanceId: 'instance', pluginId: 'plugin', ghostId: 'example',
        name: detail.name, description: detail.description, version: '1.0.0', sha256: 'a'.repeat(64),
        sizeBytes: 100, releaseNotes: 'Complete package release notes', expiresAt: '2026-10-16T00:00:00.000Z',
        preflight: {
          subject: { authority: 'https://auth.example', membershipId: 'member' },
          queriedAt: '2026-10-16T00:00:00.000Z', policyVersion: 2,
          target: { pluginId: 'plugin', ghostId: 'example', version: '1.0.0', expectedRelease: null },
          pendingRelease: status === 'pending' ? { releaseId: 'release', version: '1.0.0' } : null,
          blockers: [{ code: 'VERSION_ALREADY_SUBMITTED', message: 'Change the version before publishing again' }],
          actions: { canSubmit: false },
        },
      };
      const view = (prepared: PreparedPluginContribution) => <GhostPluginDetailView
        ghost={null} detail={detail} panelStatus={null} onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()}
        onUpdate={vi.fn()} onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false}
        onContribute={publish} publishingPreview={prepared}
        contributionUnavailableReason={prepared.preflight?.actions.canSubmit ? undefined : 'Change the version before publishing again'} />;
      const { rerender } = render(view(preview));
      expect(screen.queryByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' })).toBeNull();
      expect(screen.getByText('Details').closest('details')?.open).toBe(false);
      expect(screen.queryByText('Change the version before publishing again')).toBeNull();
      expect(screen.queryByText('settings.ghosts.contribution.versionConsumedHint')).toBeNull();
      expect(screen.queryByText('Complete package release notes')).toBeNull();
      expect(publish).not.toHaveBeenCalled();
      // A previous cancelled/rejected/approved result does not hide a new eligible version.
      rerender(view({ ...preview, version: '1.1.0', preflight: { ...preview.preflight!, target: { ...preview.preflight!.target, version: '1.1.0' }, pendingRelease: null, blockers: [], actions: { canSubmit: true } } }));
      const submit = screen.getByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' });
      expect(submit).toHaveProperty('disabled', false);
      fireEvent.click(submit);
      expect(publish).toHaveBeenCalledOnce();
    },
  );

  it('keeps the local publishing entry in the use header without a publishing section', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const publish = vi.fn();
    render(<GhostPluginDetailView ghost={null} detail={detail} panelStatus={null}
      onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false}
      onContribute={publish} />);
    expect(screen.getByText('Details').closest('details')?.open).toBe(false);
    expect(screen.getByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' }).closest('header')).toBeTruthy();
    const chat = screen.getByRole('button', { name: 'settings.ghosts.detail.chatAction' });
    const actions = within(chat.closest('.plugin-detail-identity-actions') as HTMLElement);
    const action = actions.getByRole('button', { name: 'settings.ghosts.contribution.publishPlugin' });
    expect(actions.queryByRole('switch')).toBeNull();
    const enable = screen.getByRole('switch');
    expect(enable.closest('.plugin-detail-identity-enable')).toBeTruthy();
    expect(chat.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(action.compareDocumentPosition(enable) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('Example plugin')).toBeTruthy();
    fireEvent.click(action);
    expect(publish).toHaveBeenCalledOnce();
  });

  it('does not advertise host login for a locally imported unverified GitHub plugin', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const verify = vi.fn();
    Object.assign(window.electronAPI, { gitContext: { githubConnection: verify } });
    render(
      <GhostPluginDetailView
        ghost={
          { manifest: { id: 'cindy-github' }, enabled: true, trust: { level: 'unverified' } } as InstalledGhost
        }
        detail={{ ...detail, id: 'cindy-github', ghostId: 'cindy-github', hasSettingsUi: true }}
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
    expect(verify).not.toHaveBeenCalled();
  });

  it('omits configuration when GitHub CLI credentials are declared without a settings page', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    const ghost: InstalledGhost = {
      manifest: {
        schemaVersion: 3, minCindyVersion: '0.1.0', kind: 'chip',
        id: 'github-helper', name: detail.name, version: detail.version, entry: 'main.js',
        network: { hosts: ['api.github.com'], secrets: [{ key: 'github_pat', label: 'GitHub', source: 'gh-cli',
          inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.github.com'] } }] },
      },
      dir: '/tmp/plugin',
      enabled: true,
      approval: { state: 'approved', revision: 'rev-1' },
    };
    render(<GhostPluginDetailView ghost={ghost} detail={toGhostPluginDetail(ghost)} panelStatus={null}
      onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()}
      onUninstall={vi.fn()} toggleDisabled={false} />);
    expect(screen.queryByRole('heading', { name: 'settings.ghosts.detail.configurationTitle' })).toBeNull();
    expect(screen.queryByTestId('ghost-settings-webview')).toBeNull();
  });

  it.each([
    { layout: 'legacy', connection: { status: 'missing' } },
    { layout: 'root', connection: { status: 'auth', source: 'token' } },
    { layout: 'local', connection: { status: 'auth', source: 'token' } },
  ])(
    'connects GitHub in $layout layout and reloads settings after authorization',
    async ({ layout, connection }) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      Object.assign(window.electronAPI, {
        gitContext: {
          githubConnection: async () => connection,
          onGithubConnected: () => () => {},
          githubSetupStatus: async () => ({ phase: 'connected' }),
          startGithubSetup: async () => ({ phase: 'connected' }),
        },
      });
      const ghost: InstalledGhost = {
        manifest: { schemaVersion: 3, minCindyVersion: '0.1.0', kind: 'chip',
          id: layout === 'local' ? 'github-helper' : 'cindy-github', name: 'GitHub', version: '1.0.0', entry: 'main.js', settingsHtml: 'settings.html',
          network: { hosts: ['api.github.com'], secrets: [{ key: 'github_pat', label: 'GitHub', source: 'gh-cli',
            inject: { header: 'Authorization', format: 'Bearer {value}', hosts: ['api.github.com'] } }] } },
        dir: path.join('plugins', ...(layout === 'root' ? ['_ns', '_root'] : layout === 'local' ? ['_ns', 'local'] : []), layout === 'local' ? 'github-helper' : 'cindy-github'),
        namespace: layout === 'local' ? 'local' : null,
        enabled: true,
        approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000001' },
        trust: layout === 'local' ? undefined : { ...detail.trust, publisherName: 'Cindy Plugin Market' },
      };
      const { unmount } = render(
        <GhostPluginDetailView
          ghost={ghost}
          detail={toGhostPluginDetail(ghost)}
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
      const previousSettings = screen.getByTestId('ghost-settings-webview');
      fireEvent.click(await screen.findByText('ccAgent.gitContext.pr.setup.stages.login.title'));
      fireEvent.click(await screen.findByText('ccAgent.gitContext.pr.setup.connect'));
      await waitFor(() =>
        expect(screen.getByTestId('ghost-settings-webview')).not.toBe(previousSettings),
      );
      expect(screen.getByText('ccAgent.gitContext.pr.setup.done')).toBeTruthy();
      unmount();
    },
  );
  it('lets the owner explicitly choose a browser plugin instance', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const activateBrowser = vi.fn(async () => ({ ok: true }));
    Object.assign(window.electronAPI, { ghosts: { activateBrowser } });
    const ghost = { manifest: { browserExtension: { pageControl: true } }, enabled: true } as InstalledGhost;
    render(<GhostPluginDetailView ghost={ghost} detail={detail} panelStatus={null}
      onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    fireEvent.click(screen.getByText('settings.ghosts.detail.browserUse'));
    await waitFor(() => expect(activateBrowser).toHaveBeenCalledWith(detail.id));
    expect(await screen.findByText('settings.ghosts.detail.browserActivated')).toBeTruthy();
  });
  it('places Background Tasks after settings and before Tools for plugins declaring hiddenTasks', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const listBackgroundTasks = vi.fn(async () => ({ items: Array.from({ length: 6 }, (_, index) => ({
      taskId: `bg-${index}`, title: `Hidden grading ${index + 1}`, status: 'active' as const, updatedAt: Date.now(), running: false,
    })) }));
    Object.assign(window.electronAPI, { ghosts: { listBackgroundTasks, revealBackgroundTask: vi.fn() } });
    const ghost = { manifest: { agent: { tasks: true, hiddenTasks: true } }, enabled: true, taskCapabilityApproved: true } as InstalledGhost;
    render(<GhostPluginDetailView ghost={ghost} detail={{ ...detail, tools: [{ name: 'render', description: 'Render.' }] }} panelStatus="Docked" onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    expect(await screen.findByText('Hidden grading 1')).toBeTruthy();
    expect(listBackgroundTasks).toHaveBeenCalledWith(detail.id);
    const heading = screen.getByRole('heading', { name: 'settings.ghosts.backgroundTasks.title' });
    const tasks = within(heading.closest('section')!);
    expect(tasks.getAllByRole('listitem')).toHaveLength(5);
    const more = tasks.getByRole('button', { name: 'settings.ghosts.detail.remainingPermissions' });
    fireEvent.click(more);
    expect(tasks.getAllByRole('listitem')).toHaveLength(6);
    fireEvent.click(more);
    expect(tasks.queryByText('Hidden grading 6')).toBeNull();
    const tools = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }))
      .getByText('Tools').closest('details')!;
    expect(heading.compareDocumentPosition(tools) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Outside a router the open action is omitted; showing in the task list stays available.
    expect(screen.queryByRole('button', { name: 'settings.ghosts.backgroundTasks.open' })).toBeNull();
    expect(tasks.getAllByRole('button', { name: 'settings.ghosts.backgroundTasks.reveal' })).toHaveLength(5);
  });
  it('lets the user retry task permission, disables duplicate clicks, and hides after approval', async () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    let finish!: (value: { granted: boolean }) => void;
    const requestTaskApproval = vi.fn(() => new Promise<{ granted: boolean }>(resolve => { finish = resolve; }));
    Object.assign(window.electronAPI, { ghosts: { requestTaskApproval } });
    const ghost = { manifest: { agent: { tasks: true } }, enabled: true } as InstalledGhost;
    const view = (approved = false) => <GhostPluginDetailView ghost={{ ...ghost, ...(approved ? { taskCapabilityApproved: true as const } : {}) }} detail={detail} panelStatus="Docked" onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />;
    const { rerender } = render(view());
    const button = screen.getByRole('button', { name: 'settings.ghosts.perm.agentTasksRequest' }) as HTMLButtonElement;
    fireEvent.click(button); fireEvent.click(button);
    expect(requestTaskApproval).toHaveBeenCalledOnce();
    expect(requestTaskApproval).toHaveBeenCalledWith(detail.id);
    expect(button.disabled).toBe(true);
    finish({ granted: false });
    await waitFor(() => expect(button.disabled).toBe(false));
    rerender(view(true));
    expect(screen.queryByRole('button', { name: 'settings.ghosts.perm.agentTasksRequest' })).toBeNull();
  });
  // unit: a declined first-use observe prompt is not retried by the plugin; this Host button is the only re-approval path.
  it('offers a separate observe permission retry that requests only observe', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const requestTaskApproval = vi.fn(async () => ({ granted: false }));
    Object.assign(window.electronAPI, { ghosts: { requestTaskApproval } });
    const ghost = { manifest: { agent: { observe: true } }, enabled: true } as InstalledGhost;
    const view = (approved = false) => <GhostPluginDetailView ghost={{ ...ghost, ...(approved ? { observeCapabilityApproved: true as const } : {}) }} detail={detail} panelStatus="Docked" onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />;
    const { rerender } = render(view());
    expect(screen.queryByRole('button', { name: 'settings.ghosts.perm.agentTasksRequest' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.perm.agentObserveRequest' }));
    expect(requestTaskApproval).toHaveBeenCalledWith(detail.id, 'observe');
    rerender(view(true));
    expect(screen.queryByRole('button', { name: 'settings.ghosts.perm.agentObserveRequest' })).toBeNull();
  });
  // unit: a declined first-use companions prompt is not retried by the plugin; this Host button is the only re-approval path.
  it('offers a separate companions permission retry that requests only companions', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const requestTaskApproval = vi.fn(async () => ({ granted: false }));
    Object.assign(window.electronAPI, { ghosts: { requestTaskApproval } });
    const ghost = { manifest: { agent: { companions: true } }, enabled: true } as InstalledGhost;
    const view = (approved = false) => <GhostPluginDetailView ghost={{ ...ghost, ...(approved ? { companionsCapabilityApproved: true as const } : {}) }} detail={detail} panelStatus="Docked" onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />;
    const { rerender } = render(view());
    expect(screen.queryByRole('button', { name: 'settings.ghosts.perm.agentObserveRequest' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.perm.agentCompanionsRequest' }));
    expect(requestTaskApproval).toHaveBeenCalledWith(detail.id, 'companions');
    rerender(view(true));
    expect(screen.queryByRole('button', { name: 'settings.ghosts.perm.agentCompanionsRequest' })).toBeNull();
  });
  // Unit: accepted installation grants the manifest's Host declarations. The old
  // detail actions created a second grant; existing tasks/observe actions stay separate.
  it.each([
    { name: 'tool groups', manifest: { agent: { hostTools: ['history', 'future-group'] } } },
    { name: 'event topics', manifest: { subscribe: { topics: ['message', 'task-state'] } } },
  ])('shows no supplementary approval for installed host declarations: $name', ({ manifest }) => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const requestTaskApproval = vi.fn(async () => ({ granted: false }));
    Object.assign(window.electronAPI, { ghosts: { requestTaskApproval } });
    const ghost = { manifest, enabled: true, approval: { state: 'approved', revision: 'r1' } } as InstalledGhost;
    render(<GhostPluginDetailView ghost={ghost} detail={detail} panelStatus="Docked" onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    expect(screen.queryAllByRole('button', { name: 'settings.ghosts.perm.hostToolsRequest' })).toHaveLength(0);
    expect(requestTaskApproval).not.toHaveBeenCalled();
  });

  it('uses the shared Cindy Switch for the plugin enabled control', () => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const onToggle = vi.fn();
    const view = (disabled = false) => (
      <GhostPluginDetailView
        ghost={null}
        detail={detail}
        panelStatus="Docked"
        onBack={vi.fn()}
        onToggle={onToggle}
        onUse={vi.fn()}
        onUpdate={vi.fn()}
        onUpdateFromFile={vi.fn()}
        onUninstall={vi.fn()}
        toggleDisabled={disabled}
      />
    );
    const { rerender } = render(view());

    const toggle = screen.getByRole('switch', {
      name: 'settings.ghosts.enableAria',
    });
    expect(toggle.closest('.plugin-detail-identity-enable')).toBeTruthy();
    expect(toggle.className).toContain('cindy-switch');
    expect(toggle.className).toContain('data-[state=checked]:bg-[var(--switch-track-on)]');
    expect(toggle.firstElementChild?.className).toContain(
      'data-[state=checked]:bg-[var(--switch-thumb-on)]',
    );
    fireEvent.click(toggle);
    expect(onToggle.mock.calls).toEqual([[false]]);
    fireEvent.click(screen.getByText('settings.ghosts.detail.enabledLabel'));
    expect(onToggle.mock.calls).toEqual([[false], [false]]);
    rerender(view(true));
    fireEvent.click(toggle);
    fireEvent.click(screen.getByText('settings.ghosts.detail.enabledLabel'));
    expect(onToggle).toHaveBeenCalledTimes(2);
  });

  it('keeps a disabled management-only plugin’s switch in the banner without an action', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
    render(<GhostPluginDetailView ghost={null} detail={{ ...detail, enabled: false, tabPanel: false, canUse: false }}
      panelStatus={null} onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    const banner = screen.getByRole('heading', { name: detail.name }).closest('[data-v5-detail-header]')!;
    const toggle = within(banner as HTMLElement).getByRole('switch');
    expect(toggle.closest('.plugin-detail-identity-enable')).toBeTruthy();
    expect(toggle.getAttribute('aria-checked')).toBe('false');
    expect(within(banner as HTMLElement).getByText('settings.ghosts.detail.disabledLabel')).toBeTruthy();
    expect(banner.querySelector('.plugin-detail-identity-actions > *')).toBeNull();
  });

  it('renders a remote disabled notice without a configuration heading or local settings', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    render(
      <GhostPluginDetailView
        remote
        remoteConfiguration={<p>Enable this plugin before configuring.</p>}
        ghost={null}
        detail={{ ...detail, enabled: false, hasSettingsUi: true }}
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

    expect(screen.getByText('Enable this plugin before configuring.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'settings.ghosts.detail.configurationTitle' })).toBeNull();
    expect(screen.queryByTestId('ghost-settings-webview')).toBeNull();
  });

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

  it.each([false, true])('keeps the stale OAuth scope badge visible with authorization expired = %s', expired => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    const ghost: InstalledGhost = {
      manifest: {
        schemaVersion: 2,
        id: 'oauth-helper',
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
      oauthAuthorizationExpired: expired ? { expiredAccountCount: 1 } : undefined,
    };
    render(
      <GhostPluginDetailView
        ghost={ghost}
        detail={toGhostPluginDetail(ghost)}
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

    const configuration = within(screen.getByRole('region', { name: 'settings.ghosts.detail.configurationTitle' }));
    const header = within(screen.getByRole('heading', { level: 1 }).closest('header')!);
    const badge = header.getByText(/newly added permissions/).closest('[role="status"]')!;
    expect(badge.className).toContain('bg-[var(--warning-bg-soft)]');
    expect(header.queryByText('settings.ghosts.page.oauthAuthorizationExpired') !== null).toBe(expired);
    expect(configuration.getByTestId('ghost-settings-webview')).toBeTruthy();
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
    // 吸顶顶栏与正文共用列表内容框，进出详情时水平边缘对齐。
    const topBar = container.querySelector('[data-testid="plugin-detail-top-bar"]');
    const topBarFrame = topBar?.querySelector(':scope > div');
    const backButton = topBar?.querySelector('button');
    const detailHero = detailFrame?.querySelector('.plugin-detail-identity');
    expect(scrollSurface?.className).toContain('[scrollbar-gutter:stable_both-edges]');
    expect(detailFrame?.className).toContain('plugin-detail-frame');
    expect(detailFrame?.className).toContain(PLUGIN_MANAGEMENT_FRAME_CLASS);
    expect(topBar?.className).toContain('sticky');
    expect(topBarFrame?.className).toContain(PLUGIN_MANAGEMENT_FRAME_CLASS);
    expect(backButton?.className).toContain('-ml-3');
    expect(detailHero?.querySelector('h1')).toBeTruthy();
    expect(detailHero?.querySelector('.plugin-detail-identity-controls .plugin-detail-identity-actions')).toBeTruthy();
    expect(detailHero?.nextElementSibling?.classList.contains('plugin-detail-hero-facts')).toBe(true);
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
      expect(screen.queryByRole('button', { name: 'settings.ghosts.detail.chatAction' })).toBeNull();

      // 共享 Switch 和关联文字标签遵循同一禁用门控。
      const toggle = screen.getByRole('switch', {
        name: 'settings.ghosts.enableAria',
      }) as HTMLButtonElement;
      expect(toggle.closest('.plugin-detail-identity-enable')).toBeTruthy();
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

  it('does not offer in-place file updates for a market instance', () => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    const ghost = { manifest: { id: detail.ghostId, name: detail.name, version: '1.0.0', entry: 'main.js' },
      dir: '/plugins/market', enabled: true, namespace: null, namespaceState: 'confirmed',
      publishingSource: { kind: 'public-market', pluginId: 'published' },
      approval: { state: 'approved', revision: 'receipt' } } as InstalledGhost;
    const update = vi.fn();
    render(<GhostPluginDetailView ghost={ghost} detail={detail} panelStatus={null} onBack={vi.fn()}
      onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()} onUpdateFromFile={update}
      onUninstall={vi.fn()} toggleDisabled={false} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
      { button: 0, ctrlKey: false });
    expect(screen.queryByRole('menuitem', { name: 'settings.ghosts.detail.updateFromFile' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'settings.ghosts.uninstall' })).toBeTruthy();
    expect(update).not.toHaveBeenCalled();
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
    // vitest 默认 DEV=true,这里显式模拟打包产物(DEV=false)。
    vi.stubEnv('DEV', false);
    // 显式标注类型:JSX prop 位置的内联展开会让 tsc 现推一个巨大的匿名类型,
    // desktop 的 typecheck 本就贴着 CI 的 4GB 堆上限跑,能省则省。
    const officialDetail: GhostPluginDetail = { ...detail, id: 'cindy-art', ghostId: 'cindy-art' };
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
    ).toBeTruthy();
    expect(screen.queryByRole('separator')).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'settings.ghosts.uninstall' })).toBeTruthy();
    vi.unstubAllEnvs();
  });

  it.each(['builtin.example', 'xd-ordinary', 'filo-ordinary'])(
    'keeps the local .cindy update entry actionable for ordinary root %s',
    async (ghostId) => {
      vi.stubGlobal(
        'ResizeObserver',
        class {
          observe() {}
          unobserve() {}
          disconnect() {}
        },
      );
      vi.stubEnv('DEV', false);
      const onUpdateFromFile = vi.fn();
      const ordinaryDetail: GhostPluginDetail = { ...detail, id: ghostId, ghostId };
      render(
        <GhostPluginDetailView
          ghost={null}
          detail={ordinaryDetail}
          panelStatus={null}
          onBack={vi.fn()}
          onToggle={vi.fn()}
          onUse={vi.fn()}
          onUpdate={vi.fn()}
          onUpdateFromFile={onUpdateFromFile}
          onUninstall={vi.fn()}
          toggleDisabled={false}
        />,
      );

      fireEvent.pointerDown(
        screen.getByRole('button', { name: 'settings.ghosts.detail.moreActions' }),
        { button: 0, ctrlKey: false },
      );
      const updateItem = screen.getByRole('menuitem', {
        name: 'settings.ghosts.detail.updateFromFile',
      });
      expect(screen.getByRole('separator')).toBeTruthy();
      fireEvent.click(updateItem);
      expect(onUpdateFromFile).toHaveBeenCalledOnce();
      vi.unstubAllEnvs();
    },
  );

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

  it('puts the author below the name and omits a strip with a single fact', () => {
    const { container } = render(<PluginDetailHero id="example" name="Example" author="Cindy" version="1.1.4" />);
    expect(screen.getByText('Cindy').className).toContain('text-[var(--text-secondary)]');
    expect(container.querySelector('.plugin-detail-identity-controls > *')).toBeNull();
    expect(container.querySelector('dl')).toBeNull();
  });

  // Unit: the published size is identified by the visible version, including on another computer.
  it.each([
    [false, '1.2.3', 1_258_291, '1.2 MB'],
    [false, '1.2.2', 1_258_291, '1.2 MB (v1.2.3)'],
    [true, '1.2.2', 1_258_291, '1.2 MB (v1.2.3)'],
    [true, '1.2.3', undefined, undefined],
  ] as const)('shows package size (remote %s, installed %s, bytes %s)', (remote, installedVersion, sizeBytes, expected) => {
    const marketItem: PluginMarketItem = {
      pluginId: 'example-market', ghostId: detail.ghostId, name: detail.name, description: null, author: null,
      scope: 'public', organizationId: null, defaultInstall: false, sourceType: 'server', sourceMarketName: null,
      releaseId: 'current-release', ...(sizeBytes === undefined ? {} : { sizeBytes }),
      version: detail.version, publishedAt: '2026-11-25T00:00:00Z', icon: null,
      installState: 'update-available', enabled: true,
    };
    render(<GhostPluginDetailView ghost={null} remote={remote} detail={{ ...detail, version: installedVersion }} marketItem={marketItem}
      panelStatus={null} onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    const facts = within(screen.getByText('Details').closest('details')!);
    if (expected === undefined) {
      expect(facts.queryByText('Package size')).toBeNull();
    } else {
      const version = facts.getByText('Version').parentElement!;
      const size = facts.getByText('Package size').parentElement!;
      expect(version.nextElementSibling).toBe(size);
      expect(within(size).getByText(expected)).toBeTruthy();
    }
  });

  it('keeps the public badge in the hero and places installation and publisher details inside the record', () => {
    render(<GhostPluginDetailView
      ghost={null}
      detail={{ ...detail, origin: 'public', publisherKind: 'official', installationLabelKey: 'publicInstall',
        installationSource: { kind: 'market' } }}
      panelStatus={null} onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    const header = screen.getByRole('heading', { level: 1, name: detail.name }).closest('header')!;
    const source = 'settings.ghosts.detail.publicInstall';
    const publisher = 'settings.ghosts.market.publisherDescription.official';
    expect(within(header).queryByText(source)).toBeNull();
    expect(within(header).queryByText(publisher)).toBeNull();
    expect(within(header).getByText('settings.ghosts.market.publisherKind.official')).toBeTruthy();

    const record = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }));
    const summary = record.getByText('Details');
    fireEvent.click(summary);
    const facts = within(summary.closest('details')!);
    expect(facts.getByText(source)).toBeTruthy();
    expect(facts.getByText(publisher)).toBeTruthy();
  });

  it.each([
    { name: 'quick answers only', manifest: { cindy: { text: ['oneshot'] } }, taskRows: false, showCard: true },
    { name: 'plugin tasks', manifest: { agent: { tasks: true } }, taskRows: true, showCard: true },
    { name: 'legacy errands', manifest: { agent: { errand: true } }, taskRows: true, showCard: true },
    { name: 'workspaces', manifest: { workspace: true }, taskRows: true, showCard: true },
    { name: 'explicitly enabled tasks', manifest: { agent: { tasks: true }, showTaskPreferences: true }, taskRows: true, showCard: true },
    { name: 'opted-out tasks', manifest: { agent: { tasks: true }, showTaskPreferences: false }, taskRows: true, showCard: false },
    { name: 'opted-out quick answers', manifest: { cindy: { text: ['oneshot'] }, showTaskPreferences: false }, taskRows: false, showCard: false },
    { name: 'opted-out legacy errands', manifest: { agent: { errand: true }, showTaskPreferences: false }, taskRows: true, showCard: false },
    { name: 'opted-out workspaces', manifest: { workspace: true, showTaskPreferences: false }, taskRows: true, showCard: false },
  ])('respects Host task card visibility for $name', ({ manifest, taskRows, showCard }) => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    Object.assign(window.electronAPI, {
      ghosts: {
        errandPrefsSync: () => ({ config: {}, auxiliaryModelLabel: 'Grok 4.6' }),
        setErrandConfig: vi.fn(async () => ({ config: {} })),
      },
      showOpenDirectoryDialog: vi.fn(),
    });
    const ghost: InstalledGhost = {
      manifest: {
        schemaVersion: 3, minCindyVersion: '0.1.0', kind: 'chip', id: 'model-plugin',
        name: 'Model plugin', version: '1.0.0', entry: 'main.js',
        ...(manifest as Partial<InstalledGhost['manifest']>),
      },
      dir: '/plugins/model-plugin',
      namespace: null,
      enabled: true,
      approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000002' },
      ...(taskRows ? { taskCapabilityApproved: true as const } : {}),
      trust: detail.trust,
    };
    const projected = toGhostPluginDetail(ghost);
    expect(projected).toMatchObject({ hasTaskPreferences: showCard, hasPluginTasks: taskRows });
    render(
      <GhostPluginDetailView
        ghost={ghost}
        detail={projected}
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
    expect(screen.queryByText('settings.ghosts.detail.cindyPrefs.title')).toBeNull();
    if (!showCard) {
      expect(screen.queryByText('settings.ghosts.detail.errandPrefs.title')).toBeNull();
      expect(screen.queryByText('settings.ghosts.detail.errandPrefs.model')).toBeNull();
      expect(screen.queryByText('settings.ghosts.detail.errandPrefs.permission')).toBeNull();
      expect(screen.queryByText('settings.ghosts.detail.errandPrefs.workdir')).toBeNull();
      return;
    }
    expect(screen.getByText('settings.ghosts.detail.errandPrefs.title')).toBeTruthy();
    expect(screen.getAllByText('settings.ghosts.detail.errandPrefs.model')).toHaveLength(1);
    expect(screen.getByText(`settings.ghosts.detail.errandPrefs.${taskRows ? 'desc' : 'descModelOnly'}`)).toBeTruthy();
    expect(Boolean(screen.queryByText('settings.ghosts.detail.errandPrefs.permission'))).toBe(taskRows);
    expect(Boolean(screen.queryByText('settings.ghosts.detail.errandPrefs.workdir'))).toBe(taskRows);
  });

  it('does not show the model card for media-only plugins (media always follows the system default)', () => {
    const ghost: InstalledGhost = {
      manifest: {
        schemaVersion: 3, minCindyVersion: '0.1.0', kind: 'chip', id: 'art', name: 'Art',
        version: '1.0.0', entry: 'main.js', cindy: { image: ['generate', 'edit'], embed: ['text'] },
        showTaskPreferences: true,
      },
      dir: '/plugins/art',
      namespace: null,
      enabled: true,
      approval: { state: 'approved', revision: '00000000-0000-4000-8000-000000000003' },
      trust: detail.trust,
    };
    expect(toGhostPluginDetail(ghost)).toMatchObject({ hasTaskPreferences: false, hasPluginTasks: false });
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

  it('shows the total tool count and expands the entries after the first six in place', () => {
    const { container } = render(<ToolsSection tools={Array.from({ length: 7 }, (_, index) => ({
      name: `tool_${index}`, description: `Tool ${index}`,
    }))} />);
    expect(screen.getByRole('heading', { name: 'Tools 7 tools' })).toBeTruthy();
    expect(within(container).getAllByRole('listitem')).toHaveLength(6);
    const more = within(container).getByRole('button', { name: 'settings.ghosts.detail.remainingPermissions' });
    fireEvent.click(more);
    expect(within(container).getAllByRole('listitem')).toHaveLength(7);
    expect(screen.getByText('Tool 6')).toBeTruthy();
    fireEvent.click(more);
    expect(within(container).getAllByRole('listitem')).toHaveLength(6);
  });

  it('expands the complete non-tool permission list with the host wording', () => {
    render(<PermissionSummary items={permissions} />);
    const row = screen.getByText('Permissions').closest('details')!;
    expect(row.open).toBe(false);
    fireEvent.click(row.querySelector('summary')!);
    expect(row.open).toBe(true);
    expect(row.querySelector('.lucide-globe')).toBeTruthy();
    expect(within(row).getByText('Access api.example.com')).toBeTruthy();
    expect(within(row).getByText('Can access this declared domain.')).toBeTruthy();
    expect(within(row).getByText('Command render')).toBeTruthy();
    expect(within(row).queryByText('Tool render')).toBeNull();
    expect(within(row).getByText('Generate images')).toBeTruthy();
    expect(within(row).getByText('Takes effect when the model (codex/gpt-5.5) is available in the catalog.')).toBeTruthy();
    expect(within(row).queryByText(/Takes effect when the model \(\{\{model\}\}\)/)).toBeNull();
  });

  it('keeps a shared elevated surface for the installed information rows', () => {
    const { container } = render(<GhostPluginDetailView ghost={null}
      detail={{ ...detail, permissions, tools: [{ name: 'render_image', description: 'Render an image.' }] }}
      panelStatus={null} onBack={vi.fn()} onToggle={vi.fn()} onUse={vi.fn()} onUpdate={vi.fn()}
      onUpdateFromFile={vi.fn()} onUninstall={vi.fn()} toggleDisabled={false} />);
    const record = within(screen.getByRole('region', { name: 'settings.ghosts.detail.recordTitle' }));
    const tools = record.getByText('Tools').closest('details')!;
    const perms = record.getByText('Permissions').closest('details')!;
    expect(tools.previousElementSibling).toBe(perms);
    expect(container.querySelector('details')?.parentElement?.className).toContain('var(--settings-theme-card-bg)');
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

    fireEvent.click(screen.getByText('Details').closest('summary')!);
    expect(screen.getByText('Version')).toBeTruthy();
    expect(screen.getByText('Author')).toBeTruthy();
    expect(screen.getByText('Identifier')).toBeTruthy();
    const detailsGrid = screen.getByText('Version').parentElement?.parentElement;
    expect(detailsGrid?.className).toContain('sm:grid-cols-2');
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

    const row = screen.getByText('Permissions').closest('details')!;
    fireEvent.click(row.querySelector('summary')!);
    expect(within(row).getAllByText('Can access this declared domain.')).toHaveLength(2);
    expect(within(row).getByText((_, element) => element?.textContent === 'scope.read\nscope.write')).toBeTruthy();
  });
});

it('shows downloads and weekly uses in order before the installed version and update date', () => {
  const { container } = render(<PluginDetailHero id="example" name="Example" author="Cindy" version="1.7.5" versionLabel="installed" marketItem={{
    sourceType: 'server', scope: 'organization',
    downloadStatistics: { requestCount: '1284' }, publishedAt: '2026-10-13T12:00:00Z',
    usageStatistics: { usageCount: '8932', usageCountLast7Days: '0', asOf: '2026-10-13T00:00:00Z' },
  } as import('../../../../shared/pluginMarket').PluginMarketItem} />);
  expect([...container.querySelectorAll('dl dt')].map(label => label.textContent)).toEqual([
    'settings.ghosts.detail.heroDownloads', 'settings.ghosts.detail.heroWeeklyUsage',
    'settings.ghosts.detail.heroInstalledVersion', 'settings.ghosts.detail.heroLatestUpdate',
  ]);
  expect(screen.getByText('v1.7.5')).toBeTruthy();
  expect(screen.getByRole('group', { name: '1,284 settings.ghosts.usage.downloadsValue' })).toBeTruthy();
  expect(screen.getByRole('group', { name: 'settings.ghosts.detail.heroWeeklyUsage 0' })).toBeTruthy();
});

// Chat files handed to a plugin: the user sees each 7-day copy and deletes one
// only after confirming. Rule: plugin-security-and-authoring.md §4 handoff.
// Gap: new local section. Tier: renderer unit with the shared confirm dialog.
it('deletes one handed-over file only after confirmation', async () => {
  const { ConfirmDialogProvider } = await import('@/components/ui/confirm-dialog-provider');
  const { GhostHandoffFilesSection } = await import('../GhostHandoffFilesSection');
  const file = (name: string, n: number) => ({ ref: `handoff:0000000${n}-0000-4000-8000-000000000000`, name, mimeType: 'text/csv', size: 2048, sha256: 'a'.repeat(64), createdAt: 1, expiresAt: 2 });
  const [first, second] = [file('first.csv', 1), file('second.csv', 2)];
  const files = [first, second, ...Array.from({ length: 4 }, (_, index) => file(`file-${index + 3}.csv`, index + 3))];
  const handoffList = vi.fn().mockResolvedValueOnce(files).mockResolvedValue(files.slice(1));
  const handoffDelete = vi.fn(async () => ({ existed: true }));
  Object.assign(window.electronAPI, { ghosts: { handoffList, handoffDelete, handoffFolder: vi.fn(async () => null) } });
  render(<ConfirmDialogProvider><GhostHandoffFilesSection ghostId="art" declared /></ConfirmDialogProvider>);

  const row = (await screen.findByText('first.csv')).closest('li') as HTMLElement;
  const section = within(row.closest('section')!);
  expect(section.getAllByRole('listitem')).toHaveLength(5);
  const more = section.getByRole('button', { name: 'settings.ghosts.detail.remainingPermissions' });
  fireEvent.click(more);
  expect(section.getByText('file-6.csv')).toBeTruthy();
  fireEvent.click(more);
  expect(section.queryByText('file-6.csv')).toBeNull();
  fireEvent.click(within(row).getByRole('button'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'settings.ghosts.handoff.cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(handoffDelete).not.toHaveBeenCalled();

  fireEvent.click(within(row).getByRole('button'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'settings.ghosts.handoff.delete' }));
  await waitFor(() => expect(screen.queryByText('first.csv')).toBeNull());
  expect(handoffDelete).toHaveBeenCalledExactlyOnceWith('art', first.ref);
  expect(screen.getByText('second.csv')).toBeTruthy();
});

// Copies are account data: an account switch with the same instance id reloads the list.
it('reloads handed-over files when the data owner changes', async () => {
  const { ConfirmDialogProvider } = await import('@/components/ui/confirm-dialog-provider');
  const { GhostHandoffFilesSection } = await import('../GhostHandoffFilesSection');
  const file = (name: string) => ({ ref: 'handoff:00000000-0000-4000-8000-000000000009', name, mimeType: 'text/csv', size: 1, sha256: 'a'.repeat(64), createdAt: 1, expiresAt: 2 });
  const handoffList = vi.fn().mockResolvedValueOnce([file('owner-a.csv')]).mockResolvedValue([file('owner-b.csv')]);
  Object.assign(window.electronAPI, { ghosts: { handoffList, handoffDelete: vi.fn(), handoffFolder: vi.fn(async () => null) } });
  const view = (
    <ConfirmDialogProvider><GhostHandoffFilesSection ghostId="art" declared /></ConfirmDialogProvider>
  );
  ownerGeneration.value = 1;
  const { rerender } = render(view);
  await screen.findByText('owner-a.csv');
  ownerGeneration.value = 2;
  rerender(<ConfirmDialogProvider><GhostHandoffFilesSection ghostId="art" declared /></ConfirmDialogProvider>);
  await screen.findByText('owner-b.csv');
  expect(screen.queryByText('owner-a.csv')).toBeNull();
});

// The user can see the copies in Finder / Explorer; with nothing handed over the
// folder button stays unavailable. Tier: renderer unit through the real section.
it('opens the instance handoff folder only once a copy exists', async () => {
  const { ConfirmDialogProvider } = await import('@/components/ui/confirm-dialog-provider');
  const { GhostHandoffFilesSection } = await import('../GhostHandoffFilesSection');
  const copy = { ref: 'handoff:00000000-0000-4000-8000-000000000003', name: 'sales.csv', mimeType: 'text/csv', size: 1, sha256: 'a'.repeat(64), createdAt: 1, expiresAt: 2 };
  const handoffList = vi.fn().mockResolvedValueOnce([]).mockResolvedValue([copy]);
  const handoffFolder = vi.fn(async () => '/data/ghost-handoff/art');
  const openPath = vi.fn().mockResolvedValue({ success: true });
  Object.assign(window.electronAPI, { openPath, ghosts: { handoffList, handoffDelete: vi.fn(), handoffFolder } });
  render(<ConfirmDialogProvider><GhostHandoffFilesSection ghostId="art" declared /></ConfirmDialogProvider>);

  await screen.findByText('settings.ghosts.handoff.empty');
  const open = screen.getByRole('button', { name: /settings\.ghosts\.handoff\.openIn/ });
  expect(open).toHaveProperty('disabled', true);

  fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.handoff.refresh' }));
  await screen.findByText('sales.csv');
  expect(open).toHaveProperty('disabled', false);
  fireEvent.click(open);
  expect(openPath).toHaveBeenCalledExactlyOnceWith('/data/ghost-handoff/art');
  expect(handoffFolder).toHaveBeenCalledWith('art');
});

// Codex 4431547660: a delete that finishes after switching plugins must not show
// the previous plugin's files or folder. Tier: renderer unit, same mounted section.
it('ignores the refresh of a delete that finishes after switching plugins', async () => {
  const { ConfirmDialogProvider } = await import('@/components/ui/confirm-dialog-provider');
  const { GhostHandoffFilesSection } = await import('../GhostHandoffFilesSection');
  const copy = (id: string) => ({ ref: 'handoff:00000000-0000-4000-8000-000000000004', name: `${id}.csv`, mimeType: 'text/csv', size: 1, sha256: 'a'.repeat(64), createdAt: 1, expiresAt: 2 });
  let finishDelete!: () => void;
  const handoffDelete = vi.fn(() => new Promise<{ existed: boolean }>((resolve) => { finishDelete = () => resolve({ existed: true }); }));
  const handoffList = vi.fn(async (id: string) => [copy(id)]);
  const handoffFolder = vi.fn(async (id: string) => `/data/ghost-handoff/${id}`);
  Object.assign(window.electronAPI, { ghosts: { handoffList, handoffDelete, handoffFolder } });
  const view = (id: string) => <ConfirmDialogProvider><GhostHandoffFilesSection ghostId={id} declared /></ConfirmDialogProvider>;
  const { rerender } = render(view('plugin-a'));

  const row = (await screen.findByText('plugin-a.csv')).closest('li') as HTMLElement;
  fireEvent.click(within(row).getByRole('button'));
  fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'settings.ghosts.handoff.delete' }));
  await waitFor(() => expect(handoffDelete).toHaveBeenCalledOnce());
  rerender(view('plugin-b'));
  await screen.findByText('plugin-b.csv');
  finishDelete();
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  await new Promise((resolve) => setTimeout(resolve, 0));

  expect(screen.queryByText('plugin-a.csv')).toBeNull();
  expect(screen.getByText('plugin-b.csv')).toBeTruthy();
  expect(handoffList.mock.calls.map(([id]) => id)).toEqual(['plugin-a', 'plugin-b']);
});
