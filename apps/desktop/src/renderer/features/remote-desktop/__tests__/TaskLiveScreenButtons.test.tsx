// @vitest-environment jsdom
// 测试价值：通过真实入口保护「远程任务的模拟器在电脑上一键打开」——只列出那台电脑绑定到
// 当前任务、正在运行的设备，点开时把设备交给查看窗口；旧版电脑（不支持设备画面）不发列表请求、
// 不出现入口。此前只有手机任务页有这个入口。最小输入：一台在线可远控的电脑与一份设备列表；
// unit tier，单独约 3 秒。
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { REMOTE_DESKTOP_CHANNEL } from '@cindy/device-link';
import i18n from '@/i18n';
import { revokedDevicesStore } from '@/features/device-link/revokedDevicesStore';
import { unresponsiveDevicesStore } from '@/features/device-link/unresponsiveDevicesStore';
import { TaskLiveScreenButtons } from '../TaskLiveScreenButtons';
import { useTaskLiveScreens } from '../useTaskLiveScreens';

const fixture = vi.hoisted(() => ({ devices: [] as DeviceLinkDeviceView[] }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => fixture.devices,
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), info: vi.fn() } }));

const invoke = vi.fn();
const open = vi.fn();
const listed = (id: string, name: string, taskIds: string[], state = 'running') => ({
  plugin: 'cindy-simulator',
  pluginName: 'Device Simulator',
  id,
  name,
  platform: 'ios',
  state,
  taskIds,
});
function Entries() {
  const screens = useTaskLiveScreens('remote', 'task-1');
  return <TaskLiveScreenButtons deviceId="remote" screens={screens} />;
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
  open.mockReset().mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { deviceLink: { invoke }, openRemoteDesktop: open } });
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

it('offers the running devices of this task and opens one as a device screen', async () => {
  invoke.mockImplementation(
    async (_device: string, _channel: string, [request]: [{ op: string }]) =>
      request.op === 'capabilities'
        ? { version: 1, enabled: true, liveScreens: true }
        : {
            screens: [
              listed('sim-a', 'iPhone Air', ['task-1']),
              listed('sim-b', 'Other task', ['task-2']),
              listed('sim-c', 'Shut down', ['task-1'], 'off'),
              { plugin: 'bad plugin', id: 'x' },
            ],
          },
  );
  render(<Entries />);
  await settle();
  await settle();
  expect(invoke).toHaveBeenCalledWith('remote', REMOTE_DESKTOP_CHANNEL, [{ op: 'screens' }]);
  const buttons = screen.getAllByRole('button');
  expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
    'Device screen · iPhone Air',
  ]);
  fireEvent.click(buttons[0]);
  expect(open).toHaveBeenCalledExactlyOnceWith({
    deviceId: 'remote',
    name: 'Remote computer',
    screen: { plugin: 'cindy-simulator', id: 'sim-a', name: 'iPhone Air' },
  });
  await settle();
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
});
