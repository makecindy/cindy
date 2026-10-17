// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderShareReceived } from '@cindy/device-link';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { __testing as localProviderGroupsTesting } from '@/features/provider-group/useLocalProviderGroups';
import { __resetForTest, addModelFavorite, listModelFavorites, setModelFavoritesOwner } from '@/state/modelFavorites';
import { providerShareFavoriteSource } from '@/state/providerShareFavorites';

import type {
  ProviderShareOwnerState,
  ProviderShareRequestedEvent,
  ProviderShareSettledEvent,
  ProviderShareReceivedSnapshot,
} from '../../../../shared/providerShare';
import { ProviderShareGlobalHost } from '../ProviderShareGlobalHost';
import { resetProviderShareStoreForTests } from '../providerShareStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => bus.auth }));
vi.mock('@/lib/remoteCatalogSnapshot', () => ({ refreshRemoteCatalogSnapshot: vi.fn(async () => undefined) }));
vi.mock('@/hooks/useDeviceProviders', () => ({
  getCachedDeviceProviders: () => null,
  useDeviceProviders: () => remoteCatalog,
}));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => localCatalog }));
vi.mock('@/features/cc-agent/lib/genericNewMakerRouteState', () => ({
  makeGenericNewMakerRouteState: () => ({ workspacePrompt: 'generic' }),
}));

const request = {
  requestId: 'req-1',
  displayName: 'Wang Yi',
  avatarUrl: null,
  region: 'global' as const,
  pairingCode: '4827',
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

function ownerState(requests = [request]): ProviderShareOwnerState {
  return {
    ready: true,
    shares: [
      { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI', createdAt: '2026-10-01T00:00:00Z', members: [], requests },
    ],
  };
}

const bus = vi.hoisted(() => ({
  auth: { dataOwnerId: 'recipient', dataOwnerGeneration: 1 },
  received: [] as ProviderShareReceived[],
  command: vi.fn(),
  requested: new Set<(event: ProviderShareRequestedEvent) => void>(),
  settled: new Set<(event: ProviderShareSettledEvent) => void>(),
  manage: new Set<(event: { providerId: string }) => void>(),
}));

const localCatalog = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; source: string; auth: { method: string; native?: string } }>,
}));

const remoteCatalog = vi.hoisted(() => ({
  providers: [] as Array<{ id: string; source: string; auth: { method: string; native?: string }; group?: unknown }>,
  loading: false,
  error: null as string | null,
  unsupported: false,
}));

function listen<T>(set: Set<T>) {
  return (cb: T) => {
    set.add(cb);
    return () => set.delete(cb);
  };
}

let currentOwner: ProviderShareOwnerState = ownerState();
const receivedShare: ProviderShareReceived = {
  shareId: 's1', memberId: 'm1', providerId: 'anthropic', providerLabel: 'Anthropic', hostDeviceId: 'host',
  deviceName: 'Host', owner: { displayName: 'Owner', avatarUrl: null, region: 'global' },
  status: 'active', hostOnline: true, hostCapable: true,
};
const membership = (): ProviderShareReceivedSnapshot => ({
  ownerStamp: { dataOwnerId: bus.auth.dataOwnerId, ownerGeneration: bus.auth.dataOwnerGeneration },
  confirmedRegions: ['global'], received: bus.received,
});

