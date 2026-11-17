// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemotePluginUiEnablePrompt } from '@/components/new-chat/RemotePluginUiEnablePrompt';
import { RemotePluginPage } from '../RemotePluginPage';
import { resetPluginCatalogMemoryForTest } from '../lib/pluginCatalogMemory';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { projectPluginUiConsent } from '../../../../shared/pluginUiConsent';
import { ghostInstallApprovalToken } from '../../../../shared/ghost';
const { invoke, confirm, localGhosts, notices, directoryMode } = vi.hoisted(() => ({
  directoryMode: { real: false },
  notices: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn(), dismiss: vi.fn() },
  invoke: vi.fn(),
  confirm: vi.fn(async () => true),
  localGhosts: vi.fn(),
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [{ deviceId: 'computer-a', name: 'Execution computer',
    online: true, controlEnabled: true, remoteControlEnabled: true, isSelf: false, platform: 'darwin' }],
}));
vi.mock('../PluginDevicePicker', async importOriginal => {
  const original = await importOriginal<typeof import('../PluginDevicePicker')>();
  return { ...original, usePluginDeviceDirectory: (selected: Parameters<typeof original.usePluginDeviceDirectory>[0]) =>
    directoryMode.real ? original.usePluginDeviceDirectory(selected) : { online: true, target: { name: 'Execution computer' } } };
});
vi.mock('@/lib/toast', () => ({ toast: notices }));
vi.mock('@/components/new-chat/AddRemoteProjectDialog', () => ({
  AddRemoteProjectDialog: ({ fixedDeviceId, onProjectAdded, onOpenChange }: {
    fixedDeviceId: string;
    onProjectAdded(target: { kind: 'device-link'; deviceId: string; deviceName: string; path: string }): Promise<void>;
    onOpenChange(open: boolean): void;
  }) => <>
    <output>Browse {fixedDeviceId}</output>
    <button onClick={() => void onProjectAdded({ kind: 'device-link', deviceId: fixedDeviceId, deviceName: fixedDeviceId, path: '/target/browsed' }).then(() => onOpenChange(false))}>Select target folder</button>
    <button onClick={() => onOpenChange(false)}>Cancel folder</button>
  </>,
}));
vi.mock('@/cindy-brain/GhostSettingsWebview', () => ({
  GhostSettingsWebview: ({
    ghost,
    remoteDeviceId,
  }: {
    ghost: { instanceKey: string };
    remoteDeviceId: string;
  }) => (
    <output data-testid="original-settings">
      {remoteDeviceId}/{ghost.instanceKey}
    </output>
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  I18nextProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm }),
}));
vi.mock('../GhostPluginPage', () => ({
  GhostPluginCard: ({ item, onManage }: { item: { name: string }; onManage(): void }) => (
    <button onClick={onManage}>{item.name}</button>
  ),
  MarketPluginCard: ({ item }: { item: { name: string } }) => <output>{item.name}</output>,
}));
vi.mock('../GhostPluginDetailView', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../GhostPluginDetailView')>()),
  GhostPluginDetailView: (props: {
    toggleDisabled: boolean;
    onToggle(value: boolean): void;
    remoteConfiguration: React.ReactNode;
    onBack(): void;
    detail: { enabled: boolean };
  }) => (
    <>
      <output>{props.detail.enabled ? 'Scoped enabled' : 'Scoped disabled'}</output>
      <button disabled={props.toggleDisabled} onClick={() => props.onToggle(false)}>
        Disable
      </button>
      {props.remoteConfiguration}
      <button onClick={props.onBack}>Back</button>
    </>
  ),
}));
vi.mock('../PluginManagementLayout', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../PluginManagementLayout')>()),
  PLUGIN_INSTALLED_CARD_GRID_CLASS: '',
  PLUGIN_MANAGEMENT_CARD_GRID_CLASS: '',
  PluginManagementLayout: ({
    children,
    onSelectTab,
    headerActions,
  }: {
    children: React.ReactNode;
    onSelectTab?: (tab: 'plugins' | 'skills') => void;
    headerActions?: React.ReactNode;
  }) => (
    <>
      <button onClick={() => onSelectTab?.('skills')}>Skills</button>
      {headerActions}
      {children}
    </>
  ),
  PluginManagementPage: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: localGhosts }));
