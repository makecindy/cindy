// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { CloudInstanceSection } from '../CloudInstanceSection';
import { CloudSettingsPanel } from '../CloudSettingsView';
import { CLOUD_SETTINGS_ALL_SECTIONS } from '../cloudSettingsVisibility';
import { createTrialCloudSettingsClient } from '../trialClient';
import type {
  CloudInstanceView,
  CloudMaintenanceCalendar,
  CloudMaintenanceEdit,
  CloudUpgradeOperation,
} from '../../../../shared/cloudInstanceControl';
import zhCNCommon from '@/i18n/locales/zh-CN/common.json';
import zhTWCommon from '@/i18n/locales/zh-TW/common.json';
import enCommon from '@/i18n/locales/en/common.json';
import jaCommon from '@/i18n/locales/ja/common.json';
import koCommon from '@/i18n/locales/ko/common.json';
import zhCNCloud from '@/i18n/locales/zh-CN/cloud.json';
import zhTWCloud from '@/i18n/locales/zh-TW/cloud.json';
import enCloud from '@/i18n/locales/en/cloud.json';
import jaCloud from '@/i18n/locales/ja/cloud.json';
import koCloud from '@/i18n/locales/ko/cloud.json';
import { mergeCloudStrings } from '@/i18n/cloudStrings';
const mock = vi.hoisted(() => ({
  confirm: vi.fn<(input: { title?: string; description?: string }) => Promise<boolean>>().mockResolvedValue(true),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => mock }));
// Save and request outcomes are toasts, as the local About page and auto-update switch.
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(), dismissAll: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast: toasts }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: vi.fn() }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: vi.fn(),
}));
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mock.confirm.mockResolvedValue(true);
});
// The common namespace as the app loads it: common.json plus the cloud copy. Only the
// cloud copy is typed; the common catalog is far too large to type-check as an intersection.
const withCloud = <B extends object>(common: object, cloud: B) =>
  mergeCloudStrings(common as Record<string, unknown>, cloud as Record<string, unknown>) as B;
const zhCN = withCloud(zhCNCommon, zhCNCloud);
const zhTW = withCloud(zhTWCommon, zhTWCloud);
const en = withCloud(enCommon, enCloud);
const ja = withCloud(jaCommon, jaCloud);
const ko = withCloud(koCommon, koCloud);
const resources = { 'zh-CN': zhCN, 'zh-TW': zhTW, en, ja, ko };
const DEFAULT_EFFECTIVE = {
  source: 'inherit' as const,
  calendar: {
    timezone: 'Asia/Shanghai',
    windows: [{ id: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '03:00', endLocal: '05:00' }],
  },
};
/** Waits for the automatic save in flight to finish (its toast, or its failure toast). */
const saved = (count = 1) =>
  waitFor(() => expect(toasts.success.mock.calls.length + toasts.error.mock.calls.length).toBe(count));
