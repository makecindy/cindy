// @vitest-environment jsdom
// 测试价值：通过真实入口保护「远程任务的设备（模拟器）在电脑上由同一个插件自己的任务页显示」——只认
// 那台电脑绑定到当前任务、正在运行的设备；本机装着同一个插件时设备出现就自动打开它的任务页一次（之后
// 不反复弹出），入口可再次打开；本机没装、没开启或版本太旧时不打开任何页面，而是提示并带用户去安装 /
// 开启 / 更新；旧版电脑（不支持设备画面）不发列表请求、不出现入口。此前设备画面由宿主自己画，没有
// 「需要插件」这条路径。最小输入：一台在线可远控的电脑、一份设备列表与本机已装插件；unit tier，单独约 3 秒。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CHANNEL } from '@cindy/device-link';
import i18n from '@/i18n';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import {
  resetAutoOpenedTaskLiveScreens,
  TaskLiveScreenButtons,
  taskLiveScreenEntries,
  useAutoOpenTaskLiveScreens,
} from '../TaskLiveScreenButtons';
import { useTaskLiveScreens } from '../useTaskLiveScreens';
import { ConfirmDialogProvider } from '@/components/ui/confirm-dialog-provider';
import { installedGhostStoragePart } from '../../../../shared/pluginIdentity';