beforeEach(() => {
  resetProviderShareStoreForTests();
  __resetForTest();
  localProviderGroupsTesting.reset();
  window.localStorage.clear();
  bus.auth = { dataOwnerId: 'recipient', dataOwnerGeneration: 1 };
  bus.received = [receivedShare];
  setDataOwnerGeneration('recipient', 1);
  setModelFavoritesOwner('recipient');
  bus.command.mockReset();
  bus.requested.clear();
  bus.settled.clear();
  bus.manage.clear();
  localCatalog.providers = [{ id: 'xd', source: 'builtin', auth: { method: 'apiKey' } }];
  remoteCatalog.providers = [];
  remoteCatalog.loading = false;
  remoteCatalog.error = null;
  remoteCatalog.unsupported = false;
  currentOwner = ownerState();
  bus.command.mockImplementation(async (command: { action: string }) => {
    if (command.action === 'owned') return currentOwner;
    if (command.action === 'received') return [];
    if (command.action === 'received-snapshot') return membership();
    if (command.action === 'approve' || command.action === 'reject') {
      currentOwner = ownerState([]);
      return { ok: true };
    }
    throw new Error(`unexpected ${command.action}`);
  });
  Object.assign(window, {
    electronAPI: {
      providerGroup: { command: vi.fn(async () => ({})), onChanged: () => () => undefined },
      providerShare: {
        command: bus.command,
        onOwnedChanged: () => () => undefined,
        onReceivedChanged: () => () => undefined,
        onRequested: listen(bus.requested),
        onSettled: listen(bus.settled),
        onOpenJoin: () => () => undefined,
        onOpenManage: listen(bus.manage),
      },
    },
  });
});

afterEach(() => { cleanup(); resetProviderShareStoreForTests(); vi.restoreAllMocks(); });

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location">{`${location.pathname}${location.search}`}</div>;
}