const snapshot = (name: string) => ({
  version: 1,
  settingsPage: true,
  ghosts: [
    {
      manifest: {
        schemaVersion: 3,
        minCindyVersion: '0.1.61',
        id: 'weather',
        name,
        version: '1.0.0',
        kind: 'chip',
        entry: 'main.js',
        settingsHtml: 'settings.html',
      },
      dir: '/fixture/weather',
      instanceKey: 'weather',
      namespace: null,
      enabled: true,
      approval: { state: 'approved' as const, revision: '00000000-0000-4000-8000-000000000001' },
    },
  ],
  market: {
    items: [],
    unavailableReason: null,
    customSourceNames: [],
    unavailableCustomSourceNames: [],
  },
});
const configurationResource = (state = 'configured', id = 'weather') => ({
  ref: { collectionId: 'plugins', kind: 'plugin', id },
  revision: 'r1',
  blocks: [
    {
      id: 'capabilities',
      primitive: 'plugin-capabilities',
      fallbackMarkdown: '',
      data: {
        usage: {
          taskUsable: true,
          hasSettings: true,
          approvalRequired: false,
          builtin: false,
          retired: false,
          setup: { state: 'ready', missing: [], expired: [] },
          configuration: {
            items: [
              {
                id: 'oauth:account',
                kind: 'oauth',
                label: 'Example account',
                state,
                count: state === 'configured' ? 1 : 0,
              },
            ],
            alternatives: [],
          },
        },
      },
    },
  ],
});
beforeEach(() => {
  resetPluginCatalogMemoryForTest();
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // Supply the actual scroller geometry omitted by jsdom now that only real
  // virtual rows are rendered.
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) { return this.tagName === 'MAIN' ? 800 : 150; });
  vi.clearAllMocks();
  directoryMode.real = false;
  setDataOwnerGeneration('test-owner');
  window.electronAPI = {
    deviceLink: {
      invoke,
      onRemotePush: () => () => {},
      onStatusChanged: () => () => {},
      onPresenceChanged: () => () => {},
    },
  } as never;
  invoke.mockImplementation(
    async (
      device: string,
      channel: string,
      args: Array<{ actionId?: string; input?: { operationId?: string } }>,
    ) => {
      if (channel.endsWith(':manifest'))
        return { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] };
      if (channel === 'maker:remote-resources:get') return configurationResource();
      if (args[0].actionId === 'management:snapshot')
        return { effects: [], result: snapshot(device) };
      if (args[0].actionId === 'management:begin')
        return {
          effects: [],
          result: { operationId: args[0].input?.operationId, phase: 'succeeded' },
        };
      return { effects: [], result: { operationId: args[0].input?.operationId, phase: 'running' } };
    },
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('selected plugin host', () => {
  // Unit / review finding 4: old Host snapshots were covered, but their finished
  // recommendation placeholder was not. Keep three slots while capabilities
  // are unknown, then remove them for either supported version-1 fallback.
  it.each(['version-1', 'invalid-params'] as const)('finishes recommendation loading on a non-paging Host: %s', async fallback => {
    const normal = invoke.getMockImplementation()!;
    let finish!: () => void;
    const capability = new Promise<void>(resolve => { finish = resolve; });
    invoke.mockImplementation(async (device, channel, args) => {
      if (args?.[0]?.actionId === 'management:snapshot' && args[0].input?.read === 'capabilities') {
        await capability;
        if (fallback === 'invalid-params') throw new Error('[INVALID_PARAMS] nonempty input unsupported');
      }
      return normal(device, channel, args);
    });
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    const pending = screen.getByText('settings.ghosts.page.todayRecommendations').closest('section')!;
    expect(pending.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    await act(async () => { finish(); });
    await screen.findByText('computer-a');
    expect(screen.queryByText('settings.ghosts.page.todayRecommendations')).toBeNull();
    expect(invoke.mock.calls.some(call => call[2]?.[0]?.input?.read === 'recommendations')).toBe(false);
    expect(invoke.mock.calls.some(call => call[2]?.[0]?.actionId === 'management:snapshot' && Object.keys(call[2][0].input).length === 0)).toBe(true);
  });

  // Unit: distinguishing unknown from unsupported must not collapse a new
  // Host's slots before its recommendations arrive (or finish with an error).
  it.each(['success', 'failure'] as const)('keeps the paging Host recommendation slots until its read finishes: %s', async outcome => {
    const normal = invoke.getMockImplementation()!;
    let finish!: (value: unknown) => void, fail!: (error: Error) => void;
    const recommendations = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    invoke.mockImplementation(async (device, channel, args) => {
      if (args?.[0]?.input?.read === 'capabilities') return { effects: [], result: { catalogPaging: true } };
      if (args?.[0]?.input?.read === 'recommendations') return { effects: [], result: await recommendations };
      return normal(device, channel, args);
    });
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    const section = screen.getByText('settings.ghosts.page.todayRecommendations').closest('section')!;
    expect(section.querySelectorAll('[aria-hidden="true"]')).toHaveLength(3);
    const items = Array.from({ length: 3 }, (_, index) => ({ pluginId: `rec-${index}`, ghostId: `rec-${index}`, name: `Recommendation ${index}`,
      scope: 'public', publisherKind: 'official', releaseId: `release-${index}`, installState: 'not-installed' }));
    await act(async () => {
      if (outcome === 'success') finish(items);
      else fail(new Error('recommendations unavailable'));
    });
    if (outcome === 'success') {
      expect(screen.getByText('Recommendation 0')).toBeTruthy();
      expect(section.querySelectorAll('[aria-hidden="true"]')).toHaveLength(0);
    } else expect(screen.queryByText('settings.ghosts.page.todayRecommendations')).toBeNull();
  });

  // Unit / Codex 4583060230: cached paging capability made a hidden/offline
  // remount read recommendations and erase them on failure. Foreground-only
  // tests missed this effect: retain three cached items, then retry on activation.
  it.each(['hidden', 'offline'] as const)('retains cached recommendations until the remote page is readable: %s', async blocked => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const normal = invoke.getMockImplementation()!;
    const items = Array.from({ length: 3 }, (_, index) => ({ pluginId: `rec-${index}`, ghostId: `rec-${index}`, name: `Recommendation ${index}`,
      scope: 'public', publisherKind: 'official', releaseId: `release-${index}`, installState: 'not-installed' }));
    let fail = false;
    const recommendations = vi.fn(async () => {
      if (fail) throw new Error('Host unavailable');
      return items;
    });
    invoke.mockImplementation(async (device, channel, args) => {
      if (args?.[0]?.input?.read === 'capabilities') return { effects: [], result: { catalogPaging: true } };
      if (args?.[0]?.input?.read === 'recommendations') return { effects: [], result: await recommendations() };
      return normal(device, channel, args);
    });
    const view = (readable: boolean) => <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }}
      active={blocked !== 'hidden' || readable} online={blocked !== 'offline' || readable} />;
    const warm = render(view(true));
    await screen.findByText('Recommendation 0');
    warm.unmount();
    clock.mockReturnValue(41_000);
    fail = true;
    const mounted = render(view(false));
    await act(async () => {});
    expect(recommendations).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Recommendation 0')).toBeTruthy();
    await act(async () => { mounted.rerender(view(true)); });
    expect(recommendations).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Recommendation 0')).toBeTruthy();
    fail = false;
    items[0] = { ...items[0], name: 'Updated recommendation' };
    mounted.rerender(view(false));
    mounted.rerender(view(true));
    expect(await screen.findByText('Updated recommendation')).toBeTruthy();
    expect(recommendations).toHaveBeenCalledTimes(3);
  });

  // Unit / Codex 4583482682: hidden remounts previously tested the installed
  // tab only. A cached market tab older than 30 seconds must retain its data
  // without catalog/count reads, then refresh each once through activation.
  it('defers stale market pages and counts on a hidden remount until activation', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const normal = invoke.getMockImplementation()!;
    let name = 'Cached remote market';
    const catalog = vi.fn(async (query: { counts?: boolean }) => ({
      ...snapshot('computer-a').market, nextCursor: null,
      items: [{ pluginId: 'market-one', ghostId: 'market-one', releaseId: 'release-one', name,
        scope: 'public', publisherKind: 'official', sourceType: 'server', installState: 'not-installed' }],
      counts: query.counts ? { all: 1, public: 1, organization: 0, personal: 0, custom: 0 } : null,
    }));
    invoke.mockImplementation(async (device, channel, args) => {
      const input = args?.[0]?.input;
      if (input?.read === 'capabilities') return { effects: [], result: { catalogPaging: true } };
      if (input?.read === 'recommendations') return { effects: [], result: [] };
      if (input?.read === 'catalog') return { effects: [], result: await catalog(input.query) };
      return normal(device, channel, args);
    });
    const view = (active: boolean) => <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active={active} />;
    const warm = render(view(true));
    await screen.findByText('computer-a');
    fireEvent.click(screen.getByRole('tab', { name: /^settings.ghosts.page.marketSection/ }));
    await screen.findByText(name);
    await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
    warm.unmount();
    catalog.mockClear();
    clock.mockReturnValue(131_000);
    vi.useFakeTimers();
    const mounted = render(view(false));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(catalog).not.toHaveBeenCalled();
    name = 'Fresh remote market';
    mounted.rerender(view(true));
    expect(screen.getByText('Cached remote market')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(name)).toBeTruthy();
    expect(catalog.mock.calls.filter(([query]) => !query.counts)).toHaveLength(1);
    expect(catalog.mock.calls.filter(([query]) => query.counts)).toHaveLength(1);
  });

  // Unit / Greptile 4583847638: activation can finish the catalog before the
  // installed snapshot. An unchanged late snapshot must not force a second
  // round; a changed source still replaces already-read cards immediately.
  it.each(['unchanged', 'source-changed'] as const)('refreshes a returning market once before a slow snapshot: %s', async outcome => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100_000);
    const normal = invoke.getMockImplementation()!;
    let holdSnapshot = false;
    let finish!: (value: unknown) => void;
    const pending = new Promise(resolve => { finish = resolve; });
    let name = 'Cached market';
    const catalog = vi.fn(async (query: { counts?: boolean }) => ({ ...snapshot('computer-a').market,
      items: [{ pluginId: 'market-one', ghostId: 'market-one', releaseId: 'release-one', name,
        scope: 'public', publisherKind: 'official', sourceType: 'server', installState: 'not-installed' }],
      nextCursor: null, counts: query.counts ? { all: 1, public: 1, organization: 0, personal: 0, custom: 0 } : null,
    }));
    invoke.mockImplementation(async (device, channel, args) => {
      const input = args?.[0]?.input;
      if (input?.read === 'capabilities') return { effects: [], result: { catalogPaging: true } };
      if (input?.read === 'recommendations') return { effects: [], result: [] };
      if (input?.read === 'catalog') return { effects: [], result: await catalog(input.query) };
      if (input?.read === 'installed' && holdSnapshot) return { effects: [], result: await pending };
      return normal(device, channel, args);
    });
    const view = (active: boolean) => <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active={active} />;
    const mounted = render(view(true));
    await screen.findByText('computer-a');
    fireEvent.click(screen.getByRole('tab', { name: /^settings.ghosts.page.marketSection/ }));
    await screen.findByText(name);
    await waitFor(() => expect(catalog).toHaveBeenCalledTimes(2));
    mounted.rerender(view(false));
    catalog.mockClear();
    clock.mockReturnValue(131_000);
    vi.useFakeTimers();
    holdSnapshot = true;
    name = 'Catalog before snapshot';
    mounted.rerender(view(true));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(name)).toBeTruthy();
    expect(catalog.mock.calls.filter(([query]) => !query.counts)).toHaveLength(1);
    const next = { ...snapshot('computer-a'), market: { ...snapshot('computer-a').market,
      customSourceNames: outcome === 'source-changed' ? ['Changed source'] : [] } };
    if (outcome === 'source-changed') name = 'Catalog after changed source';
    await act(async () => { finish(next); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText(name)).toBeTruthy();
    if (outcome === 'unchanged') {
      expect(catalog.mock.calls.filter(([query]) => !query.counts)).toHaveLength(1);
      expect(catalog.mock.calls.filter(([query]) => query.counts)).toHaveLength(1);
    } else expect(catalog.mock.calls.filter(([query]) => !query.counts).length).toBeGreaterThan(1);
  });

  // Unit, #9487: reconnect previously refreshed the snapshot but retained stale market pages.
  // The same installed set with a changed market release must display the new card.
  it('refreshes cached market cards after reconnect when installed versions are unchanged', async () => {
    let marketName = 'Old market release';
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => args[0]?.actionId === 'management:snapshot'
      ? { effects: [], result: { ...snapshot(device), market: { ...snapshot(device).market, items: [{
        pluginId: `c${'p'.repeat(24)}`, ghostId: 'market-plugin', name: marketName, description: null,
        author: null, scope: 'public', organizationId: null, defaultInstall: false,
        releaseId: `c${'r'.repeat(24)}`, version: '1.0.0', publishedAt: '2026-11-01T00:00:00.000Z',
        icon: null, installState: 'not-installed', enabled: null, sourceType: 'server', sourceMarketName: null,
      }] } } } : normal(device, channel, args));
    const view = (online: boolean) => <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online={online} />;
    const mounted = render(view(true));
    await screen.findByText('computer-a');
    fireEvent.click(screen.getByRole('tab', { name: /^settings.ghosts.page.marketSection/ }));
    await screen.findByText('Old market release');
    mounted.rerender(view(false));
    marketName = 'New market release';
    mounted.rerender(view(true));
    await screen.findByText('New market release');
    expect(screen.queryByText('Old market release')).toBeNull();
  });

  // Unit / Codex C2: while unmounted the page cannot observe Host pushes.
  // Reconnect tests keep the component mounted and miss a fresh cached remount.
  // Re-enter within 30 seconds: show the cache during the read, then adopt the
  // changed installed list, or preserve it with the existing read-failure UI.
  it.each(['success', 'failure'] as const)('revalidates a warm remote snapshot after remount: %s', async outcome => {
    vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const first = render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    first.unmount();
    const normal = invoke.getMockImplementation()!;
    let finish!: (value: unknown) => void, fail!: (error: Error) => void;
    const pending = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
    invoke.mockImplementation(async (device, channel, args) => args[0]?.actionId === 'management:snapshot'
      && Object.keys(args[0].input ?? {}).length === 0 ? { effects: [], result: await pending } : normal(device, channel, args));
    const before = invoke.mock.calls.length;
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    expect(screen.getByText('computer-a')).toBeTruthy();
    await waitFor(() => expect(invoke.mock.calls.slice(before).some(call => call[2]?.[0]?.actionId === 'management:snapshot'
      && Object.keys(call[2][0].input ?? {}).length === 0)).toBe(true));
    await act(async () => {
      if (outcome === 'success') finish(snapshot('Changed while away'));
      else fail(new Error('Host read failed'));
    });
    if (outcome === 'success') {
      expect(await screen.findByText('Changed while away')).toBeTruthy();
      expect(screen.queryByText('computer-a')).toBeNull();
    } else {
      expect(screen.getByText('computer-a')).toBeTruthy();
      expect(notices.error).toHaveBeenCalledWith('settings.ghosts.remote.readFailed', expect.objectContaining({ action: expect.any(Object) }));
    }
  });

  // Unit / Codex C3 (approved convergence): Settings keeps this page mounted
  // under a hidden Skills tab. Online/mounted tests missed background focus
  // reads; initial-hidden and subsequently-hidden paths share the same guard.
  it.each(['initially-hidden', 'hidden-after-read'] as const)('does not read a hidden remote Host on foreground: %s', async path => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(10_000);
    const normal = invoke.getMockImplementation()!;
    let name = 'Original Host';
    invoke.mockImplementation(async (device, channel, args) => args[0]?.actionId === 'management:snapshot'
      && Object.keys(args[0].input ?? {}).length === 0 ? { effects: [], result: snapshot(name) } : normal(device, channel, args));
    const view = (active: boolean, online = true) => <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online={online} active={active} />;
    const mounted = render(view(path === 'hidden-after-read'));
    if (path === 'hidden-after-read') await screen.findByText(name);
    mounted.rerender(view(false));
    const reads = invoke.mock.calls.length;
    clock.mockReturnValue(41_000);
    await act(async () => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); });
    expect(invoke).toHaveBeenCalledTimes(reads);
    mounted.rerender(view(false, false));
    mounted.rerender(view(false, true));
    expect(invoke).toHaveBeenCalledTimes(reads);
    name = 'Activated Host';
    mounted.rerender(view(true));
    expect(await screen.findByText(name)).toBeTruthy();
    expect(invoke.mock.calls.length).toBeGreaterThan(reads);
  });

  it.each(['cancelled', 'changed'] as const)('presents the %s receipt with the existing notice', async outcome => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) =>
      args[0]?.actionId === 'management:begin'
        ? { effects: [], result: { operationId: args[0].input.operationId, phase: outcome === 'changed' ? 'failed' : 'cancelled', ...(outcome === 'changed' ? { errorCode: 'NOT_FOUND' } : {}) } }
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() =>
      expect(outcome === 'changed' ? notices.error : notices.info).toHaveBeenCalledWith(`settings.ghosts.remote.${outcome}`),
    );
    expect(screen.queryByText('settings.ghosts.remote.cancelled')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.retry' })).toBeNull();
  });
  const projectRevision = 'a'.repeat(64);
  function projects() {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot')
        return {
          effects: [],
          result: {
            ...snapshot(device),
            projectBrowse: true,
            projects: [
              { id: 'project-' + device, name: 'Project ' + device },
              { id: 'other-' + device, name: 'Other project' },
            ],
          },
        };
      if (args[0]?.actionId === 'management:project-state')
        return {
          effects: [],
          result: {
            projectId: args[0].input.projectId,
            revision: projectRevision,
            disabled: args[0].input.projectId.startsWith('other-') ? ['weather'] : [],
          },
        };
      return normal(device, channel, args);
    });
  }
  async function selectProject(name: string) {
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }), {
      key: 'ArrowDown',
    });
    fireEvent.keyDown(
      await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' }),
      { key: 'ArrowRight' },
    );
    fireEvent.click(await screen.findByRole('menuitem', { name }));
  }
  it('uses the existing target folder picker and Host-issued identity without reading controller folders', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) =>
      args[0]?.actionId === 'management:project-select'
        ? { effects: [], result: { id: 'browsed', name: 'Browsed folder', path: '/target/browsed' } }
        : normal(device, channel, args));
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('settings.ghosts.scopePicker.browse');
    expect(screen.getByText('Browse computer-a')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Select target folder' }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith('computer-a', expect.any(String), [expect.objectContaining({
      actionId: 'management:project-state', input: { projectId: 'browsed' },
    })]));
    expect(invoke).toHaveBeenCalledWith('computer-a', expect.any(String), [expect.objectContaining({
      actionId: 'management:project-select', input: { path: '/target/browsed' },
    })]);
    const actions = invoke.mock.calls.map(call => call[2][0].actionId);
    expect(actions.slice(actions.indexOf('management:project-select') + 1)).toContain('management:snapshot');
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('ignores a late folder selection after switching computers and cancels without changing scope', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) => args[0]?.actionId === 'management:project-select'
      ? new Promise(done => { resolve = done; }) : normal(device, channel, args));
    const view = render(<RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('settings.ghosts.scopePicker.browse');
    fireEvent.click(screen.getByRole('button', { name: 'Select target folder' }));
    view.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    await act(async () => { resolve({ effects: [], result: { id: 'late-a', name: 'Late A' } }); });
    expect(invoke.mock.calls.some(call => call[2][0].actionId === 'management:project-state' && call[2][0].input.projectId === 'late-a')).toBe(false);
    await selectProject('settings.ghosts.scopePicker.browse');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel folder' }));
    expect(screen.queryByText('Browse computer-b')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }).textContent).toContain('globalScope');
  });
  it('binds a project toggle to its Host, project revision and physical plugin while avoiding market reconciliation on scope change', async () => {
    projects();
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    const snapshotsBefore = invoke.mock.calls.filter(
      (call) => call[2][0].actionId === 'management:snapshot',
    ).length;
    expect(
      screen
        .getByRole('button', { name: 'settings.ghosts.remote.device' })
        .closest('[data-catalog-region="heading"]'),
    ).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'settings.ghosts.remote.device' })
        .closest('[data-catalog-region="target"]')
        ?.querySelectorAll('button'),
    ).toHaveLength(1);
    await selectProject('Project computer-a');
    fireEvent.click(await screen.findByText('computer-a'));
    expect(screen.getByText('Scoped enabled')).toBeTruthy();
    expect(
      invoke.mock.calls.filter((call) => call[2][0].actionId === 'management:snapshot'),
    ).toHaveLength(snapshotsBefore);
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() =>
      expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
        true,
      ),
    );
    const call = invoke.mock.calls.find((call) => call[2][0].actionId === 'management:begin')!;
    expect(call[0]).toBe('computer-a');
    expect(call[2][0]).toMatchObject({
      resourceRef: { id: 'weather' },
      input: {
        kind: 'disable',
        projectId: 'project-computer-a',
        expectedProjectRevision: projectRevision,
      },
    });
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('ignores the previous project late response after switching projects', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      args[0]?.actionId === 'management:project-state' &&
      args[0].input.projectId === 'project-computer-a'
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('Project computer-a');
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    expect(screen.queryByText('computer-a')).toBeNull();
    await selectProject('Other project');
    fireEvent.click(await screen.findByText('computer-a'));
    expect(screen.getByText('Scoped disabled')).toBeTruthy();
    await act(async () => {
      resolve({
        effects: [],
        result: { projectId: 'project-computer-a', revision: projectRevision, disabled: [] },
      });
    });
    expect(screen.getByText('Scoped disabled')).toBeTruthy();
  });
  it('loads the next computer own projects and resets its scope to global', async () => {
    projects();
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />,
    );
    await screen.findByText('computer-a');
    await selectProject('Other project');
    await screen.findByText('computer-a');
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    expect(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }).textContent).toBe(
      'B / settings.ghosts.scopePicker.globalScope',
    );
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }), {
      key: 'ArrowDown',
    });
    fireEvent.keyDown(
      await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' }),
      { key: 'ArrowRight' },
    );
    await screen.findByRole('menuitem', { name: 'Project computer-b' });
    expect(screen.queryByRole('menuitem', { name: 'Project computer-a' })).toBeNull();
  });
  it('keeps global management usable with old Host project capability absent', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    expect(screen.getByText('settings.ghosts.remote.projectsUnsupported')).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.remote.device' }), {
      key: 'ArrowDown',
    });
    expect(
      (
        await screen.findByRole('menuitem', { name: 'settings.ghosts.scopePicker.ariaLabel' })
      ).getAttribute('data-disabled'),
    ).toBe('');
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    fireEvent.click(screen.getByText('computer-a'));
    await screen.findByTestId('original-settings');
    expect((screen.getByText('Disable') as HTMLButtonElement).disabled).toBe(false);
  });
  it('project read failure retains the target with retry and blocks project actions', async () => {
    projects();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      args[0]?.actionId === 'management:project-state'
        ? Promise.reject(new Error('timeout'))
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await screen.findByText('computer-a');
    await selectProject('Project computer-a');
    await screen.findByText(/projectReadFailed/);
    expect(screen.queryByText('computer-a')).toBeNull();
    expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
      false,
    );
    expect(screen.getByText('settings.ghosts.remote.retry')).toBeTruthy();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.ghosts.projectBanner.backToGlobal' }),
    );
    await screen.findByText('computer-a');
    expect(screen.getByText('settings.ghosts.remote.managingDescription')).toBeTruthy();
    expect(screen.queryByText(/projectReadFailed/)).toBeNull();
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
      false,
    );
  });
  it('installs a file from the add-plugin menu onto the selected computer without a list-level import action', async () => {
    const pick = vi.fn(async () => ({ attachment: 'sandbox-transferred-package' }));
    Object.assign(window.electronAPI.deviceLink, { pickPluginPackage: pick });
    render(<RemotePluginPage device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    expect(screen.queryByText('settings.ghosts.remote.import')).toBeNull();
    fireEvent.keyDown(screen.getByRole('button', { name: 'settings.ghosts.page.addPluginAria' }), {
      key: 'ArrowDown',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: 'settings.ghosts.install' }));
    await waitFor(() => expect(pick).toHaveBeenCalledWith('computer-b'));
    await waitFor(() =>
      expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
        true,
      ),
    );
    const call = invoke.mock.calls.find((call) => call[2][0].actionId === 'management:begin')!;
    expect(call[0]).toBe('computer-b');
    expect(call[2][0].input).toMatchObject({
      kind: 'install-file',
      attachment: 'sandbox-transferred-package',
    });
  });
  it('keeps add-plugin disabled while offline', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-b', name: 'B' }} online={false} />);
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.page.addPluginAria',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'settings.ghosts.remote.device' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(invoke).not.toHaveBeenCalled();
  });
  it('does not reconcile a hidden target market until the Plugins tab is shown', async () => {
    const ui = render(
      <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active={false} />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(invoke).not.toHaveBeenCalled();
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active />);
    await screen.findByText('computer-a');
  });
  it('routes enable/disable with target physical instance and approval without reading the local store', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    fireEvent.click(screen.getByText('Disable'));
    await waitFor(() =>
      expect(invoke.mock.calls.some((c) => c[2][0].actionId === 'management:begin')).toBe(true),
    );
    const call = invoke.mock.calls.find((c) => c[2][0].actionId === 'management:begin')!;
    expect(call[0]).toBe('computer-a');
    expect(call[2][0].resourceRef.id).toBe('weather');
    expect(call[2][0].input).toMatchObject({
      kind: 'disable',
      expectedInstalledApproval: ghostInstallApprovalToken(snapshot('A').ghosts[0].approval),
    });
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('keeps offline target data, disables writes and never falls back to local APIs', async () => {
    const ui = render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online={false} />);
    expect((screen.getByText('Disable') as HTMLButtonElement).disabled).toBe(true);
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('shows only the disabled hint, then mounts the original settings when enabled', async () => {
    let enabled = false;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot') {
        const data = snapshot(device);
        data.ghosts[0].enabled = enabled;
        return { effects: [], result: data };
      }
      return normal(device, channel, args);
    });
    const ui = render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(screen.queryByTestId('original-settings')).toBeNull();
    expect(screen.queryByText('settings.ghosts.detail.configurationTitle')).toBeNull();
    expect(screen.getByText('settings.ghosts.remote.enableBeforeConfigure')).toBeTruthy();
    enabled = true;
    ui.rerender(
      <RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active={false} />,
    );
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online active />);
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    expect(screen.queryByText('settings.ghosts.remote.enableBeforeConfigure')).toBeNull();
    expect(invoke.mock.calls.some((call) => call[2][0].actionId === 'management:begin')).toBe(
      false,
    );
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('removes the original page when a Host operation returns its new disabled state', async () => {
    let enabled = true;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot') {
        const data = snapshot(device);
        data.ghosts[0].enabled = enabled;
        return { effects: [], result: data };
      }
      if (args[0]?.actionId === 'management:begin') {
        enabled = false;
        return {
          effects: [],
          result: {
            operationId: args[0].input.operationId,
            phase: 'failed',
            errorCode: 'GHOST_ASLEEP',
          },
        };
      }
      return normal(device, channel, args);
    });
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toBeTruthy();
    fireEvent.click(screen.getByText('Disable'));
    await screen.findByText('Scoped disabled');
    expect(screen.queryByTestId('original-settings')).toBeNull();
    expect(screen.getByText('settings.ghosts.remote.enableBeforeConfigure')).toBeTruthy();
  });
  it('reopens the original settings instead of rendering synthesized authorization metadata', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    expect(screen.queryByText('settings.ghosts.remote.authorizedAccounts')).toBeNull();
    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toBeTruthy();
    expect(invoke.mock.calls.some((call) => call[1] === 'maker:remote-resources:get')).toBe(false);
  });
  it('does not open the setup coordinator or read a summary while displaying settings', async () => {
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    await screen.findByTestId('original-settings');
    expect(invoke.mock.calls.some((call) => call[2][0].input?.kind === 'configure')).toBe(false);
    expect(screen.queryByRole('button', { name: 'settings.ghosts.remote.configure' })).toBeNull();
  });
  it('binds the original page to the selected computer when switching targets', async () => {
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />,
    );
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    expect(screen.queryByTestId('original-settings')).toBeNull();
    fireEvent.click(await screen.findByText('computer-b'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-b/weather',
    );
  });
  it('keeps settings bound to the physical instance when opening a namespaced copy', async () => {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args[0]?.actionId === 'management:snapshot') {
        const state = snapshot(device);
        return {
          effects: [],
          result: {
            ...state,
            ghosts: [
              ...state.ghosts,
              {
                ...state.ghosts[0],
                instanceKey: '_ns__xd__weather',
                namespace: 'xd',
                manifest: { ...state.ghosts[0].manifest, name: 'Organization weather' },
              },
            ],
          },
        };
      }
      return normal(device, channel, args);
    });
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/weather',
    );
    fireEvent.click(screen.getByText('Back'));
    fireEvent.click(await screen.findByText('Organization weather'));
    expect(await screen.findByTestId('original-settings')).toHaveProperty(
      'textContent',
      'computer-a/_ns__xd__weather',
    );
  });
  it('unmounts the original settings when its Host disconnects', async () => {
    const ui = render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('computer-a'));
    await screen.findByTestId('original-settings');
    ui.rerender(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online={false} />);
    expect(screen.queryByTestId('original-settings')).toBeNull();
    expect(screen.getByText('settings.ghosts.remote.offlineNotice')).toBeTruthy();
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('ignores a late response from a previous mounted device', async () => {
    let reply!: (value: unknown) => void;
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      device === 'computer-a' && args[0].actionId === 'management:snapshot'
        ? new Promise((resolve) => {
            reply = resolve;
          })
        : normal(device, channel, args),
    );
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'computer-a', name: 'A' }} online />,
    );
    await waitFor(() => expect(reply).toBeTypeOf('function'));
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'computer-b', name: 'B' }} online />);
    await screen.findByText('computer-b');
    await act(async () => {
      reply({ result: snapshot('stale-a') });
    });
    expect(screen.queryByText('stale-a')).toBeNull();
  });
  it('discards an owner’s late response after switching account', async () => {
    let reply!: (value: unknown) => void;
    invoke.mockImplementation(async (_device, channel) =>
      channel.endsWith(':manifest')
        ? { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] }
        : new Promise((resolve) => {
            reply = resolve;
          }),
    );
    render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
    await waitFor(() => expect(reply).toBeTypeOf('function'));
    setDataOwnerGeneration('other-owner');
    await act(async () => {
      reply({ result: snapshot('old-account') });
    });
    expect(screen.queryByText('old-account')).toBeNull();
  });
  it('shows old Host plugins read-only when the capability is absent', async () => {
    invoke.mockImplementation(async (_device, channel) =>
      channel.endsWith(':manifest')
        ? { collections: [{ id: 'plugins' }] }
        : {
            items: [
              {
                ref: { collectionId: 'plugins', kind: 'plugin', id: 'legacy' },
                revision: 'r1',
                display: { title: 'Legacy plugin', status: { label: 'enabled' } },
              },
            ],
          },
    );
    const onSelectCatalogTab = vi.fn();
    render(
      <RemotePluginPage
        device={{ deviceId: 'old', name: 'Old' }}
        online
        deviceControl={{
          selected: { deviceId: 'old', name: 'Old' },
          onSelect: vi.fn(),
          directory: { candidates: [], target: undefined, online: true, relayOnline: true },
        }}
        onSelectCatalogTab={onSelectCatalogTab}
      />,
    );
    await screen.findByText('Legacy plugin');
    expect(
      screen
        .getByRole('button', { name: 'settings.ghosts.remote.device' })
        .closest('[data-catalog-region="heading"]'),
    ).toBeTruthy();
    fireEvent.click(screen.getByText('Skills'));
    expect(onSelectCatalogTab).toHaveBeenCalledWith('skills');
    expect(screen.getByText('settings.ghosts.remote.unsupported')).toBeTruthy();
    expect(invoke.mock.calls.some((c) => c[2][0].actionId === 'management:begin')).toBe(false);
  });
  const legacyItem = {
    ref: { collectionId: 'plugins', kind: 'plugin', id: '_ns__team__notes' },
    revision: 'r1',
    display: { title: 'Team notes', subtitle: 'Organize notes', status: { label: 'enabled' } },
  };
  const legacyResource = {
    ...legacyItem,
    blocks: [
      { id: 'about', primitive: 'markdown', fallbackMarkdown: 'Full description from A' },
      { id: 'version', primitive: 'status', fallbackMarkdown: '1.2.3' },
      {
        id: 'capabilities',
        primitive: 'plugin-capabilities',
        fallbackMarkdown: '',
        data: {
          tools: [{ name: 'read_notes', description: 'Read saved notes' }],
          permissions: [{ title: 'Access notes service', description: 'Only the declared host' }],
          details: [{ key: 'author', title: 'Author', value: 'Example Team' }],
        },
      },
    ],
  };
  function oldHost() {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    invoke.mockImplementation(async (_device, channel) => {
      if (channel.endsWith(':manifest')) return { collections: [{ id: 'plugins' }] };
      if (channel.endsWith(':list')) return { items: [legacyItem] };
      if (channel.endsWith(':get')) return legacyResource;
      throw new Error('unexpected write');
    });
  }
  it('opens a normal detail header and all provided facts for an older Host without using local actions', async () => {
    oldHost();
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('Full description from A');
    expect(screen.getByRole('heading', { name: 'Team notes' })).toBeTruthy();
    expect(screen.getByText('v1.2.3')).toBeTruthy();
    expect(screen.getByText('Example Team')).toBeTruthy();
    expect(screen.getByText('read_notes')).toBeTruthy();
    expect(screen.getByText('Access notes service')).toBeTruthy();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.queryByText('settings.ghosts.remote.configure')).toBeNull();
    expect(invoke.mock.calls.find((call) => call[1].endsWith(':get'))).toMatchObject([
      'old-a',
      expect.any(String),
      [{ ref: legacyItem.ref, client: { locale: 'en' } }],
    ]);
    expect(invoke.mock.calls.some((call) => call[1].endsWith(':invoke'))).toBe(false);
    expect(localGhosts).not.toHaveBeenCalled();
  });
  it('keeps the readable header while loading, and Back prevents a late detail from reopening', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    expect(screen.getByRole('heading', { name: 'Team notes' })).toBeTruthy();
    await screen.findByText('settings.ghosts.remote.detailLoading');
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.detail.backToList' }));
    await act(async () => resolve(legacyResource));
    expect(screen.queryByText('Full description from A')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Team notes' })).toBeNull();
  });
  it('does not let a late old-Host detail appear after selecting a different computer', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    const ui = render(
      <RemotePluginPage key="a" device={{ deviceId: 'old-a', name: 'A' }} online />,
    );
    fireEvent.click(await screen.findByText('Team notes'));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    ui.rerender(<RemotePluginPage key="b" device={{ deviceId: 'old-b', name: 'B' }} online />);
    await screen.findByText('Team notes');
    await act(async () => resolve(legacyResource));
    expect(screen.queryByText('Full description from A')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Team notes' })).toBeNull();
  });
  it('shows a detail read failure and retries only that Host resource', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? Promise.reject(new Error('timeout'))
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('settings.ghosts.remote.detailReadFailed');
    invoke.mockImplementation(normal);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.refreshDetail' }));
    await screen.findByText('Full description from A');
    expect(screen.queryByText('settings.ghosts.remote.detailReadFailed')).toBeNull();
    expect(invoke.mock.calls.every((call) => call[0] === 'old-a')).toBe(true);
  });
  it('ignores a late detail after account ownership changes', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    let resolve!: (value: unknown) => void;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':get')
        ? new Promise((done) => {
            resolve = done;
          })
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await waitFor(() => expect(resolve).toBeTypeOf('function'));
    setDataOwnerGeneration('signed-out');
    await act(async () => resolve(legacyResource));
    expect(screen.queryByText('Full description from A')).toBeNull();
  });
  it('retains the detail offline and refreshes it on reconnect without invoking writes', async () => {
    oldHost();
    const ui = render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('Full description from A');
    const previousReads = invoke.mock.calls.filter((call) => call[1].endsWith(':get')).length;
    ui.rerender(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online={false} />);
    expect(screen.getByRole('heading', { name: 'Team notes' })).toBeTruthy();
    expect(screen.getByText('settings.ghosts.remote.offlineNotice')).toBeTruthy();
    ui.rerender(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    await waitFor(() =>
      expect(invoke.mock.calls.filter((call) => call[1].endsWith(':get')).length).toBeGreaterThan(
        previousReads,
      ),
    );
    await waitFor(() =>
      expect(screen.queryByText('settings.ghosts.remote.detailLoading')).toBeNull(),
    );
    expect(screen.getByText('Full description from A')).toBeTruthy();
    expect(invoke.mock.calls.some((call) => call[1].endsWith(':invoke'))).toBe(false);
  });
  it('returns to the full management page when a refreshed Host gains the capability', async () => {
    oldHost();
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    fireEvent.click(await screen.findByText('Team notes'));
    await screen.findByText('Full description from A');
    invoke.mockImplementation(async (_device, channel) =>
      channel.endsWith(':manifest')
        ? { collections: [{ id: 'plugins', actions: [{ id: 'management:snapshot' }] }] }
        : { result: snapshot('Upgraded plugin') },
    );
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.refresh' }));
    await screen.findByText('Upgraded plugin');
    expect(screen.queryByText('Full description from A')).toBeNull();
    expect(screen.queryByText('settings.ghosts.remote.unsupported')).toBeNull();
  });
  it('shows list errors before upgrade advice and clears the error after refreshing', async () => {
    oldHost();
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation((device, channel, args) =>
      channel.endsWith(':list')
        ? Promise.reject(new Error('timeout'))
        : normal(device, channel, args),
    );
    render(<RemotePluginPage device={{ deviceId: 'old-a', name: 'A' }} online />);
    await waitFor(() =>
      expect(notices.error).toHaveBeenCalledWith(
        'settings.ghosts.remote.readFailed',
        expect.any(Object),
      ),
    );
    expect(screen.queryByText('settings.ghosts.remote.unsupported')).toBeNull();
    invoke.mockImplementation(normal);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.remote.refresh' }));
    await screen.findByText('Team notes');
    expect(screen.queryByText('settings.ghosts.remote.readFailed')).toBeNull();
    expect(screen.getByRole('button', { name: 'settings.ghosts.remote.refresh' })).toBeTruthy();
  });
});