const fixture = vi.hoisted(() => ({ devices: [] as DeviceLinkDeviceView[] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => fixture.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));
const openTab = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('@/features/right-sidebar/lib/openPluginTaskTab', () => ({ openPluginTaskTab: openTab }));
const installed = vi.hoisted(() => ({ ghosts: [] as unknown[] }));
vi.mock('@/cindy-brain/useInstalledGhosts', () => ({ useInstalledGhosts: () => installed.ghosts }));
const lookup = vi.hoisted(() => vi.fn());
const navigate = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
const notices = vi.hoisted(() => vi.fn());
vi.mock('@/lib/toast', () => ({ toast: { info: notices } }));

const invoke = vi.fn();
const listed = (id: string, name: string, taskIds: string[], state = 'running') => ({
  plugin: '_root__cindy-simulator',
  pluginIdentity: '_root__cindy-simulator',
  pluginName: 'Device Simulator',
  id,
  name,
  platform: 'ios',
  state,
  taskIds,
});
/** The same plugin installed on this computer, by default able to show another computer's device. */
const plugin = (patch: { enabled?: boolean; remote?: boolean } = {}) => ({
  dir: '/plugins/_ns/_root/cindy-simulator',
  namespace: null,
  namespaceState: 'confirmed',
  enabled: patch.enabled !== false,
  manifest: {
    id: 'cindy-simulator',
    name: 'Device Simulator',
    taskView: { html: 'task.html', ...(patch.remote === false ? {} : { remote: true }) },
  },
});
function Entries() {
  const screens = useTaskLiveScreens('remote', 'task-1');
  const entries = useAutoOpenTaskLiveScreens('task-1', screens);
  return (
    <ConfirmDialogProvider>
      <TaskLiveScreenButtons sessionId="task-1" entries={entries} />
    </ConfirmDialogProvider>
  );
}
const settle = () => act(async () => void (await Promise.resolve()));

beforeEach(async () => {
  revokedDevicesStore.clearAll();
  unresponsiveDevicesStore.clearAll();
  fixture.devices = [
    {
      deviceId: 'remote',
      name: 'Remote computer',
      platform: 'darwin',
      appVersion: '1',
      lastSeenAt: null,
      online: true,
      busy: true,
      remoteControlEnabled: true,
      controlEnabled: true,
      isSelf: false,
    },
  ];
  invoke.mockReset();
  openTab.mockClear();
  navigate.mockClear();
  notices.mockClear();
  lookup.mockReset();
  lookup.mockResolvedValue({ items: [{ pluginId: 'cindy-simulator', ghostId: 'cindy-simulator', namespace: null, installState: 'not-installed' }] });
  installed.ghosts = [plugin()];
  resetAutoOpenedTaskLiveScreens();
  Object.assign(window, { electronAPI: { deviceLink: { invoke }, pluginMarket: { lookup } } });
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  await i18n.changeLanguage('en');
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it('reads the list only while this window is in front, and again when the user returns', async () => {
  invoke.mockResolvedValue({ version: 1, enabled: true, liveScreens: true });
  const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(false);
  render(<Entries />);
  await settle();
  // Every read makes the other computer ask its plugins: a background window stays quiet.
  expect(invoke).not.toHaveBeenCalled();
  focused.mockReturnValue(true);
  vi.useFakeTimers();
  try {
    window.dispatchEvent(new Event('focus'));
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(invoke).toHaveBeenLastCalledWith('remote', REMOTE_DESKTOP_CHANNEL, [{ op: 'screens' }]);
  } finally {
    vi.useRealTimers();
  }
});

it('opens the plugin’s own task page when a device of this task appears, once, and again from its entry', async () => {
  let screens = [
    listed('sim-a', 'iPhone Air', ['task-1']),
    listed('sim-b', 'Other task', ['task-2']),
    listed('sim-c', 'Shut down', ['task-1'], 'off'),
    { plugin: 'bad plugin', id: 'x' },
  ];
  invoke.mockImplementation(
    async (_device: string, _channel: string, [request]: [{ op: string }]) =>
      request.op === 'capabilities'
        ? { version: 1, enabled: true, liveScreens: true }
        : { screens },
  );
  vi.useFakeTimers();
  try {
    render(<Entries />);
    await act(async () => void (await vi.advanceTimersByTimeAsync(0)));
    expect(invoke).toHaveBeenCalledWith('remote', REMOTE_DESKTOP_CHANNEL, [{ op: 'screens' }]);
    const instance = installedGhostStoragePart(plugin() as never);
    expect(instance).toBe('_root__cindy-simulator');
    // The device appeared: the plugin's task page opens by itself, without claiming a user gesture.
    expect(openTab).toHaveBeenCalledExactlyOnceWith('task-1', instance, { userInitiated: false });
    expect(notices).not.toHaveBeenCalled();
    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Device Simulator · iPhone Air',
    ]);
    // The same device on later reads does not open again (the user may have closed the tab).
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(openTab).toHaveBeenCalledTimes(1);
    fireEvent.click(buttons[0]);
    expect(openTab).toHaveBeenLastCalledWith('task-1', instance);
    // Shut down and started again: a new appearance.
    screens = [];
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(screen.queryByRole('button')).toBeNull();
    screens = [listed('sim-a', 'iPhone Air', ['task-1'])];
    await act(async () => void (await vi.advanceTimersByTimeAsync(15_000)));
    expect(openTab).toHaveBeenCalledTimes(3);
    expect(openTab).toHaveBeenLastCalledWith('task-1', instance, { userInitiated: false });
  } finally {
    vi.useRealTimers();
  }
});

it('shows no entry and asks for no list on a computer without device screens', async () => {
  invoke.mockResolvedValue({ version: 1, enabled: true });
  render(<Entries />);
  await settle();
  await settle();
  expect(invoke).toHaveBeenCalledExactlyOnceWith('remote', REMOTE_DESKTOP_CHANNEL, [
    { op: 'capabilities' },
  ]);
  expect(screen.queryByRole('button')).toBeNull();
  expect(openTab).not.toHaveBeenCalled();
});

it('asks for the plugin instead of opening anything when this computer cannot show the device', async () => {
  invoke.mockImplementation(
    async (_device: string, _channel: string, [request]: [{ op: string }]) =>
      request.op === 'capabilities'
        ? { version: 1, enabled: true, liveScreens: true }
        : { screens: [listed('sim-a', 'iPhone Air', ['task-1'])] },
  );
  installed.ghosts = [];
  const view = render(<Entries />);
  await settle();
  await settle();
  // Not installed here: a notice says what is needed, once, and leads to the plugin.
  expect(openTab).not.toHaveBeenCalled();
  expect(notices).toHaveBeenCalledExactlyOnceWith(
    expect.stringContaining('Install the “Device Simulator” plugin on this computer'),
    expect.objectContaining({
      title: 'Install the “Device Simulator” plugin',
      action: expect.objectContaining({ label: 'Install' }),
    }),
  );
  // The entry explains the same and goes there only when the user agrees.
  fireEvent.click(screen.getByRole('button', { name: 'Install the “Device Simulator” plugin' }));
  await settle();
  expect(navigate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Install' }));
  await settle();
  await settle();
  expect(lookup).toHaveBeenLastCalledWith(['cindy-simulator']);
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/plugins?market=cindy-simulator');

  // Installed but turned off, or too old to show another computer's device: say which.
  installed.ghosts = [plugin({ enabled: false })];
  view.rerender(<Entries />);
  await settle();
  expect(notices).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ title: 'Enable the “Device Simulator” plugin' }),
  );
  installed.ghosts = [plugin({ remote: false })];
  view.rerender(<Entries />);
  await settle();
  expect(notices).toHaveBeenLastCalledWith(
    expect.any(String),
    expect.objectContaining({ title: 'Update the “Device Simulator” plugin' }),
  );
  expect(openTab).not.toHaveBeenCalled();
  // Once it can, the page opens without another request from the user.
  installed.ghosts = [plugin()];
  view.rerender(<Entries />);
  await settle();
  expect(openTab).toHaveBeenCalledExactlyOnceWith('task-1', '_root__cindy-simulator', {
    userInitiated: false,
  });
});