function renderHost() {
  return render(
    <MemoryRouter initialEntries={['/cc-agent']}>
      <ProviderShareGlobalHost />
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('ProviderShareGlobalHost', () => {
  it('resumes failed favorite cleanup after same-owner repair without a share push', async () => {
    currentOwner = ownerState([]);
    bus.received = [];
    addModelFavorite({ providerId: providerShareFavoriteSource(receivedShare), modelId: 'opus', agent: 'cc' });
    const writes = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage unavailable'); });
    const view = renderHost();
    await waitFor(() => expect(writes).toHaveBeenCalled());
    expect(listModelFavorites()).toHaveLength(1);
    writes.mockRestore();
    bus.auth = { ...bus.auth, dataOwnerGeneration: 2 };
    setDataOwnerGeneration('recipient', 2);
    view.rerender(<MemoryRouter><ProviderShareGlobalHost /><LocationProbe /></MemoryRouter>);
    await waitFor(() => expect(listModelFavorites()).toEqual([]));
    expect(bus.command).toHaveBeenCalledWith(expect.objectContaining({
      action: 'received-snapshot',
      favoriteRecovery: { ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 2 }, regions: ['global'] },
    }));
  });

  it('refetches membership on same-owner repair and ignores an earlier generation reply', async () => {
    currentOwner = ownerState([]);
    addModelFavorite({ providerId: providerShareFavoriteSource(receivedShare), modelId: 'opus', agent: 'cc' });
    let finish!: (snapshot: ProviderShareReceivedSnapshot) => void;
    bus.command.mockImplementation(async (command: { action: string }) => {
      if (command.action === 'owned') return currentOwner;
      if (command.action === 'received') return bus.received;
      if (bus.auth.dataOwnerGeneration === 1) return new Promise((resolve) => { finish = resolve; });
      return membership();
    });
    const view = renderHost();
    await waitFor(() => expect(finish).toBeTypeOf('function'));
    const old = { ...membership(), received: [] };
    bus.auth = { ...bus.auth, dataOwnerGeneration: 2 };
    setDataOwnerGeneration('recipient', 2);
    view.rerender(<MemoryRouter><ProviderShareGlobalHost /><LocationProbe /></MemoryRouter>);
    await waitFor(() => expect(bus.command).toHaveBeenCalledWith(expect.objectContaining({
      action: 'received-snapshot',
      favoriteRecovery: { ownerStamp: { dataOwnerId: 'recipient', ownerGeneration: 2 }, regions: ['global'] },
    })));
    await act(async () => { finish(old); });
    expect(listModelFavorites()).toHaveLength(1);
    bus.received = [];
    bus.auth = { ...bus.auth, dataOwnerGeneration: 3 };
    setDataOwnerGeneration('recipient', 3);
    view.rerender(<MemoryRouter><ProviderShareGlobalHost /><LocationProbe /></MemoryRouter>);
    await waitFor(() => expect(listModelFavorites()).toEqual([]));
  });

  it('queues pending requests found at startup and approves from the dialog', async () => {
    renderHost();
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect(dialog.textContent).toContain('providerShare.approve.title');
    expect(screen.getByTestId('provider-share-pairing-code').textContent).toBe('4827');

    fireEvent.click(screen.getByRole('button', { name: 'providerShare.approve.approve' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    expect(bus.command).toHaveBeenCalledWith({ action: 'approve', requestId: 'req-1' });
    const { toast } = await import('@/lib/toast');
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('providerShare.toast.approved'));
  });

  it('decide later keeps the request pending and does not reopen it for the same run', async () => {
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.approve.later' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    expect(bus.command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));

    // main 重连后重新推送同一条申请：本次运行已弹过，不再弹。
    act(() => {
      for (const listener of bus.requested) {
        listener({ request, share: { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI' } });
      }
    });
    expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull();
  });

  it('opens a dialog for a newly requested share', async () => {
    currentOwner = ownerState([]);
    renderHost();
    await waitFor(() => expect(bus.command).toHaveBeenCalledWith({ action: 'owned', range: 'month' }));
    act(() => {
      for (const listener of bus.requested) {
        listener({
          request: { ...request, requestId: 'req-9', displayName: 'Kai' },
          share: { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI' },
        });
      }
    });
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect(dialog.textContent).toContain('Kai');
  });

  it('toasts the result of a request whose dialog was closed', async () => {
    currentOwner = ownerState([]);
    renderHost();
    await waitFor(() => expect(bus.settled.size).toBeGreaterThan(0));
    act(() => {
      for (const listener of bus.settled) {
        listener({
          state: { requestId: 'req-x', status: 'approved', pairingCode: '1111', expiresAt: request.expiresAt },
          preview: {
            shareId: 'share-1',
            providerId: 'xd',
            providerLabel: 'Cindy AI',
            deviceName: "Magi's Mac Mini",
            owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
            state: 'used',
            expiresAt: request.expiresAt,
          },
        });
      }
    });
    const { toast } = await import('@/lib/toast');
    expect(toast.success).toHaveBeenCalledWith(
      expect.stringContaining('providerShare.apply.toastApproved'),
      expect.anything(),
    );
  });

  // provider-sharing.md §4.1 第 4 步：审批弹窗跟着生成链接的电脑。
  it('does not pop requests on this computer\'s share when another computer generated the link', async () => {
    currentOwner = { ...ownerState(), quietRequestIds: ['req-1'] };
    renderHost();
    await waitFor(() => expect(bus.command).toHaveBeenCalledWith({ action: 'owned', range: 'month' }));
    act(() => {
      for (const listener of bus.requested) {
        listener({
          request: { ...request, requestId: 'req-2' },
          share: { shareId: 'share-1', providerId: 'xd', providerLabel: 'Cindy AI' },
          quiet: true,
        });
      }
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull();
  });

  it('pops a request for another computer\'s share after generating its link here, and hands the decision to that computer', async () => {
    currentOwner = ownerState([]);
    remoteCatalog.providers = [{ id: 'anthropic', source: 'builtin', auth: { method: 'oauth' } }];
    const groupCommand = vi.fn(async () => ({ ok: true }));
    Object.assign(window.electronAPI, { providerGroup: { command: groupCommand } });
    renderHost();
    await waitFor(() => expect(bus.command).toHaveBeenCalledWith({ action: 'owned', range: 'month' }));
    act(() => {
      for (const listener of bus.requested) {
        listener({
          request: { ...request, requestId: 'req-7', displayName: 'Kai' },
          share: { shareId: 'share-group', providerId: 'anthropic', providerLabel: 'Anthropic' },
          hostDeviceId: 'group-host',
        });
      }
    });
    const dialog = await screen.findByTestId('provider-share-approve-dialog');
    expect(dialog.textContent).toContain('Kai');
    expect(dialog.textContent).toContain('providerShare.approve.calloutRemote:');
    expect(dialog.textContent).not.toContain('providerShare.approve.callout:');
    fireEvent.click(screen.getByRole('button', { name: 'providerShare.approve.approve' }));
    await waitFor(() => expect(screen.queryByTestId('provider-share-approve-dialog')).toBeNull());
    expect(groupCommand).toHaveBeenCalledWith({
      action: 'remote-manage',
      deviceId: 'group-host',
      request: { action: 'manage-share', command: { action: 'approve', requestId: 'req-7' } },
    });
    expect(bus.command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));
  });

  it.each(['empty', 'unrelated'])('blocks a local approval when its provider directory is %s', async (catalog) => {
    localCatalog.providers = catalog === 'empty' ? [] : [{ id: 'openai', source: 'builtin', auth: { method: 'oauth' } }];
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.click(approve);
    expect(bus.command).not.toHaveBeenCalledWith({ action: 'approve', requestId: 'req-1' });
    const reject = screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement;
    expect(reject.disabled).toBe(false);
    fireEvent.click(reject);
    await waitFor(() => expect(bus.command).toHaveBeenCalledWith({ action: 'reject', requestId: 'req-1' }));
  });

  it.each(['empty', 'unrelated', 'loading', 'failed'])(
    'blocks a remote approval when its provider directory is %s, even if the local provider is known',
    async (catalog) => {
      localCatalog.providers = [{ id: 'anthropic', source: 'builtin', auth: { method: 'oauth' } }];
      remoteCatalog.providers = catalog === 'empty' ? [] : [{
        id: catalog === 'unrelated' ? 'openai' : 'anthropic', source: 'builtin', auth: { method: 'oauth' },
      }];
      remoteCatalog.loading = catalog === 'loading';
      remoteCatalog.error = catalog === 'failed' ? 'directory unavailable' : null;
      currentOwner = {
        ready: true,
        shares: [],
        watchedRequests: [{
          request,
          share: { shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic' },
          hostDeviceId: 'host',
        }],
      };
      const groupCommand = vi.fn(async () => ({ ok: true }));
      Object.assign(window.electronAPI, { providerGroup: { command: groupCommand } });
      renderHost();
      await screen.findByTestId('provider-share-approve-dialog');
      const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
      expect(approve.disabled).toBe(true);
      fireEvent.click(approve);
      // 弹窗会读本机组设置(list)，这里只确认没把同意转给那台电脑。
      expect(groupCommand).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'remote-manage' }));
      const reject = screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement;
      expect(reject.disabled).toBe(false);
      fireEvent.click(reject);
      await waitFor(() => expect(groupCommand).toHaveBeenCalledWith({
        action: 'remote-manage',
        deviceId: 'host',
        request: { action: 'manage-share', command: { action: 'reject', requestId: 'req-1' } },
      }));
    },
  );

  it('blocks approval until the remote provider directory classifies the provider', async () => {
    remoteCatalog.loading = true;
    currentOwner = {
      ready: true,
      shares: [],
      watchedRequests: [{
        request,
        share: { shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic' },
        hostDeviceId: 'host',
      }],
    };
    const view = renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(true);

    remoteCatalog.loading = false;
    remoteCatalog.providers = [{ id: 'anthropic', source: 'builtin', auth: { method: 'oauth' } }];
    view.rerender(
      <MemoryRouter initialEntries={['/cc-agent']}>
        <ProviderShareGlobalHost />
        <LocationProbe />
      </MemoryRouter>,
    );
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(screen.getByTestId('provider-share-approve-dialog').textContent).toContain('providerShare.approve.calloutClaudeEmail');
  });

  const groupConfig = { strategy: 'least', autoSwitch: true, members: [{ kind: 'local' }] };

  it('waits for local group settings before enabling approval', async () => {
    let finish!: (groups: Record<string, unknown>) => void;
    Object.assign(window.electronAPI, {
      providerGroup: { command: vi.fn(() => new Promise((resolve) => { finish = resolve; })), onChanged: () => () => undefined },
    });
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    await act(async () => finish({ xd: groupConfig }));
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.getByTestId('provider-share-approve-dialog').textContent).toContain('providerShare.approve.calloutGroup:');
  });

  it('disables approval while a group change refresh is pending and updates the callout before re-enabling it', async () => {
    let finish!: (groups: Record<string, unknown>) => void;
    let changed: () => void = () => undefined;
    const groups = vi.fn().mockResolvedValueOnce({}).mockImplementationOnce(
      () => new Promise((resolve) => { finish = resolve; }),
    );
    Object.assign(window.electronAPI, {
      providerGroup: { command: groups, onChanged: (listener: () => void) => { changed = listener; return () => undefined; } },
    });
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    const approve = screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement;
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.getByTestId('provider-share-approve-dialog').textContent).toContain('providerShare.approve.callout:');
    await act(async () => changed());
    expect(approve.disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(approve);
    expect(bus.command).not.toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));
    await act(async () => finish({ xd: groupConfig }));
    await waitFor(() => expect(approve.disabled).toBe(false));
    expect(screen.getByTestId('provider-share-approve-dialog').textContent).toContain('providerShare.approve.calloutGroup:');
  });

  it('keeps approval disabled after a failed group read and recovers when settings reload', async () => {
    const groups = vi.fn().mockRejectedValue(new Error('group settings unavailable'));
    let changed: () => void = () => undefined;
    Object.assign(window.electronAPI, {
      providerGroup: { command: groups, onChanged: (listener: () => void) => { changed = listener; return () => undefined; } },
    });
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    await waitFor(() => expect(window.electronAPI.providerGroup.command).toHaveBeenCalled());
    expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'providerShare.approve.reject' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('status').textContent).toBe('providerGroup.section.loadFailed');
    groups.mockResolvedValue({ xd: groupConfig });
    await act(async () => changed());
    await waitFor(() => expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId('provider-share-approve-dialog').textContent).toContain('providerShare.approve.calloutGroup:');
  });

  it.each([
    ['without a group says the Agent runs on this computer', false, 'providerShare.approve.callout:'],
    ['with a group says the provider group picks the computer', true, 'providerShare.approve.calloutGroup:'],
  ])('a local approval %s', async (_name, grouped, callout) => {
    Object.assign(window.electronAPI, {
      providerGroup: {
        command: vi.fn(async (command: { action: string }) => {
          if (command.action === 'list') return grouped ? { xd: groupConfig } : {};
          throw new Error(`unexpected ${command.action}`);
        }),
        onChanged: () => () => undefined,
      },
    });
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false),
    );
    const text = screen.getByTestId('provider-share-approve-dialog').textContent ?? '';
    expect(text).toContain(callout);
    expect(text).not.toContain(grouped ? 'providerShare.approve.callout:' : 'providerShare.approve.calloutGroup:');
  });

  it('an approval for another computer\'s share reads that computer\'s group', async () => {
    remoteCatalog.providers = [{ id: 'anthropic', source: 'builtin', auth: { method: 'apiKey' }, group: groupConfig }];
    currentOwner = {
      ready: true,
      shares: [],
      watchedRequests: [{
        request,
        share: { shareId: 'share-1', providerId: 'anthropic', providerLabel: 'Anthropic' },
        hostDeviceId: 'host',
      }],
    };
    renderHost();
    await screen.findByTestId('provider-share-approve-dialog');
    await waitFor(() =>
      expect((screen.getByRole('button', { name: 'providerShare.approve.approve' }) as HTMLButtonElement).disabled).toBe(false),
    );
    const text = screen.getByTestId('provider-share-approve-dialog').textContent ?? '';
    expect(text).toContain('providerShare.approve.calloutGroup:');
    expect(text).not.toContain('providerShare.approve.callout:');
  });

  it('opens the management page from a notification click', async () => {
    currentOwner = ownerState([]);
    renderHost();
    await waitFor(() => expect(bus.manage.size).toBeGreaterThan(0));
    act(() => {
      for (const listener of bus.manage) listener({ providerId: 'xd' });
    });
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=providers&shareProvider=xd');
  });
});
