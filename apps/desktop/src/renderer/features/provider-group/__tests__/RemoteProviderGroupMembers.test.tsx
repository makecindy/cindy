// @vitest-environment jsdom
/**
 * 另一台电脑上的供应商组(只读)：组所在电脑看它能用、这台电脑却连不上的组内电脑，不显示成能用
 * (provider-groups.md §10)。
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProviderGroupConfig, ProviderGroupView } from '../../../../shared/providerGroup';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { RemoteProviderGroupMembers } from '../RemoteProviderGroupMembers';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: () => undefined },
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && Object.keys(options).length > 0 ? `${key}:${JSON.stringify(options)}` : key,
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthDeviceId: () => 'self' }));
vi.mock('../../provider-share/providerShareNames', () => ({
  providerShareComputerName: (_t: unknown, name: string | null) => name ?? 'share',
  useProviderShareOwnerNameOf: () => () => null,
}));
vi.mock('../GroupMemberQuota', () => ({
  GroupMemberQuota: () => null,
  groupMemberQuotaTarget: () => null,
}));

const VM = {
  key: 'device:vm:anthropic',
  kind: 'device' as const,
  agentDeviceId: 'vm',
  providerId: 'anthropic',
  label: 'grok-bot-vm',
  limit: 4,
  weight: 1,
  paused: false,
};
const CONFIG: ProviderGroupConfig = { strategy: 'least', autoSwitch: true, members: [VM] };
type DeviceVersions = { devices: Array<{ deviceId: string; appVersion: string | null }> };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mountWith(
  status: Partial<ProviderGroupView['members'][number]>,
  options: {
    config?: ProviderGroupConfig;
    devices?: DeviceVersions['devices'];
    readDevices?: () => Promise<DeviceVersions>;
    readView?: () => Promise<ProviderGroupView>;
  } = {},
) {
  const { config = CONFIG, devices = [] } = options;
  const view: ProviderGroupView = {
    providerId: 'anthropic',
    config,
    members: config.members.map((member) => ({
      ...member, label: member.label ?? member.key, state: 'available', running: 2, ...status,
    })),
  };
  const command = vi.fn(options.readView ?? (async () => view));
  const listDevices = vi.fn(options.readDevices ?? (async () => ({ devices })));
  Object.assign(window, { electronAPI: { providerGroup: { command }, deviceLink: { listDevices } } });
  const mounted = render(<RemoteProviderGroupMembers deviceId="mini" providerId="anthropic" config={config} />);
  return { command, listDevices, ...mounted };
}

beforeEach(() => setDataOwnerGeneration('owner-a', 1));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('RemoteProviderGroupMembers', () => {
  // Unit regression: the same-account read-only list must retain the owner's
  // confirmed exhaustion reason without dropping running tasks or requiring expansion.
  it('shows confirmed quota exhaustion in the collapsed remote row and keeps the running count', async () => {
    mountWith({ state: 'cooling', usageLimit: { resetAtMs: null } });
    await screen.findByText('providerGroup.member.status.quotaExhausted');
    expect(screen.getByText('providerGroup.member.runningCount:{"count":2}')).toBeTruthy();
    expect(screen.queryByText('providerGroup.member.status.idle')).toBeNull();
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy();
  });

  it('reads versions from this computer’s device directory when an older group host omits them', async () => {
    const config: ProviderGroupConfig = { ...CONFIG, members: [
      { ...VM, key: 'local:anthropic', kind: 'local', agentDeviceId: null, label: 'Group host' },
      VM,
      { ...VM, key: 'device:self:anthropic', agentDeviceId: 'self', label: 'This computer' },
      { ...VM, key: 'share:guest:anthropic', kind: 'share', agentDeviceId: 'share:guest', label: 'Shared computer' },
    ] };
    mountWith({}, { config, devices: [
      { deviceId: 'mini', appVersion: '0.1.104-beta' },
      { deviceId: 'vm', appVersion: '0.1.103' },
      { deviceId: 'self', appVersion: '0.1.105' },
      // A share identifier must never be interpreted as a same-account device.
      { deviceId: 'share:guest', appVersion: '9.9.9' },
    ] });
    await screen.findByText('v0.1.104-beta');
    const rows = screen.getAllByTestId('remote-provider-group-member');
    expect(within(rows[0]).getByText('v0.1.104-beta')).toBeTruthy();
    expect(within(rows[1]).getByText('v0.1.103')).toBeTruthy();
    expect(within(rows[2]).getByText('v0.1.105')).toBeTruthy();
    expect(within(rows[3]).queryByText('v9.9.9')).toBeNull();
    expect(screen.queryByText('providerGroup.member.version.updateRequired')).toBeNull();
    expect(rows.every((row) => row.getAttribute('data-member-state') === 'available')).toBe(true);
  });

  it('keeps group status visible while the device directory is slow', async () => {
    const pending = deferred<DeviceVersions>();
    mountWith({}, { readDevices: () => pending.promise });
    await screen.findByText('providerGroup.member.runningCount:{"count":2}');
    expect(screen.queryByText('v0.1.103')).toBeNull();
    await act(async () => pending.resolve({ devices: [{ deviceId: 'vm', appVersion: '0.1.103' }] }));
    expect(screen.getByText('v0.1.103')).toBeTruthy();
  });

  it('shows the directory version even before the group status arrives', async () => {
    mountWith({}, {
      readView: () => new Promise(() => undefined),
      devices: [{ deviceId: 'vm', appVersion: '0.1.103' }],
    });
    await screen.findByText('v0.1.103');
    expect(screen.getByTestId('remote-provider-group-member').getAttribute('data-member-state')).toBe('loading');
  });

  it('preserves the group host’s version and state when the directory request fails', async () => {
    mountWith({ appVersion: '0.1.104', guestSupport: 'supported' }, {
      readDevices: async () => { throw new Error('Directory unavailable'); },
    });
    await screen.findByText('v0.1.104');
    expect(screen.getByText('providerGroup.member.runningCount:{"count":2}')).toBeTruthy();
    expect(screen.queryByText('settings.providers.remote.groupMembersFailed')).toBeNull();
  });

  it('prefers the group status version over a stale device directory version', async () => {
    mountWith({ appVersion: '0.1.105' }, {
      devices: [{ deviceId: 'vm', appVersion: '0.1.103' }],
    });
    await screen.findByText('v0.1.105');
    expect(screen.queryByText('v0.1.103')).toBeNull();
  });

  it('refreshes an offline computer’s reported version and drops invalid or no-longer-reported versions', async () => {
    vi.useFakeTimers();
    const { listDevices } = mountWith({ state: 'offline', running: 0 }, {
      devices: [{ deviceId: 'vm', appVersion: '0.1.103' }],
    });
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByText('v0.1.103')).toBeTruthy();
    listDevices.mockResolvedValue({ devices: [{ deviceId: 'vm', appVersion: '0.1.104-beta' }] });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.getByText('v0.1.104-beta')).toBeTruthy();
    expect(screen.queryByText('v0.1.103')).toBeNull();
    expect(screen.getByTestId('remote-provider-group-member').getAttribute('data-member-state')).toBe('offline');
    listDevices.mockResolvedValue({ devices: [{ deviceId: 'vm', appVersion: 'invalid version' }] });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.queryByText('v0.1.104-beta')).toBeNull();
    expect(screen.queryByText('vinvalid version')).toBeNull();
    listDevices.mockResolvedValue({ devices: [] });
    await act(async () => vi.advanceTimersByTimeAsync(15_000));
    expect(screen.queryByText('providerGroup.member.version.unknown')).toBeNull();
  });

  it('does not apply versions fetched for a previous account', async () => {
    const pending = deferred<DeviceVersions>();
    mountWith({}, { readDevices: () => pending.promise });
    await screen.findByText('providerGroup.member.runningCount:{"count":2}');
    setDataOwnerGeneration('owner-b', 2);
    await act(async () => pending.resolve({ devices: [{ deviceId: 'vm', appVersion: '0.1.103' }] }));
    expect(screen.queryByText('v0.1.103')).toBeNull();
  });

  it('discards a late directory response after switching to a different group', async () => {
    const pending = deferred<DeviceVersions>();
    const { listDevices, rerender } = mountWith({}, { readDevices: () => pending.promise });
    await screen.findByText('providerGroup.member.runningCount:{"count":2}');
    listDevices.mockResolvedValue({ devices: [{ deviceId: 'vm', appVersion: '0.1.104' }] });
    rerender(<RemoteProviderGroupMembers deviceId="other" providerId="anthropic" config={CONFIG} />);
    await screen.findByText('v0.1.104');
    await act(async () => pending.resolve({ devices: [{ deviceId: 'vm', appVersion: '0.1.103' }] }));
    expect(screen.getByText('v0.1.104')).toBeTruthy();
    expect(screen.queryByText('v0.1.103')).toBeNull();
  });

  it('shows the version and sharing update hint without hiding availability for the owner', async () => {
    mountWith({ appVersion: '0.1.103', guestSupport: 'needs-update' });
    await screen.findByText('v0.1.103');
    expect(screen.getByText('providerGroup.member.version.updateRequired')).toBeTruthy();
    expect(screen.getByTestId('remote-provider-group-member').getAttribute('data-member-state')).toBe('available');
    expect(screen.getByText('providerGroup.member.runningCount:{"count":2}')).toBeTruthy();
  });

  it('does not repeat unknown diagnostics in every row for an older group host', async () => {
    mountWith({});
    await screen.findByText('providerGroup.member.runningCount:{"count":2}');
    expect(screen.queryByText('providerGroup.member.version.unknown')).toBeNull();
    expect(screen.queryByText('providerGroup.member.version.supportUnknown')).toBeNull();
    expect(screen.queryByText('providerGroup.member.version.updateRequired')).toBeNull();
  });

  it('lists several accounts of one computer under that computer and keeps a one-account computer as one row', async () => {
    const config: ProviderGroupConfig = { ...CONFIG, members: [
      { ...VM, key: 'local:anthropic', kind: 'local', agentDeviceId: null, label: 'Group host' },
      { ...VM, providerName: 'Claude A' },
      { ...VM, key: 'device:vm:anthropic-b', providerId: 'anthropic-b' },
    ] };
    mountWith({}, { config, devices: [{ deviceId: 'vm', appVersion: '0.1.103' }] });
    const device = await screen.findByTestId('remote-provider-group-device');
    expect(screen.getAllByTestId('remote-provider-group-device')).toHaveLength(1);
    const header = within(device).getByTestId('remote-provider-group-device-header');
    expect(header.textContent).toContain('grok-bot-vm');
    expect(header.textContent).toContain('providerGroup.member.accountCount:{"count":2}');
    // 版本属于电脑：写在电脑那一层，账号行不重复。
    await waitFor(() => expect(within(header).getByText('v0.1.103')).toBeTruthy());
    const accounts = within(device).getAllByTestId('remote-provider-group-member');
    expect(accounts).toHaveLength(2);
    expect(accounts[0].textContent).toContain('Claude A');
    expect(accounts[0].textContent).not.toContain('grok-bot-vm');
    expect(within(accounts[0]).queryByText('v0.1.103')).toBeNull();
    // 旧组没有账号名快照、那台也没报：按第几个账号称呼，不显示内部 id。
    expect(accounts[1].textContent).toContain('providerGroup.member.accountFallback:{"index":2}');
    expect(accounts[1].textContent).not.toContain('anthropic-b');
    // 只有一个账号的组所在电脑不分两层。
    const host = screen.getAllByTestId('remote-provider-group-member')[0];
    expect(host.closest('[data-testid="remote-provider-group-device"]')).toBeNull();
    expect(host.textContent).toContain('Group host');
  });

  it('says this computer cannot reach a computer the group computer still sees as usable', async () => {
    mountWith({ unreachableHere: true });
    await waitFor(() => expect(screen.getByText('providerGroup.member.status.unreachableHere')).toBeTruthy());
    const row = screen.getByTestId('remote-provider-group-member');
    expect(row.getAttribute('data-unreachable-here')).toBe('true');
    // 运行数仍然列出，放在后面。
    expect(row.textContent).toContain('providerGroup.member.runningCount:{"count":2}');
  });

  it('shows the group computer’s status when this computer can reach it', async () => {
    mountWith({});
    await waitFor(() => expect(screen.getByText('providerGroup.member.runningCount:{"count":2}')).toBeTruthy());
    expect(screen.queryByText('providerGroup.member.status.unreachableHere')).toBeNull();
    expect(screen.getByTestId('remote-provider-group-member').getAttribute('data-unreachable-here')).toBeNull();
  });
});
