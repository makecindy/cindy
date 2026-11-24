// @vitest-environment jsdom
// Settings → Remote connections → My devices: cloud instance operations on their device cards.
// Production entry: CloudDeviceDirectory + the real MyDevicesPanel,
// in a data router as in the app. Guards admission (no CIS request or extra controls outside the
// allowlist), the hidden directory delete for CIS-managed instances, CIS-only rows, the card's
// actions in the card's ⋯ menu and its state subtitle, and the one-shot policy read (the list
// carries no policy). Unit tier; ~2 s.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { transferableAbortController } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DeviceLinkSettings } from '@/hooks/useDeviceLinkSettings';
import { MyDevicesPanel } from '@/components/settings/MyDevicesPanel';
import type { CloudInstanceView } from '../../../../shared/cloudInstanceControl';
import { CloudDeviceDirectory } from '../CloudDeviceDirectory';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) =>
      values ? `${key} ${Object.values(values).join(' ')}` : key,
    i18n: { language: 'en' },
  }),
}));
// The first instance read can take longer than 1 s on a loaded CI runner.
const FIRST_LOAD = { timeout: 3000 };
const mock = vi.hoisted(() => ({
  access: 'allowed',
  confirm: vi.fn<(input: { title?: string; confirmText?: string }) => Promise<boolean>>(),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: 'cloud', dataOwnerId: 'owner' }),
}));
vi.mock('../CloudInstanceAccess', () => ({ useCloudInstanceAccess: () => mock.access }));
vi.mock('@/components/ui/confirm-dialog-provider', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/components/ui/confirm-dialog-provider')>()),
  useConfirmDialog: () => ({ confirm: mock.confirm }),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const CLOUD = 'cloud-device-0123456789abcdef01234567';
const PENDING = 'cloud-device-89abcdef0123456789abcdef';
const device = (deviceId: string, name: string, platform: string) => ({
  deviceId, name, platform, appVersion: '0.1.121', lastSeenAt: null, online: true, busy: false,
  remoteControlEnabled: true, controlEnabled: true, isSelf: false,
});
const s = {
  enabled: true, linkStatus: 'online', connectionIssue: null, standby: false,
  devices: [device(CLOUD, '我的云端 Cindy', 'linux'), device('mac-1', 'Studio Mac', 'darwin')],
  controlledBy: [], revokedControllers: [], disabledControlDeviceIds: [], listError: null,
  refreshing: false, refresh: vi.fn(), setEnabled: vi.fn(), rename: vi.fn(), remove: vi.fn(),
  disconnectAll: vi.fn(), revoke: vi.fn(), restore: vi.fn(), setDeviceControlEnabled: vi.fn(),
} as unknown as DeviceLinkSettings;
const view = (deviceId: string, extra: Partial<CloudInstanceView> = {}): CloudInstanceView => ({
  instanceId: deviceId, deviceId, name: null, nameSequence: 1, ordinal: 1, desiredState: 'running',
  runtimeState: 'running', ready: true, version: '0.1.121-cloud.10', imageId: null,
  updateAvailable: false, latestVersion: null, upgradeState: 'idle', observedAtMs: null,
  manualUpgrade: true,
  // Main's list projection never carries the policy; only instanceRead does.
  maintenance: null,
  ...extra,
});
const withPolicy = (deviceId: string, autoUpdate = true) => ({
  ...view(deviceId),
  maintenance: {
    instanceId: deviceId, revision: 'a'.repeat(64), defaultsRevision: 1, autoUpdate,
    raw: { policyMode: 'inherit', calendar: null, scheduledTaskPolicy: 'protect', pausedUntilMs: null },
    effective: {
      source: 'inherit',
      calendar: {
        timezone: 'Asia/Shanghai',
        windows: [{ id: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '03:00', endLocal: '05:00' }],
      },
    },
    executionMode: 'scheduled' as const, nextEligibleAtMs: 10000, serverTimeMs: 100, windows: [],
  },
});
let api: Record<string, ReturnType<typeof vi.fn>>;

function renderDevices() {
  const router = createMemoryRouter(
    [
      {
        path: '/settings',
        element: (
          <CloudDeviceDirectory
            enabled
            directory={s.devices!.map((d) => d.deviceId)}
            offline={s.devices!.filter((d) => !d.online).map((d) => d.deviceId)}
            devicesOpen={false}
          >
            {(cloud) => (
              <>
                <MyDevicesPanel s={s} variant="cloud" cloud={cloud} />
                <MyDevicesPanel s={s} variant="others" cloud={cloud} />
              </>
            )}
          </CloudDeviceDirectory>
        ),
      },
      { path: '/cloud-settings', element: <p>cloud settings page</p> },
    ],
    { initialEntries: ['/settings?tab=remote-control'] },
  );
  render(<RouterProvider router={router} />);
  return router;
}
const row = (deviceId: string) =>
  document.querySelector<HTMLElement>(`li[data-device-id="${deviceId}"]`)!;
/** The card's ⋯ menu (the card's only actions layout), named Manage. */
const manage = (deviceId = CLOUD) =>
  within(row(deviceId)).getByRole('button', { name: 'cloudSettings.instance.manage' });
/** Opens the card's ⋯ menu and returns its items. */
const openMenu = async (deviceId = CLOUD) => {
  fireEvent.keyDown(manage(deviceId), { key: 'Enter' });
  return screen.findAllByRole('menuitem');
};
const item = (items: HTMLElement[], key: string) =>
  items.find((element) => element.textContent?.startsWith(key))!;
/** Runs one of the card's actions from its ⋯ menu. */
const run = async (key: string, deviceId = CLOUD) => {
  fireEvent.click(item(await openMenu(deviceId), key));
};

// React Router builds Node Requests; their signal must come from the same realm (as in
// botSettingsDrawer.test.tsx), or jsdom's AbortController rejects every navigation.
const nativeAbortController = transferableAbortController();

beforeEach(() => {
  vi.stubGlobal('AbortController', nativeAbortController.constructor);
  vi.stubGlobal('AbortSignal', nativeAbortController.signal.constructor);
  mock.access = 'allowed';
  mock.confirm.mockResolvedValue(false);
  api = {
    instanceList: vi.fn().mockResolvedValue([view(CLOUD), view(PENDING, { loginRequired: true, ready: false, runtimeState: 'starting', nameSequence: 2 })]),
    instanceRead: vi.fn(async ({ deviceId }: { deviceId: string }) => withPolicy(deviceId)),
    instanceClaim: vi.fn(),
    instancePower: vi.fn(),
  };
  vi.stubGlobal('electronAPI', {
    cloudSettings: api,
    cloudLoginWindow: { open: vi.fn(), onCompleted: vi.fn(() => () => undefined) },
    openRemoteDesktop: vi.fn(),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('cloud instances on My devices cards', () => {
  it.each(['allowed', 'checking', 'hidden'])('adds instance operations only for admitted accounts (%s)', async (access) => {
    mock.access = access;
    renderDevices();
    // An admitted account loads the instance operations on first use; the card is drawn again.
    if (access === 'allowed') await waitFor(() => expect(api.instanceList).toHaveBeenCalled(), FIRST_LOAD);
    const cloudRow = row(CLOUD);
    if (access !== 'allowed') {
      expect(within(cloudRow).getByRole('button', { name: 'settings.devices.delete' })).toBeTruthy();
      expect(within(cloudRow).queryByRole('button', { name: 'cloudSettings.instance.manage' })).toBeNull();
      // The directory's own status stays; nothing is added between the header and the switches.
      expect(within(cloudRow).getByText(/settings\.devices\.status\.online/)).toBeTruthy();
      expect(cloudRow.querySelector('[data-cloud-instance]')).toBeNull();
      expect(row(PENDING)).toBeNull();
      expect(screen.queryByRole('list', { name: 'cloudSettings.instance.title' })).toBeNull();
      expect(api.instanceList).not.toHaveBeenCalled();
      expect(api.instanceRead).not.toHaveBeenCalled();
      return;
    }
    // CIS state replaces the directory's online / last seen in the subtitle; no separate state row.
    await within(cloudRow).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    expect(within(cloudRow).queryByText(/settings\.devices\.status\.online/)).toBeNull();
    // Running and signed in: the actions are in the ⋯ menu, nothing under the header.
    expect(manage()).toBeTruthy();
    expect(cloudRow.querySelector('[data-cloud-instance]')).toBeNull();
    // Other devices keep the directory's status and gain no instance rows.
    expect(within(row('mac-1')).getByText(/settings\.devices\.status\.online/)).toBeTruthy();
    expect(row('mac-1').querySelector('[data-cloud-instance]')).toBeNull();
    // The directory delete would only drop a record the running instance re-creates.
    expect(within(cloudRow).queryByRole('button', { name: 'settings.devices.delete' })).toBeNull();
    expect(within(row('mac-1')).getByRole('button', { name: 'settings.devices.delete' })).toBeTruthy();
    // Cloud instances are pinned with this computer, outside the collapsible list: the
    // directory's instance first, then a CIS-only instance waiting for login.
    const pending = row(PENDING);
    expect(within(pending).getByRole('button', { name: 'cloudSettings.onboarding.initialize' })).toBeTruthy();
    const pinned = screen.getByRole('list', { name: 'cloudSettings.instance.title' });
    expect([...pinned.querySelectorAll('li[data-device-id]')].map((li) => li.getAttribute('data-device-id'))).toEqual([CLOUD, PENDING]);
    expect(within(pinned).queryByText('Studio Mac')).toBeNull();
    expect(api.instanceList).toHaveBeenCalledTimes(1);
  });

  // Maintenance is a dialog, not a form inside the card: the switch saves as it changes and only
  // 完成 closes it, never asking.
  it('saves maintenance as it changes in the dialog, and closes without asking', async () => {
    api.instancePolicy = vi.fn(async () => withPolicy(CLOUD, false).maintenance);
    const router = renderDevices();
    await within(row(CLOUD)).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    expect(api.instanceRead).not.toHaveBeenCalled();
    const trigger = manage();
    await run('cloudSettings.instance.updates');
    const dialog = await screen.findByRole('dialog', { name: 'cloudSettings.instance.updates' });
    // Versions and maintenance only; sleep stays on the card itself.
    await within(dialog).findByText(/0\.1\.121-cloud\.10/);
    expect(within(dialog).queryByRole('button', { name: /cloudSettings\.instance\.sleep/ })).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'cloudSettings.instance.save' })).toBeNull();
    const autoUpdate = await within(dialog).findByRole('switch', { name: 'cloudSettings.instance.autoUpdateEnable' });
    await waitFor(() => expect(document.activeElement).toBe(autoUpdate));
    fireEvent.click(autoUpdate);
    await waitFor(() => expect(api.instancePolicy).toHaveBeenCalledTimes(1));
    // The scrim does not close it.
    fireEvent.pointerDown(document.querySelector('.modal-scrim')!);
    expect(screen.getByRole('dialog')).toBeTruthy();
    // Esc is 完成: it closes at once and focus returns to the card's ⋯.
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(mock.confirm).not.toHaveBeenCalled();
    // Nothing is held: leaving the page needs no answer.
    await router.navigate('/settings?tab=general');
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(api.instancePower).not.toHaveBeenCalled();
  });

  it('closes with 完成', async () => {
    renderDevices();
    await within(row(CLOUD)).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    await run('cloudSettings.instance.updates');
    const dialog = await screen.findByRole('dialog', { name: 'cloudSettings.instance.updates' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'cloudSettings.instance.done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  // Upgrading stops the instance for a while, like sleep: it asks first, above the dialog.
  it('asks before upgrading and submits only after confirming', async () => {
    api.instanceList!.mockResolvedValue([
      view(CLOUD, { updateAvailable: true, latestVersion: '0.1.126-cloud.3-cn-amd64' }),
    ]);
    api.instanceUpgrade = vi.fn(async () => ({ operationId: 'op', phase: 'requested', active: true, updatedAtMs: 1 }));
    renderDevices();
    await within(row(CLOUD)).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    await run('cloudSettings.instance.updates');
    const dialog = await screen.findByRole('dialog');
    const upgrade = await within(dialog).findByRole('button', { name: 'cloudSettings.instance.upgradeNow' });
    fireEvent.click(upgrade);
    await waitFor(() => expect(mock.confirm).toHaveBeenCalledTimes(1));
    expect(mock.confirm.mock.calls[0]![0]).toMatchObject({
      title: `cloudSettings.instance.upgradeConfirmTitle ${'我的云端 Cindy'}`,
      confirmText: 'cloudSettings.instance.upgradeConfirm',
    });
    expect(api.instanceUpgrade).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
    mock.confirm.mockResolvedValue(true);
    fireEvent.click(upgrade);
    await waitFor(() => expect(api.instanceUpgrade).toHaveBeenCalledTimes(1));
  });

  // "There is an update": a dot on the ⋯ glyph and the mark on the menu's Updates item; the
  // trigger keeps its name.
  it.each([
    [{ updateAvailable: true, latestVersion: '0.1.126-cloud.3-cn-amd64' }, true],
    [{}, false],
  ])('marks the menu only when an update is available (%o)', async (extra, marked) => {
    const timer = vi.spyOn(globalThis, 'setInterval');
    api.instanceList!.mockResolvedValue([view(CLOUD, extra)]);
    renderDevices();
    await within(row(CLOUD)).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    expect(!!manage().querySelector('.bg-\\[var\\(--status-bar-accent\\)\\]')).toBe(marked);
    const updates = item(await openMenu(), 'cloudSettings.instance.updates');
    expect(updates.textContent).toBe(
      marked ? 'cloudSettings.instance.updatescloudSettings.instance.updateBadge' : 'cloudSettings.instance.updates',
    );
    // The list's polling never reads the policy; only the dialog does.
    const polls = timer.mock.calls.filter(([, ms]) => ms === 30_000).map(([poll]) => poll as () => void);
    expect(polls.length).toBeGreaterThan(0);
    await act(async () => polls.forEach((poll) => poll()));
    expect(api.instanceRead).not.toHaveBeenCalled();
    timer.mockRestore();
  });

  it('disables instance settings and remote desktop while asleep, and keeps wake and maintenance', async () => {
    api.instanceList!.mockResolvedValue([
      view(CLOUD, { desiredState: 'stopped', runtimeState: 'stopped', ready: false }),
    ]);
    renderDevices();
    const cloudRow = row(CLOUD);
    await within(cloudRow).findByText(/· cloudSettings\.instance\.state\.asleep$/);
    expect(
      within(cloudRow).getByRole<HTMLButtonElement>('button', { name: 'remoteDesktop.title' }).disabled,
    ).toBe(true);
    const items = await openMenu();
    // Why settings wait, on the item itself.
    const settings = item(items, 'cloudSettings.onboarding.openSettings');
    expect(settings.textContent).toContain('cloudSettings.instance.settingsWakeFirst');
    expect(settings.hasAttribute('data-disabled')).toBe(true);
    expect(item(items, 'cloudSettings.instance.wake').hasAttribute('data-disabled')).toBe(false);
    expect(item(items, 'cloudSettings.instance.updates').hasAttribute('data-disabled')).toBe(false);
  });

  it('shows how far an upgrade has got in the subtitle and why settings wait', async () => {
    api.instanceList!.mockResolvedValue([
      view(CLOUD, {
        upgradeOperation: { operationId: 'op', phase: 'backup-running', active: true, updatedAtMs: 1 },
      }),
    ]);
    renderDevices();
    await within(row(CLOUD)).findByText(/· cloudSettings\.instance\.cardUpdating$/);
    const settings = item(await openMenu(), 'cloudSettings.onboarding.openSettings');
    expect(settings.textContent).toContain('cloudSettings.instance.settingsUpgrading');
    expect(settings.textContent).not.toContain('cloudSettings.instance.settingsNotRunning');
  });

  // "Available once running" reads wrong during an upgrade, so upgrading has its own reason; an
  // instance that is only starting keeps the generic one.
  it('keeps the generic reason for an instance that is starting', async () => {
    api.instanceList!.mockResolvedValue([view(CLOUD, { runtimeState: 'starting', ready: false })]);
    renderDevices();
    await within(row(CLOUD)).findByText(/· cloudSettings\.instance\.state\.starting$/);
    const settings = item(await openMenu(), 'cloudSettings.onboarding.openSettings');
    expect(settings.textContent).toContain('cloudSettings.instance.settingsNotRunning');
    expect(settings.textContent).not.toContain('cloudSettings.instance.settingsUpgrading');
  });

  // During an upgrade DeviceLink is offline while CIS can still report running/ready from an
  // observation made before the upgrade began; the card must not say "running".
  it.each([
    ['an active operation', { upgradeOperation: { operationId: 'op', phase: 'backup-running', active: true, updatedAtMs: 2_000 } }],
    ['a finished operation newer than the last observation', { observedAtMs: 1_000, upgradeOperation: { operationId: 'op', phase: 'completed', active: false, updatedAtMs: 2_000 } }],
  ] as const)('shows an instance whose runtime is down for %s as upgrading', async (_label, extra) => {
    s.devices = s.devices!.map((d) => (d.deviceId === CLOUD ? { ...d, online: false } : d));
    try {
      api.instanceList!.mockResolvedValue([view(CLOUD, extra as Partial<CloudInstanceView>)]);
      renderDevices();
      await within(row(CLOUD)).findByText(
        /· cloudSettings\.instance\.cardUpdating$/,
      );
      const items = await openMenu();
      const settings = item(items, 'cloudSettings.onboarding.openSettings');
      expect(settings.textContent).toContain('cloudSettings.instance.settingsUpgrading');
      expect(settings.hasAttribute('data-disabled')).toBe(true);
      expect(item(items, 'cloudSettings.instance.sleep').hasAttribute('data-disabled')).toBe(true);
    } finally {
      s.devices = s.devices!.map((d) => (d.deviceId === CLOUD ? { ...d, online: true } : d));
    }
  });
  // The same stale record with the runtime back on DeviceLink is simply running.
  it('keeps a finished upgrade running once DeviceLink has the instance again', async () => {
    api.instanceList!.mockResolvedValue([
      view(CLOUD, { observedAtMs: 1_000, upgradeOperation: { operationId: 'op', phase: 'completed', active: false, updatedAtMs: 2_000 } }),
    ]);
    renderDevices();
    await within(row(CLOUD)).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
  });

  // Regression: the card offers no explicit refresh, so an unknown sleep/wake result must not stay
  // unsettled indefinitely. It re-reads on its own with a capped backoff until the state is clear,
  // and never resubmits.
  it('re-reads an unconfirmed power result on its own until the state is clear', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.instanceList!.mockResolvedValue([view(CLOUD)]);
      api.instancePower!.mockRejectedValueOnce(new Error('timeout'));
      mock.confirm.mockResolvedValue(true);
      renderDevices();
      const cloudRow = row(CLOUD);
      await within(cloudRow).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
      await run('cloudSettings.instance.sleep');
      // Unknown: the card shows it under way while it reads back.
      await within(cloudRow).findByText(/· cloudSettings\.instance\.state\.stopping$/);
      const reads = api.instanceList!.mock.calls.length;
      // The instance turns out to be asleep after all: a later read settles it.
      api.instanceList!.mockResolvedValue([
        view(CLOUD, { desiredState: 'stopped', runtimeState: 'stopped', ready: false }),
      ]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      await within(cloudRow).findByText(/· cloudSettings\.instance\.state\.asleep$/);
      expect(api.instanceList!.mock.calls.length).toBeGreaterThan(reads);
      // The next poll finds it settled: wake is on offer again.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(item(await openMenu(), 'cloudSettings.instance.wake').hasAttribute('data-disabled')).toBe(false);
      expect(api.instancePower).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// The card's actions sit in one ⋯ menu in the header row, before remote desktop.
describe('the card ⋯ menu', () => {
  const cloudRow = () => row(CLOUD);
  it('opens settings, the updates dialog and the sleep confirmation', async () => {
    const router = renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    await run('cloudSettings.instance.updates');
    const dialog = await screen.findByRole('dialog', { name: 'cloudSettings.instance.updates' });
    fireEvent.click(await within(dialog).findByRole('button', { name: 'cloudSettings.instance.done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Focus is back on ⋯.
    await waitFor(() => expect(document.activeElement).toBe(manage()));
    await run('cloudSettings.instance.sleep');
    await waitFor(() => expect(mock.confirm).toHaveBeenCalledTimes(1));
    expect(api.instancePower).not.toHaveBeenCalled();
    await run('cloudSettings.onboarding.openSettings');
    await waitFor(() => expect(router.state.location.pathname).toBe('/cloud-settings'));
    expect(new URLSearchParams(router.state.location.search).get('deviceId')).toBe(CLOUD);
  });
  it('lists the actions, disables what cannot be used and says why', async () => {
    api.instanceList!.mockResolvedValue([
      view(CLOUD, {
        updateAvailable: true,
        upgradeOperation: { operationId: 'op', phase: 'backup-running', active: true, updatedAtMs: 1 },
      }),
    ]);
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.cardUpdating$/);
    // An upgrade in progress is not an available update: no dot on ⋯.
    expect(manage().querySelector('.bg-\\[var\\(--status-bar-accent\\)\\]')).toBeNull();
    const items = await openMenu();
    expect(items.map((element) => element.textContent)).toEqual([
      'cloudSettings.onboarding.openSettingscloudSettings.instance.settingsUpgrading',
      'cloudSettings.instance.updatescloudSettings.instance.badgeUpdating',
      'cloudSettings.instance.sleepcloudSettings.instance.sleepAfterUpdate',
    ]);
    expect(items.map((element) => element.hasAttribute('data-disabled'))).toEqual([true, false, true]);
  });
  // Entered by a sliders icon named Manage, before remote desktop.
  it('is a sliders icon named Manage, before remote desktop and rename', async () => {
    api.instanceList!.mockResolvedValue([view(CLOUD, { updateAvailable: true })]);
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    const entry = manage();
    expect(entry.querySelector('svg.lucide-sliders-horizontal')).toBeTruthy();
    expect(entry.getAttribute('data-cloud-updates-opener')).toBe(CLOUD);
    expect(cloudRow().querySelector('[data-cloud-instance]')).toBeNull();
    const labels = [...cloudRow().querySelectorAll('button')].map((button) => button.getAttribute('aria-label'));
    expect(labels.indexOf('cloudSettings.instance.manage')).toBeLessThan(labels.indexOf('remoteDesktop.title'));
  });
  // The cloud slot is the cloud card's only: any other card renders exactly as without it.
  it('leaves another device card byte for byte as without the slot', async () => {
    mock.access = 'hidden';
    renderDevices();
    const before = row('mac-1').outerHTML;
    cleanup();
    mock.access = 'allowed';
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    expect(row('mac-1').outerHTML).toBe(before);
  });
  // The ⋯ stays ⋯; what is in progress spins on its own item.
  it('spins on Updates, not on ⋯, while upgrading, and Updates still opens the dialog', async () => {
    api.instanceList!.mockResolvedValue([
      view(CLOUD, { upgradeOperation: { operationId: 'op', phase: 'backup-running', active: true, updatedAtMs: 1 } }),
    ]);
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.cardUpdating$/);
    expect(manage().querySelector('.animate-spinner')).toBeNull();
    const updates = item(await openMenu(), 'cloudSettings.instance.updates');
    expect(updates.querySelector('.animate-spinner')).toBeTruthy();
    expect(updates.hasAttribute('data-disabled')).toBe(false);
    fireEvent.click(updates);
    await screen.findByRole('dialog', { name: 'cloudSettings.instance.updates' });
  });
  // Once it is installing CIS no longer offers the release, but the instance's image already is
  // that release: the dialog names its version, never the image id.
  it('names the version being installed, not the image id, once CIS stops offering it', async () => {
    api.instanceList!.mockResolvedValue([
      view(CLOUD, {
        version: '0.1.139-cloud.1-cn-amd64',
        imageId: '6291d1f063fc'.padEnd(64, '0'),
        latestVersion: null,
        upgradeOperation: { operationId: 'op', phase: 'backup-running', active: true, updatedAtMs: 1 },
      }),
    ]);
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.cardUpdating$/);
    fireEvent.click(item(await openMenu(), 'cloudSettings.instance.updates'));
    const dialog = await screen.findByRole('dialog', { name: 'cloudSettings.instance.updates' });
    await within(dialog).findByText(/cloudSettings\.instance\.upgradingTo 0\.1\.139-cloud\.1$/);
    expect(dialog.textContent).not.toContain('#6291d1f063fc');
  });
  it('disables Sleep while the instance is going to sleep on its own, without a spinner', async () => {
    api.instanceList!.mockResolvedValue([view(CLOUD, { desiredState: 'stopped', runtimeState: 'stopping', ready: false })]);
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.stopping$/);
    const power = (await openMenu()).at(-1)!;
    // Only the user's own sleep or wake spins.
    expect(power.querySelector('.animate-spinner')).toBeNull();
    expect(power.hasAttribute('data-disabled')).toBe(true);
  });

  // Between confirming sleep (or clicking wake) and CIS listing the request, the card already shows
  // it under way, also with the menu closed.
  const asleep = () => view(CLOUD, { desiredState: 'stopped', runtimeState: 'stopped', ready: false });
  const running = () => view(CLOUD);
  // before → shown, then under way, then CIS lists after → settled.
  const powerCases = [
    { action: 'sleep', before: running, shown: 'running', under: 'stopping', after: asleep, settled: 'asleep' },
    { action: 'wake', before: asleep, shown: 'asleep', under: 'starting', after: running, settled: 'running' },
  ] as const;
  const subtitle = (state: string) => new RegExp(`· cloudSettings\\.instance\\.state\\.${state}$`);
  const dot = () => cloudRow().querySelector('span.rounded-full[aria-hidden]')!.getAttribute('style');
  it.each(powerCases)(
    'shows $action under way at once and follows CIS once it lists the new state',
    async ({ action, before, shown, under, after, settled }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mock.confirm.mockResolvedValue(true);
        api.instanceList!.mockResolvedValue([before()]);
        let accept!: () => void;
        api.instancePower!.mockReturnValue(new Promise<void>((resolve) => (accept = resolve)));
        renderDevices();
        await within(cloudRow()).findByText(subtitle(shown));
        await run(`cloudSettings.instance.${action}`);
        // While the request is still on its way.
        await within(cloudRow()).findByText(subtitle(under));
        expect(dot()).toContain('--remote-status-disconnected');
        // Accepted, and CIS still lists the old state: still under way.
        const reads = api.instanceList!.mock.calls.length;
        await act(async () => accept());
        await waitFor(() => expect(api.instanceList!.mock.calls.length).toBeGreaterThan(reads));
        expect(within(cloudRow()).getByText(subtitle(under))).toBeTruthy();
        // CIS lists the new state: the card shows it.
        api.instanceList!.mockResolvedValue([after()]);
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5_000);
        });
        await within(cloudRow()).findByText(subtitle(settled));
        expect(api.instancePower).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
  // A failed request has an unknown result: it is read back, never sent again, and when CIS still
  // lists the old state the card returns to it and says it did not happen, with a retry.
  it.each(powerCases)(
    'returns to the state CIS lists when the $action request fails',
    async ({ action, before, shown, under }) => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        mock.confirm.mockResolvedValue(true);
        api.instanceList!.mockResolvedValue([before()]);
        let fail!: (error: Error) => void;
        api.instancePower!.mockReturnValue(new Promise<void>((_, reject) => (fail = reject)));
        renderDevices();
        await within(cloudRow()).findByText(subtitle(shown));
        await run(`cloudSettings.instance.${action}`);
        await within(cloudRow()).findByText(subtitle(under));
        await act(async () => fail(new Error('timeout')));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2_000);
        });
        await within(cloudRow()).findByText(subtitle(shown));
        expect(within(cloudRow()).queryByText(subtitle(under))).toBeNull();
        expect(within(cloudRow()).getByText(`cloudSettings.instance.${action}NotTaken`)).toBeTruthy();
        expect(within(cloudRow()).getByRole('button', { name: 'commonUi.retry' })).toBeTruthy();
        expect(api.instancePower).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );
});

describe('claiming another cloud Cindy and refusals on the card', () => {
  const cloudRow = () => row(CLOUD);
  it('offers another one below the limit, asks first, and signs in the new one', async () => {
    api.instanceList!.mockResolvedValue([view(CLOUD)]);
    api.instanceCapacity = vi.fn().mockResolvedValue({ limit: 2, used: 1 });
    const added = view(PENDING, { loginRequired: true, ready: false, runtimeState: 'starting', nameSequence: 2 });
    api.instanceClaim!.mockResolvedValue([view(CLOUD), added]);
    renderDevices();
    const claim = await screen.findByRole('button', { name: 'cloudSettings.onboarding.claimAnother' });
    expect(screen.getByText('cloudSettings.onboarding.capacity 1 2')).toBeTruthy();
    // Declined: nothing is claimed.
    fireEvent.click(claim);
    await waitFor(() => expect(mock.confirm).toHaveBeenCalledTimes(1));
    expect(api.instanceClaim).not.toHaveBeenCalled();
    mock.confirm.mockResolvedValue(true);
    fireEvent.click(claim);
    await waitFor(() => expect(api.instanceClaim).toHaveBeenCalledExactlyOnceWith({ another: true }));
    expect(mock.confirm).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'cloudSettings.onboarding.claimAnotherTitle' }),
    );
    // The new one waits for its sign-in, which opens on its own.
    const login = (window as unknown as { electronAPI: { cloudLoginWindow: { open: ReturnType<typeof vi.fn> } } })
      .electronAPI.cloudLoginWindow.open;
    await waitFor(() => expect(login).toHaveBeenCalledWith({ deviceId: PENDING }));
  });

  it('offers no further one at the limit or when CIS does not say', async () => {
    api.instanceList!.mockResolvedValue([view(CLOUD)]);
    api.instanceCapacity = vi.fn().mockResolvedValue({ limit: 1, used: 1 });
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    expect(screen.queryByRole('button', { name: 'cloudSettings.onboarding.claimAnother' })).toBeNull();
    cleanup();
    api.instanceCapacity = vi.fn().mockResolvedValue(null);
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.running$/, {}, FIRST_LOAD);
    expect(screen.queryByRole('button', { name: 'cloudSettings.onboarding.claimAnother' })).toBeNull();
  });

  it('says why CIS refused a wake, without a retry or a read-back', async () => {
    api.instanceList!.mockResolvedValue([view(CLOUD, { desiredState: 'stopped', runtimeState: 'stopped', ready: false })]);
    api.instancePower!.mockRejectedValue(
      Error("Error invoking remote method 'cloud-settings:instance-power': Error: [CLOUD_SETTINGS_INSTANCE_TRANSFERRED] CLOUD_SETTINGS_INSTANCE_TRANSFERRED"),
    );
    renderDevices();
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.asleep$/);
    await run('cloudSettings.instance.wake');
    expect((await within(cloudRow()).findByRole('alert')).textContent).toBe(
      'cloudSettings.refusal.CLOUD_SETTINGS_INSTANCE_TRANSFERRED',
    );
    expect(within(cloudRow()).queryByRole('button', { name: 'commonUi.retry' })).toBeNull();
    // Nothing changed: the card shows the state CIS lists, not one under way.
    await within(cloudRow()).findByText(/· cloudSettings\.instance\.state\.asleep$/);
    expect(api.instancePower).toHaveBeenCalledTimes(1);
  });
});