async function setup({
  running = false,
  language = 'zh-CN',
  panel = false,
  /** A saved custom schedule; the default otherwise. */
  calendar = undefined as CloudMaintenanceCalendar | undefined,
  revision = false,
  focusMaintenance = false,
  manualUpgrade = false,
  version = '0.1.108',
  latestVersion = '0.1.108',
} = {}) {
  const i18n = createInstance();
  await i18n.init({
    lng: language,
    fallbackLng: false,
    resources: Object.fromEntries(
      Object.entries(resources).map(([k, translation]) => [k, { translation }]),
    ),
  });
  const value: CloudInstanceView = {
    instanceId: 'instance-a',
    deviceId: 'cloud-a',
    name: 'Cloud A',
    nameSequence: 1,
    ordinal: null,
    desiredState: running ? 'running' : 'stopped',
    runtimeState: running ? 'running' : 'stopped',
    ready: running,
    version,
    manualUpgrade,
    imageId: 'a'.repeat(64),
    latestVersion,
    updateAvailable: revision,
    upgradeState: 'idle',
    observedAtMs: 100,
    maintenance: {
      instanceId: 'instance-a',
      revision: 'a'.repeat(64),
      defaultsRevision: 1,
      autoUpdate: true,
      raw: {
        policyMode: calendar ? 'custom' : 'inherit',
        calendar: calendar ?? null,
        scheduledTaskPolicy: 'protect',
        pausedUntilMs: null,
      },
      effective: calendar ? { source: 'custom', calendar } : DEFAULT_EFFECTIVE,
      executionMode: 'scheduled',
      nextEligibleAtMs: 10000,
      serverTimeMs: 100,
      windows: [],
    },
  };
  const client = Object.assign(createTrialCloudSettingsClient(), {
    instance: vi.fn(async () => structuredClone(value)),
    upgrade: vi.fn<() => Promise<CloudUpgradeOperation>>().mockImplementation(async () => {
      value.upgradeOperation = {
        operationId: 'user-example',
        phase: 'requested',
        active: true,
        updatedAtMs: 123,
      };
      return value.upgradeOperation;
    }),
    power: vi.fn<(action: 'wake' | 'sleep') => Promise<void>>().mockResolvedValue(undefined),
    // The instance keeps what was saved, on a new revision each time (b…, c…, …).
    maintenance: vi.fn(async (change: CloudMaintenanceEdit) => {
      const before = value.maintenance!;
      const custom = change.policyMode === 'custom';
      value.maintenance = {
        ...before,
        autoUpdate: change.autoUpdate,
        revision: String.fromCharCode(before.revision.charCodeAt(0) + 1).repeat(64),
        raw: { ...before.raw, policyMode: change.policyMode, calendar: custom ? change.calendar : null },
        effective: custom ? { source: 'custom', calendar: change.calendar } : DEFAULT_EFFECTIVE,
      };
      return structuredClone(value.maintenance);
    }),
  });
  const connect = vi.spyOn(client, 'connect'),
    changed = vi.fn();
  const tree = (active = true) => (
    <I18nextProvider i18n={i18n}>
      {panel ? (
        <CloudSettingsPanel
          client={client}
          name="Cloud A"
          online={false}
          onBack={vi.fn()}
          visibility={CLOUD_SETTINGS_ALL_SECTIONS}
        />
      ) : (
        <CloudInstanceSection
          client={client}
          name="Cloud A"
          active={active}
          changed={changed}
          focusMaintenance={focusMaintenance}
        />
      )}
    </I18nextProvider>
  );
  const rendered = render(tree());
  await screen.findByText(version);
  return { client, value, connect, changed, i18n, ...rendered, tree };
}
it('shows overview and explicit wake while offline without opening runtime settings', async () => {
  const f = await setup({ panel: true });
  expect(screen.getByRole('tab', { name: '云端 Cindy' }).getAttribute('aria-selected')).toBe('true');
  expect(f.connect).not.toHaveBeenCalled();
  expect(f.client.power).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '唤醒' }));
  await waitFor(() => expect(f.client.power).toHaveBeenCalledWith('wake'));
});
it('canceling sleep sends no write', async () => {
  mock.confirm.mockResolvedValueOnce(false);
  const f = await setup({ running: true });
  fireEvent.click(screen.getByRole('button', { name: '休眠' }));
  await waitFor(() => expect(mock.confirm).toHaveBeenCalled());
  expect(f.client.power).not.toHaveBeenCalled();
  expect(mock.confirm.mock.calls[0][0].title).toContain('Cloud A');
});
it('sleep requires confirmation and double clicks send only one request', async () => {
  const f = await setup({ running: true });
  let finish!: () => void;
  f.client.power.mockImplementationOnce(
    () =>
      new Promise((r) => {
        finish = r;
      }),
  );
  const button = screen.getByRole('button', { name: '休眠' });
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(f.client.power).toHaveBeenCalledTimes(1));
  expect(mock.confirm).toHaveBeenCalledTimes(1);
  finish();
  await screen.findByText('正在进入休眠…');
});
// An unknown sleep or wake is read back from the instance, never sent again.
it('reads an uncertain power request back and never resubmits it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const f = await setup();
    f.client.power.mockRejectedValueOnce(Error('network'));
    fireEvent.click(screen.getByRole('button', { name: '唤醒' }));
    await waitFor(() => expect(f.client.power).toHaveBeenCalledTimes(1));
    // While it is read back the button only spins; another click sends nothing.
    fireEvent.click(screen.getByRole('button', { name: '唤醒' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    // The instance is still asleep: the wake did not arrive, and it says so.
    await screen.findByText(zhCN.cloudSettings.instance.wakeNotTaken);
    expect(f.client.power).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});
// The switch saves as it changes, with the local switch's toast.
it('saves auto update as it changes, without waking the instance', async () => {
  const f = await setup();
  fireEvent.click(screen.getByRole('switch', { name: '自动更新' }));
  await saved();
  expect(f.client.maintenance).toHaveBeenCalledExactlyOnceWith({
    revision: 'a'.repeat(64),
    defaultsRevision: 1,
    autoUpdate: false,
    policyMode: 'inherit',
  });
  expect(toasts.success).toHaveBeenCalledWith(zhCN.cloudSettings.instance.autoUpdateOffToast);
  expect(f.client.power).not.toHaveBeenCalled();
});
it('a save that meets a newer revision shows what the instance holds, never overwrites it', async () => {
  const f = await setup();
  f.client.maintenance.mockRejectedValueOnce(Error('CLOUD_SETTINGS_CONFLICT'));
  fireEvent.click(screen.getByRole('switch'));
  await saved();
  expect(toasts.error.mock.calls[0]![0]).toBe(zhCN.cloudSettings.instance.policyChanged);
  // The instance still has auto update on: that is shown, and nothing is written again.
  await waitFor(() => expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('true'));
  expect(f.client.maintenance).toHaveBeenCalledTimes(1);
});
// One dropdown for the update hours, the default or every day for two
// hours from a whole hour in this computer's time zone. A custom schedule it cannot show stays as
// it was until another choice is saved.
const SHANGHAI = Intl.DateTimeFormat().resolvedOptions();
beforeEach(() => {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
    ...SHANGHAI,
    timeZone: 'Asia/Shanghai',
  });
  Element.prototype.scrollIntoView = vi.fn();
  Element.prototype.hasPointerCapture = vi.fn(() => false);
  Element.prototype.releasePointerCapture = vi.fn();
});
const daily = (start: string, end: string, timezone = 'Asia/Shanghai'): CloudMaintenanceCalendar => ({
  timezone,
  windows: [{ id: 'w1', weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: start, endLocal: end }],
});
const COMPLEX: CloudMaintenanceCalendar = {
  timezone: 'Asia/Shanghai',
  windows: [
    { id: 'workdays', weekdays: [1, 2, 3, 4, 5], startLocal: '01:00', endLocal: '03:00' },
    { id: 'weekend', weekdays: [6, 7], startLocal: '13:00', endLocal: '15:00' },
  ],
};
const schedule = () => screen.getByRole('combobox', { name: '更新时段' });
const openSchedule = () => {
  fireEvent.keyDown(schedule(), { key: 'ArrowDown' });
  return screen.getAllByRole('option');
};
const pick = (name: string) => {
  const option = openSchedule().find((item) => item.textContent === name)!;
  option.focus();
  fireEvent.keyDown(option, { key: 'Enter' });
};
it('offers the default and the other 23 daily two-hour windows in this computer\'s time zone', async () => {
  await setup();
  expect(schedule().textContent).toBe('每天 03:00–05:00（默认）');
  // In this computer's time zone it goes unsaid, as local schedules do.
  expect(screen.queryByText(/时区/)).toBeNull();
  const options = openSchedule().map((option) => option.textContent);
  // The default is not offered a second time as a plain daily window.
  expect(options).toHaveLength(24);
  expect(options.filter((option) => option?.startsWith('每天 03:00–05:00'))).toEqual(['每天 03:00–05:00（默认）']);
  expect(options.slice(0, 5)).toEqual([
    '每天 03:00–05:00（默认）',
    '每天 00:00–02:00',
    '每天 01:00–03:00',
    '每天 02:00–04:00',
    '每天 04:00–06:00',
  ]);
  expect(options.at(-1)).toBe('每天 23:00–01:00');
});
// A custom schedule that is the default shows as the default and stays custom unless the user
// chooses the default again after another option.
it('shows a saved custom schedule equal to the default as the default, without rewriting it', async () => {
  const calendar = daily('03:00', '05:00');
  const f = await setup({ calendar });
  expect(schedule().textContent).toBe('每天 03:00–05:00（默认）');
  expect(f.client.maintenance).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('switch', { name: '自动更新' }));
  await waitFor(() =>
    expect(f.client.maintenance).toHaveBeenCalledWith({
      revision: 'a'.repeat(64),
      defaultsRevision: 1,
      autoUpdate: false,
      policyMode: 'custom',
      calendar,
    }),
  );
});
it('follows the default once the default is chosen again after another option', async () => {
  const f = await setup({ calendar: daily('03:00', '05:00') });
  pick('每天 04:00–06:00');
  await saved();
  pick('每天 03:00–05:00（默认）');
  await saved(2);
  await waitFor(() =>
    expect(f.client.maintenance).toHaveBeenLastCalledWith({
      revision: 'b'.repeat(64),
      defaultsRevision: 1,
      autoUpdate: true,
      policyMode: 'inherit',
    }),
  );
});
it('saves a daily two-hour window in this computer\'s time zone, as a custom schedule was saved', async () => {
  const f = await setup();
  pick('每天 22:00–00:00');
  await waitFor(() =>
    expect(f.client.maintenance).toHaveBeenCalledWith({
      revision: 'a'.repeat(64),
      defaultsRevision: 1,
      autoUpdate: true,
      policyMode: 'custom',
      calendar: {
        timezone: 'Asia/Shanghai',
        windows: [
          { id: 'daily', weekdays: [1, 2, 3, 4, 5, 6, 7], startLocal: '22:00', endLocal: '00:00' },
        ],
      },
    }),
  );
});
it('shows a saved daily window as its option and saves the default as following it', async () => {
  const f = await setup({ calendar: daily('01:00', '03:00') });
  expect(schedule().textContent).toBe('每天 01:00–03:00');
  // CIS gives the default only while the instance follows it.
  expect(openSchedule()[0]!.textContent).toBe('每天 03:00–05:00（默认）');
  fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
  pick('每天 03:00–05:00（默认）');
  await waitFor(() =>
    expect(f.client.maintenance).toHaveBeenCalledWith({
      revision: 'a'.repeat(64),
      defaultsRevision: 1,
      autoUpdate: true,
      policyMode: 'inherit',
    }),
  );
});
it.each([
  ['several windows', COMPLEX, '当前：自定义的多个时段', '工作日 01:00–03:00，周末 13:00–15:00（上海，UTC+8）'],
  ['another time zone', daily('01:00', '03:00', 'Asia/Tokyo'), '当前：自定义时段', '每天 01:00–03:00（东京，UTC+9）'],
  ['a half hour', daily('02:30', '04:30'), '当前：自定义时段', '每天 02:30–04:30（上海，UTC+8）'],
  ['three hours', daily('02:00', '05:00'), '当前：自定义时段', '每天 02:00–05:00（上海，UTC+8）'],
])('keeps a custom schedule it cannot show (%s) until another choice replaces it', async (_label, calendar, current, kept) => {
  const f = await setup({ calendar });
  expect(schedule().textContent).toBe(current);
  expect(screen.getByText(`自定义时段：${kept}`)).toBeTruthy();
  expect(f.client.maintenance).not.toHaveBeenCalled();
  // Saving another setting leaves the schedule exactly as it was.
  fireEvent.click(screen.getByRole('switch', { name: '自动更新' }));
  await saved();
  expect(f.client.maintenance).toHaveBeenCalledExactlyOnceWith({
    revision: 'a'.repeat(64),
    defaultsRevision: 1,
    autoUpdate: false,
    policyMode: 'custom',
    calendar,
  });
  // Another choice asks before replacing it; declined, nothing is saved and it stays.
  mock.confirm.mockResolvedValueOnce(false);
  pick('每天 04:00–06:00');
  await waitFor(() => expect(mock.confirm).toHaveBeenCalledOnce());
  expect(mock.confirm.mock.calls[0]![0].title).toBe(zhCN.cloudSettings.instance.replaceTitle);
  expect(f.client.maintenance).toHaveBeenCalledTimes(1);
  expect(schedule().textContent).toBe(current);
});
it('distinguishes a cloud revision from an identical version number', async () => {
  await setup({ revision: true });
  expect(screen.getByText(zhCN.cloudSettings.instance.revisionAvailable)).toBeTruthy();
  expect(screen.queryByText('暂无')).toBeNull();
});
it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])(
  'renders management controls in %s without untranslated keys',
  async (language) => {
    await setup({ language, calendar: COMPLEX });
    const strings = resources[language as keyof typeof resources].cloudSettings.instance;
    expect(screen.getByRole('button', { name: strings.wake })).toBeTruthy();
    expect(screen.getByRole('switch', { name: strings.autoUpdate })).toBeTruthy();
    fireEvent.keyDown(screen.getByRole('combobox', { name: strings.schedule }), { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')).toHaveLength(25);
    expect(document.body.textContent).not.toContain('cloudSettings.');
  },
);

it('maintenance shortcut scrolls to the policy after loading, without changing it', async () => {
  const scroll = vi.fn();
  const original = HTMLElement.prototype.scrollIntoView;
  HTMLElement.prototype.scrollIntoView = scroll;
  try {
    const f = await setup({ focusMaintenance: true });
    await waitFor(() => expect(scroll).toHaveBeenCalledOnce());
    expect((scroll.mock.contexts[0] as HTMLElement).id).toBe('cloud-instance-maintenance');
    expect(f.client.maintenance).not.toHaveBeenCalled();
    expect(f.client.power).not.toHaveBeenCalled();
  } finally {
    HTMLElement.prototype.scrollIntoView = original;
  }
});

// The upgrade asks first, once, even for a double click.
it('requests an upgrade with auto-update disabled and preserves schedules after one confirmation', async () => {
  const f = await setup({
    running: true,
    revision: true,
    manualUpgrade: true,
    version: '0.1.108-cloud.2-cn-amd64',
    latestVersion: '0.1.108-cloud.10-cn-amd64',
  });
  f.value.maintenance!.autoUpdate = false;
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await waitFor(() =>
    expect(screen.getByRole('switch').getAttribute('aria-checked')).toBe('false'),
  );
  expect(screen.getByText('0.1.108-cloud.10-cn-amd64')).toBeTruthy();
  const button = screen.getByRole('button', { name: zhCN.cloudSettings.instance.upgradeNow });
  fireEvent.click(button);
  fireEvent.click(button);
  await screen.findByText(zhCN.cloudSettings.instance.upgradeQueued);
  expect(f.client.upgrade).toHaveBeenCalledOnce();
  expect(f.client.power).not.toHaveBeenCalled();
  expect(f.client.maintenance).not.toHaveBeenCalled();
  expect(mock.confirm).toHaveBeenCalledOnce();
  expect(mock.confirm.mock.calls[0][0].title).toBe('更新“Cloud A”？');
  expect(screen.getByRole('button', { name: '休眠' }).hasAttribute('disabled')).toBe(true);
});
it.each(['stopped', 'no-release', 'old-server', 'held', 'resource-change'])(
  'cannot submit an upgrade while %s',
  async (kind) => {
    const f = await setup({
      running: kind !== 'stopped',
      revision: kind !== 'no-release',
      manualUpgrade: kind !== 'old-server',
    });
    if (kind === 'held' || kind === 'resource-change') {
      if (kind === 'held')
        f.value.upgradeOperation = {
          operationId: 'user-held',
          phase: 'recovery-hold',
          active: true,
          updatedAtMs: 100,
        };
      else f.value.resourceChanging = true;
      fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
      await waitFor(() =>
        expect(screen.getByRole('button', { name: '休眠' }).hasAttribute('disabled')).toBe(true),
      );
    }
    const button = screen.queryByRole('button', { name: zhCN.cloudSettings.instance.upgradeNow });
    if (kind === 'stopped') expect(button).not.toBeNull();
    if (button) {
      expect(button.hasAttribute('disabled')).toBe(true);
      fireEvent.click(button);
    }
    expect(f.client.upgrade).not.toHaveBeenCalled();
  },
);
it('does not resubmit an uncertain request and recovers persisted progress on explicit refresh', async () => {
  const f = await setup({ running: true, revision: true, manualUpgrade: true });
  f.client.upgrade.mockRejectedValueOnce(Error('CLOUD_SETTINGS_SAVE_UNCONFIRMED'));
  fireEvent.click(screen.getByRole('button', { name: zhCN.cloudSettings.instance.upgradeNow }));
  // The result is read back: the button only spins, and another click sends nothing.
  await waitFor(() => expect(screen.getByRole('button', { name: zhCN.cloudSettings.instance.upgradeNow }).hasAttribute('disabled')).toBe(true));
  fireEvent.click(screen.getByRole('button', { name: zhCN.cloudSettings.instance.upgradeNow }));
  expect(f.client.upgrade).toHaveBeenCalledOnce();
  f.value.upgradeOperation = {
    operationId: 'user-example',
    phase: 'backup-running',
    active: true,
    updatedAtMs: 200,
  };
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await screen.findByText(zhCN.cloudSettings.instance.state.upgrading);
  expect(screen.queryByRole('alert')).toBeNull();
  f.value.upgradeOperation = {
    ...f.value.upgradeOperation,
    phase: 'completed',
    active: false,
    updatedAtMs: Date.now(),
  };
  f.value.version = '0.1.108-cloud.10-cn-amd64';
  f.value.latestVersion = null;
  f.value.updateAvailable = false;
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await screen.findByText('已更新到 0.1.108-cloud.10-cn-amd64');
  expect(screen.getByText('0.1.108-cloud.10-cn-amd64')).toBeTruthy();
  expect(screen.getByText('暂无')).toBeTruthy();
  // No inert upgrade button when there is nothing to install.
  expect(screen.queryByRole('button', { name: zhCN.cloudSettings.instance.upgradeNow })).toBeNull();
});
it('stops showing an upgrade that ended long ago, but keeps a held one', async () => {
  const f = await setup({ running: true, manualUpgrade: true });
  f.value.upgradeOperation = {
    operationId: 'user-old',
    phase: 'completed',
    active: false,
    updatedAtMs: Date.now() - 31 * 60_000,
  };
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await waitFor(() => expect(f.client.instance).toHaveBeenCalledTimes(2));
  expect(screen.queryByText(/已更新到/)).toBeNull();
  expect(screen.queryByRole('status')).toBeNull();
  f.value.upgradeOperation = { ...f.value.upgradeOperation, phase: 'recovery-hold' };
  fireEvent.click(screen.getByRole('button', { name: '刷新状态' }));
  await screen.findByRole('status');
});
it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])(
  'localizes the immediate upgrade action and queue in %s',
  async (language) => {
    const f = await setup({ running: true, revision: true, manualUpgrade: true, language });
    const strings = resources[language as keyof typeof resources].cloudSettings.instance;
    fireEvent.click(screen.getByRole('button', { name: strings.upgradeNow }));
    await screen.findByText(strings.upgradeQueued);
    expect(document.body.textContent).not.toContain('cloudSettings.');
    expect(f.client.upgrade).toHaveBeenCalledOnce();
  },
);