// unit: the remote task prompt must negotiate before sending, and a lost approval
// receipt must never replay consent. Minimum input: one pending UI plugin and one answer.
describe('remote task interactive-page consent prompt', () => {
  function setup(capability: boolean, lost = false) {
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      const action = args?.[0]?.actionId;
      if (action === 'management:snapshot') {
        const data = snapshot(device);
        return { effects: [], result: { ...data, ...(capability ? { uiCapabilityApproval: true } : {}),
          ghosts: data.ghosts.map(g => ({ ...g, manifest: { ...g.manifest, schemaVersion: 3, tools: [{ name: 'open', description: 'Open page' }], mcpApps: { ui: { resources: [{
            uri: "ui://planner",
            file: 'ui.html'
        }], tools: { open: { resourceUri: 'ui://planner' } } } } } })) } };
      }
      if (action === 'management:operation') return { effects: [], result: {
        operationId: args[0].input.operationId, phase: 'confirmation', consent: {
          requestId: 'page-consent', purpose: 'ui-capability', initiator: 'user', origin: 'local-file',
          facts: { kind: 'install', ghostId: 'weather', name: 'Weather', version: '1.0.0', permissions: [] },
        },
      } };
      if (action === 'management:answer' && lost) throw new Error('receipt lost');
      return normal(device, channel, args);
    });
  }
  it('shows an upgrade hint without sending an unnegotiated operation to an old Host', async () => {
    setup(false); render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await screen.findByText('newChat.pluginUi.updateHost');
    expect(screen.queryByText('newChat.pluginUi.enable')).toBeNull();
    expect(invoke.mock.calls.some(c => c[2]?.[0]?.actionId === 'management:begin')).toBe(false);
  });
  it('answers page consent once, then queries the same operation after a lost receipt', async () => {
    setup(true, true); render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    const button = await screen.findByText('newChat.pluginUi.enable');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button); });
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:answer')).toHaveLength(1);
    const begin = invoke.mock.calls.find(c => c[2]?.[0]?.actionId === 'management:begin')!;
    expect(begin[2][0].input).toMatchObject({ kind: 'approve-ui', uiConsentVersion: 1 });
    expect(confirm).toHaveBeenCalledOnce();
    // Poll with fake time; no network replay and no second consent dialog.
    await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:operation').length).toBeGreaterThan(1);
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:answer')).toHaveLength(1);
    expect(confirm).toHaveBeenCalledOnce();
  });
  // #4423428047, unit: real prompt + RPC adapter; previous coverage only rejected
  // an already-created operation. A stale begin must refresh and allow an explicit
  // retry; a lost begin receipt must keep querying without replaying approval.
  it.each(['NOT_FOUND', 'receipt lost'])('recovers a %s begin without replaying it', async failure => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    const revision = '00000000-0000-4000-8000-000000000002';
    let begins = 0;
    invoke.mockImplementation(async (device, channel, args) => {
      const request = args?.[0];
      if (request?.actionId === 'management:begin' && ++begins === 1)
        throw new Error(failure === 'NOT_FOUND' ? '[NOT_FOUND] Plugin changed' : failure);
      if (request?.actionId === 'management:operation' && failure === 'NOT_FOUND' && begins === 1)
        throw new Error('[NOT_FOUND] Operation was not created');
      if (request?.actionId === 'management:operation' && failure === 'receipt lost')
        return { effects: [], result: { operationId: request.input.operationId, phase: 'running' } };
      const result = await normal(device, channel, args);
      if (request?.actionId === 'management:snapshot' && begins > 0)
        result.result.ghosts = result.result.ghosts.map((ghost: ReturnType<typeof snapshot>['ghosts'][number]) => ({ ...ghost, approval: { ...ghost.approval, revision } }));
      return result;
    });
    render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    const button = await screen.findByRole('button', { name: 'newChat.pluginUi.enable' });
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2400); });
    const operations = invoke.mock.calls.filter(call => call[2]?.[0]?.actionId === 'management:operation');
    expect(begins).toBe(1);
    expect(confirm).not.toHaveBeenCalled();
    if (failure === 'NOT_FOUND') {
      expect(notices.error).toHaveBeenCalledWith('settings.ghosts.remote.changed');
      expect((button as HTMLButtonElement).disabled).toBe(false);
      expect(screen.queryByText('settings.ghosts.remote.unknown')).toBeNull();
      expect(operations).toHaveLength(0);
      await act(async () => { fireEvent.click(button); });
      const requests = invoke.mock.calls.filter(call => call[2]?.[0]?.actionId === 'management:begin');
      expect(requests).toHaveLength(2);
      expect(requests[1][2][0].input.expectedInstalledApproval).toBe(ghostInstallApprovalToken({ state: 'approved', revision }));
      expect(requests[1][2][0].input.operationId).not.toBe(requests[0][2][0].input.operationId);
      expect(confirm).toHaveBeenCalledOnce();
    } else {
      expect((button as HTMLButtonElement).disabled).toBe(true);
      expect(operations.length).toBeGreaterThan(1);
      expect(new Set(operations.map(call => call[2][0].input.operationId)).size).toBe(1);
      expect(notices.error).not.toHaveBeenCalled();
    }
  });
  // M04, unit: a confirmation for an updated install fails; the prompt must not
  // silently disappear. Existing tests only covered success and lost receipts.
  it('shows the existing changed-plugin notice for a stale page approval', async () => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    let answered = false;
    invoke.mockImplementation(async (device, channel, args) => {
      const request = args?.[0];
      if (request?.actionId === 'management:answer') answered = true;
      if (request?.actionId === 'management:operation' && answered) return { effects: [], result: {
        operationId: request.input.operationId, phase: 'failed', errorCode: 'NOT_FOUND',
      } };
      return normal(device, channel, args);
    });
    render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    const button = await screen.findByText('newChat.pluginUi.enable');
    vi.useFakeTimers();
    await act(async () => { fireEvent.click(button); });
    await act(async () => { await vi.advanceTimersByTimeAsync(1200); });
    expect(notices.error).toHaveBeenCalledWith('settings.ghosts.remote.changed');
    expect(invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:answer')).toHaveLength(1);
    expect(screen.queryByText('newChat.pluginUi.ready')).toBeNull();
  });
  // Unit: a failed notification read after a successful empty snapshot must remain
  // stale, without retrying in a loop; the next actual composer subscription retries.
  it('retries stale discovery on remount after a failed plugin notification read', async () => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    let pending = false;
    let fail = false;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args?.[0]?.actionId === 'management:snapshot' && fail) throw new Error('temporary failure');
      const result = await normal(device, channel, args);
      if (args?.[0]?.actionId === 'management:snapshot' && !pending) result.result.ghosts = [];
      return result;
    });
    let push: ((value: unknown) => void) | undefined;
    window.electronAPI.deviceLink.onRemotePush = ((listener: (value: unknown) => void) => { push = listener; return () => {}; }) as never;
    const reads = () => invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:snapshot').length;
    const first = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await waitFor(() => expect(reads()).toBe(1));
    vi.useFakeTimers();
    pending = true;
    fail = true;
    await act(async () => {
      push!({ deviceId: 'computer-a', channel: 'maker:remote-resources:changed', payload: { collectionId: 'plugins' } });
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(reads()).toBe(2);
    first.unmount();
    fail = false;
    const second = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads()).toBe(3);
    expect(screen.getByText('newChat.pluginUi.enable')).toBeTruthy();
    second.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  });
  // Unit: notifications arriving during a failing read must get one follow-up,
  // even when the composer stays mounted and no further events arrive.
  it('keeps a coalesced refresh queued during a failed consent read', async () => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    let reads = 0;
    let rejectRead!: (error: Error) => void;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args?.[0]?.actionId === 'management:snapshot') {
        reads++;
        if (reads === 2) return new Promise((_resolve, reject) => { rejectRead = reject; });
        const result = await normal(device, channel, args);
        if (reads === 1) result.result.ghosts = [];
        return result;
      }
      return normal(device, channel, args);
    });
    let push!: (value: unknown) => void;
    window.electronAPI.deviceLink.onRemotePush = ((listener: typeof push) => { push = listener; return () => {}; }) as never;
    const ui = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await waitFor(() => expect(reads).toBe(1));
    vi.useFakeTimers();
    const notification = { deviceId: 'computer-a', channel: 'maker:remote-resources:changed', payload: { collectionId: 'plugins' } };
    await act(async () => { push(notification); await vi.advanceTimersByTimeAsync(250); });
    expect(reads).toBe(2);
    await act(async () => {
      for (let i = 0; i < 45; i++) push(notification);
      rejectRead(new Error('temporary failure'));
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(reads).toBe(3);
    expect(screen.getByText('newChat.pluginUi.enable')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(reads).toBe(3);
    ui.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  });
  // Unit: neither relay nor target disconnects replay missed plugin notifications.
  // Exercise the retained production entry with no mounted consumers, then remount.
  it.each(['relay', 'target', 'target-before-relay', 'peer-reset', 'peer-reopened'])('invalidates retained discovery across a %s disconnect without consumers', async source => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    let pending = false;
    invoke.mockImplementation(async (device, channel, args) => {
      const result = await normal(device, channel, args);
      if (args?.[0]?.actionId === 'management:snapshot' && !pending) result.result.ghosts = [];
      return result;
    });
    let status!: Parameters<typeof window.electronAPI.deviceLink.onStatusChanged>[0];
    let presence!: Parameters<typeof window.electronAPI.deviceLink.onPresenceChanged>[0];
    const offStatus = vi.fn(), offPresence = vi.fn();
    let peerReset!: (event: { deviceId: string }) => void;
    let peerReopened!: (event: { deviceId: string }) => void;
    const offPeerReset = vi.fn(), offPeerReopened = vi.fn();
    window.electronAPI.deviceLink.onPeerLinkReset = listener => { peerReset = listener; return offPeerReset; };
    window.electronAPI.deviceLink.onPeerLinkReopened = listener => { peerReopened = listener; return offPeerReopened; };
    window.electronAPI.deviceLink.onStatusChanged = listener => { status = listener; return offStatus; };
    window.electronAPI.deviceLink.onPresenceChanged = listener => { presence = listener; return offPresence; };
    const reads = () => invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:snapshot').length;
    const first = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await waitFor(() => expect(reads()).toBe(1));
    first.unmount();
    vi.useFakeTimers();
    await act(async () => {
      peerReset({ deviceId: 'other-computer' });
      peerReopened({ deviceId: 'other-computer' });
      await vi.advanceTimersByTimeAsync(250);
    });
    const unchanged = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads()).toBe(1);
    unchanged.unmount();
    await act(async () => {
      pending = true;
      if (source === 'peer-reset') peerReset({ deviceId: 'computer-a' });
      else if (source === 'peer-reopened') peerReopened({ deviceId: 'computer-a' });
      else {
        if (source !== 'relay') presence({ deviceId: 'computer-a', online: false } as never);
        if (source !== 'target') status({ status: 'connecting' });
        if (source === 'target') presence({ deviceId: 'computer-a', online: true } as never);
        // A new relay connection never replays target presence. The directory can
        // confirm online on remount even though this entry saw the old offline push.
        else status({ status: 'online' });
      }
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(reads()).toBe(1);
    const second = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads()).toBe(2);
    expect(screen.getByText('newChat.pluginUi.enable')).toBeTruthy();
    second.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(offStatus).toHaveBeenCalledOnce();
    expect(offPresence).toHaveBeenCalledOnce();
    expect(offPeerReset).toHaveBeenCalledOnce();
    expect(offPeerReopened).toHaveBeenCalledOnce();
  });
  // Unit: the real directory Hook initially reports offline until getState settles.
  // A second composer used to destroy the first composer's live shared subscription.
  it('preserves shared consent through directory initialization and refreshes after a real disconnect', async () => {
    setup(true);
    directoryMode.real = true;
    const statusListeners = new Set<(state: { status: string }) => void>();
    const getState = vi.fn(async () => ({ linkStatus: 'online' }));
    window.electronAPI.deviceLink.getState = getState as never;
    window.electronAPI.deviceLink.onStatusChanged = ((listener: (state: { status: string }) => void) => {
      statusListeners.add(listener);
      return () => { statusListeners.delete(listener); };
    }) as never;
    let push: ((value: unknown) => void) | undefined;
    const subscribe = vi.fn(listener => { push = listener; return () => {}; });
    window.electronAPI.deviceLink.onRemotePush = subscribe as never;
    const first = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await screen.findByText('newChat.pluginUi.enable');
    const reads = () => invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:snapshot').length;
    expect(reads()).toBe(1);
    let resolveState!: (state: { linkStatus: string }) => void;
    getState.mockImplementationOnce(() => new Promise(resolve => { resolveState = resolve; }));
    const second = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await act(async () => { resolveState({ linkStatus: 'online' }); });
    expect(screen.getAllByText('newChat.pluginUi.enable')).toHaveLength(2);
    expect(reads()).toBe(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      const result = await normal(device, channel, args);
      if (args?.[0]?.actionId === 'management:snapshot') result.result.ghosts = [];
      return result;
    });
    vi.useFakeTimers();
    await act(async () => {
      push!({ deviceId: 'computer-a', channel: 'maker:remote-resources:changed', payload: { collectionId: 'plugins' } });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(reads()).toBe(2);
    expect(screen.queryByText('newChat.pluginUi.enable')).toBeNull();
    await act(async () => { for (const listener of statusListeners) listener({ status: 'offline' }); });
    await act(async () => { for (const listener of statusListeners) listener({ status: 'online' }); });
    expect(reads()).toBe(3);
    expect(subscribe).toHaveBeenCalledTimes(2);
    first.unmount();
    second.unmount();
    // All-composer route replacement also starts with the real Hook's offline value.
    const switched = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await act(async () => {});
    expect(reads()).toBe(3);
    expect(subscribe).toHaveBeenCalledTimes(2);
    switched.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  });
  // Unit: two actual composers and 45 notifications previously caused 90 full reads.
  // Exercise capability negotiation, old Hosts and the shared production subscription.
  it.each([true, false])('shares and coalesces consent reads (compact Host: %s)', async compact => {
    setup(true);
    const normal = invoke.getMockImplementation()!;
    invoke.mockImplementation(async (device, channel, args) => {
      if (args?.[0]?.actionId === 'management:ui-consent') {
        const legacy = await normal(device, channel, [{ ...args[0], actionId: 'management:snapshot' }]);
        return { effects: [], result: projectPluginUiConsent(legacy.result.ghosts, true) };
      }
      const result = await normal(device, channel, args);
      if (compact && channel.endsWith(':manifest')) {
        result.collections.find((c: { id: string }) => c.id === 'plugins').actions.push({ id: 'management:ui-consent' });
      }
      return result;
    });
    let push: ((value: unknown) => void) | undefined;
    window.electronAPI.deviceLink.onRemotePush = vi.fn(listener => { push = listener; return () => {}; }) as never;
    const ui = render(<><RemotePluginUiEnablePrompt deviceId="computer-a" /><RemotePluginUiEnablePrompt deviceId="computer-a" /></>);
    await waitFor(() => expect(screen.getAllByText('newChat.pluginUi.enable')).toHaveLength(2));
    const reads = () => invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === (compact ? 'management:ui-consent' : 'management:snapshot')).length;
    expect(reads()).toBe(1);
    expect(window.electronAPI.deviceLink.onRemotePush).toHaveBeenCalledTimes(1);
    if (compact) expect(invoke.mock.calls.some(c => c[2]?.[0]?.actionId === 'management:snapshot')).toBe(false);
    vi.useFakeTimers();
    await act(async () => {
      for (let i = 0; i < 45; i++) push!({ deviceId: 'computer-a', channel: 'maker:remote-resources:changed', payload: { collectionId: 'plugins' } });
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(reads()).toBe(2);
    ui.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    const switched = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    expect(screen.getByText('newChat.pluginUi.enable')).toBeTruthy();
    expect(reads()).toBe(2);
    expect(window.electronAPI.deviceLink.onRemotePush).toHaveBeenCalledTimes(1);
    switched.unmount();
    await act(async () => {
      for (let i = 0; i < 45; i++) push!({ deviceId: 'computer-a', channel: 'maker:remote-resources:changed', payload: { collectionId: 'plugins' } });
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(reads()).toBe(2);
    const changedWhileAway = render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(reads()).toBe(3);
    changedWhileAway.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    vi.useRealTimers();
  });
  // Unit, real prompt + push listener. Every remote task composer mounts this prompt; a
  // working teammate's status pushes re-read the ~1 MB plugin snapshot each time and
  // starved the link to that computer (2026-11-03: 86 snapshots, 129.5 MB). Plugin
  // changes are always pushed with collectionId "plugins"; other collections must not
  // re-read it, while a plugin change still must.
  it.each([
    ['teammates', 0],
    ['bot-groups', 0],
    ['plugin-results', 0],
    ['plugins', 1],
  ])('re-reads the plugin snapshot after a %s change: %i', async (collectionId, rereads) => {
    setup(true);
    let push: ((value: unknown, stamp?: unknown) => void) | undefined;
    window.electronAPI.deviceLink.onRemotePush = ((listener: typeof push) => {
      push = listener;
      return () => {};
    }) as never;
    render(<RemotePluginUiEnablePrompt deviceId="computer-a" />);
    await screen.findByText('newChat.pluginUi.enable');
    const snapshots = () => invoke.mock.calls.filter(c => c[2]?.[0]?.actionId === 'management:snapshot').length;
    const before = snapshots();
    vi.useFakeTimers();
    await act(async () => {
      push!({ deviceId: 'computer-a', channel: 'maker:remote-resources:changed', payload: { collectionId } });
      await vi.advanceTimersByTimeAsync(250);
    });
    vi.useRealTimers();
    await waitFor(() => expect(snapshots()).toBe(before + rereads));
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    expect(snapshots()).toBe(before + rereads);
  });

});

// Unit / round-5: the remote source control shares the same viewport contract.
// The old remote setter did not start the new list when its bar was pinned.
it.each([[120, 50], [-50, 0]])('switches a remote source without forcing an unpinned bar (top=%s)', async (top, expected) => {
  render(<RemotePluginPage device={{ deviceId: 'computer-a', name: 'A' }} online />);
  await screen.findByText('computer-a');
  fireEvent.click(screen.getByRole('tab', { name: /^settings.ghosts.page.marketSection/ }));
  const radio = await screen.findByRole('radio', { name: /settings.ghosts.page.origin.public/ });
  const marker = radio.closest('[role="radiogroup"]')!.parentElement!.parentElement!.previousElementSibling!;
  const root = screen.getByRole('main');
  vi.spyOn(root, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 800));
  vi.spyOn(marker, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, top, 800, 0));
  root.scrollTop = 50; fireEvent.click(radio);
  expect(root.scrollTop).toBe(expected);
});