// Multiple providers are independent: one working plugin must not hide another
// plugin's setup entry. Only same-source logical identity duplicates collapse.
it('keeps every plugin entry and setup need while merging duplicate install keys', () => {
  const own = plugin();
  const a = listed('a', 'Phone', ['task-1']);
  const b = {
    ...listed('b', 'Other phone', ['task-1']),
    plugin: '_root__second',
    pluginIdentity: '_root__second',
    pluginName: 'Second',
  };
  const entries = taskLiveScreenEntries(
    [a, b, { ...a, plugin: 'cindy-simulator' }] as never,
    [own] as never,
  );
  expect(entries).toHaveLength(2);
  expect(entries[0].screens).toHaveLength(1);
  expect(entries[0].need).toBeNull();
  expect(entries[1]).toMatchObject({
    plugin: '_root__second',
    pluginIdentity: '_root__second',
    need: 'install',
  });
  expect(taskLiveScreenEntries([a, b] as never, []).map((entry) => entry.need)).toEqual([
    'install',
    'install',
  ]);
});

it('matches stamped logical source instead of the physical install name', () => {
  const stamped = { ...plugin(), namespace: 'acme', instanceKey: 'cindy-simulator' };
  const remote = [
    {
      ...listed('same', 'Org phone', ['task-1']),
      plugin: 'cindy-simulator',
      pluginIdentity: '_ns__acme__cindy-simulator',
    },
    {
      ...listed('other', 'Root phone', ['task-1']),
      plugin: '_root__cindy-simulator',
      pluginIdentity: 'cindy-simulator',
    },
  ];
  const entries = taskLiveScreenEntries(remote as never, [stamped] as never);
  expect(entries).toHaveLength(2);
  expect(entries[0]).toMatchObject({ need: null, ghost: stamped });
  expect(entries[1]).toMatchObject({ need: 'install', ghost: null });
  expect(
    taskLiveScreenEntries(
      [{ ...remote[0], pluginIdentity: undefined }] as never,
      [stamped] as never,
    ),
  ).toEqual([]);
});

// Review #4540881698: the old helper mock hid cross-source installation links.
// Unit: exercise the actual shared route through both the notice and manual entry;
// one same-name listing from another source must never become the destination.
it.each([
  { name: 'organization alongside root', identity: '_ns__acme__cindy-simulator', sources: [null, 'acme'], route: '/plugins?market=item-1' },
  { name: 'local with only root available', identity: '_ns__local__cindy-simulator', sources: [null], route: '/plugins' },
  { name: 'root with unknown legacy source', identity: 'cindy-simulator', sources: [undefined], route: '/plugins' },
  { name: 'root with explicit verified source', identity: 'cindy-simulator', sources: [null], route: '/plugins?market=item-0' },
  { name: 'ambiguous same-source listings', identity: '_ns__acme__cindy-simulator', sources: ['acme', 'acme'], route: '/plugins' },
  { name: 'no listing', identity: '_ns__acme__cindy-simulator', sources: [], route: '/plugins' },
])('routes both setup actions by verified identity: $name', async ({ identity, sources, route }) => {
  installed.ghosts = [];
  lookup.mockResolvedValue({ items: sources.map((namespace, i) => ({
    pluginId: `item-${i}`, ghostId: 'cindy-simulator', installState: 'not-installed',
    ...(namespace === undefined ? {} : { namespace }),
  })) });
  invoke.mockImplementation(async (_device: string, _channel: string, [request]: [{ op: string }]) =>
    request.op === 'capabilities'
      ? { version: 1, enabled: true, liveScreens: true }
      : { screens: [{ ...listed('sim-a', 'iPhone Air', ['task-1']), pluginIdentity: identity }] });
  render(<Entries />);
  await settle();
  await settle();
  await act(async () => notices.mock.calls[0][1].action.onClick());
  expect(navigate).toHaveBeenLastCalledWith(route);
  navigate.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Install the “Device Simulator” plugin' }));
  await settle();
  fireEvent.click(screen.getByRole('button', { name: 'Install' }));
  await settle();
  await settle();
  expect(navigate).toHaveBeenLastCalledWith(route);
});
