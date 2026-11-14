// 测试价值：设备画面嵌在应用窗口（侧边栏页签）里时，Main 仍是目标与租约的唯一持有者——
// 只接受设备画面目标（整屏远程桌面不能走这条路）、页面发出的 start 不能换设备、页面导航或
// 本机锁屏后租约必须交还。既有用例只覆盖独立查看窗口。最小输入：一个假的页面 sender；unit tier。
import { EventEmitter } from 'node:events';
import { expect, it, vi } from 'vitest';
import type { RemoteDesktopRequest } from '@cindy/device-link';
import { LIVE_SCREEN_EMBED } from '../../../shared/remoteDesktopViewer';
import { EmbeddedLiveScreens } from '../embedded';

vi.mock('electron', () => ({ BrowserWindow: { fromWebContents: () => null } }));

function fixture() {
  const sent: [string, unknown][] = [];
  const sender = Object.assign(new EventEmitter(), {
    id: 7,
    isDestroyed: () => false,
    send: (channel: string, payload: unknown) => void sent.push([channel, payload]),
  });
  const request = vi.fn(async (_device: string, message: RemoteDesktopRequest) =>
    message.op === 'capabilities'
      ? { version: 1, enabled: true, liveScreens: true, displays: [] }
      : { lease: 'lease-s', controlling: true, display: { id: 'live-screen:sim' } },
  );
  const screens = new EmbeddedLiveScreens({
    owner: () => 'account-a:1',
    available: () => true,
    selfDeviceId: () => 'this-computer',
    request,
    ice: async () => [],
  });
  return { screens, sender: sender as never, events: sender, request, sent };
}
const screen = { plugin: 'cindy-simulator', id: 'sim', name: 'iPhone' };
const target = { deviceId: 'computer-a', name: 'Computer', screen };

it('serves only the device screen a panel was opened for and returns its lease when the page goes away', async () => {
  const { screens, sender, events, request, sent } = fixture();
  // Never a whole desktop, a 代输入 window or this computer itself.
  for (const bad of [
    { deviceId: 'computer-a', name: 'Computer' },
    { ...target, handoff: 'req1' },
    { ...target, deviceId: 'this-computer' },
    { ...target, screen: { plugin: 'bad plugin', id: 'sim' } },
  ])
    expect(() => screens.open(sender, 'panel-1', bad)).toThrow();
  expect(() => screens.open(sender, 'bad id!', target)).toThrow();
  const { generation, active } = screens.open(sender, 'panel-1', target);
  expect(active).toBe(true);
  await screens.request(sender, 'panel-1', generation, { op: 'capabilities' });
  // The page cannot swap the device or drop it for the whole desktop.
  for (const start of [
    { op: 'start', displayId: '1' },
    { op: 'start', displayId: 'live-screen', screen: { plugin: screen.plugin, id: 'other' } },
  ])
    await expect(screens.request(sender, 'panel-1', generation, start)).rejects.toThrow();
  const start = {
    op: 'start',
    displayId: 'live-screen',
    screen: { plugin: screen.plugin, id: 'sim' },
  };
  await screens.request(sender, 'panel-1', generation, start);
  expect(request).toHaveBeenLastCalledWith('computer-a', start, expect.any(Function));
  // Another panel id, or another page, has no access to this lease.
  await expect(screens.request(sender, 'panel-2', generation, start)).rejects.toThrow();
  // The page navigated away: the lease goes back without waiting for anyone.
  events.emit('did-start-navigation', {}, 'https://elsewhere.test/', false, true);
  await vi.waitFor(() =>
    expect(request).toHaveBeenLastCalledWith(
      'computer-a',
      { op: 'stop', lease: 'lease-s' },
      expect.any(Function),
    ),
  );
  await expect(
    screens.request(sender, 'panel-1', generation, { op: 'heartbeat', lease: 'lease-s' }),
  ).rejects.toThrow();
  // The panel is shown again (its tab came back): the same device's previous lease is
  // given back before the next one starts, so its late stop cannot end the new lease.
  const first = screens.open(sender, 'panel-2', target);
  await screens.request(sender, 'panel-2', first.generation, { op: 'capabilities' });
  await screens.request(sender, 'panel-2', first.generation, start);
  request.mockClear();
  const second = screens.open(sender, 'panel-3', target);
  await expect(
    screens.request(sender, 'panel-2', first.generation, { op: 'heartbeat', lease: 'lease-s' }),
  ).rejects.toThrow();
  await screens.request(sender, 'panel-3', second.generation, start);
  expect(request.mock.calls.map(([, message]) => message.op)).toEqual(['stop', 'start']);
  // This computer locked (or the account changed): open panels are told they ended.
  screens.endAll();
  expect(sent.at(-1)).toEqual([
    LIVE_SCREEN_EMBED.ACTIVE,
    { embedId: 'panel-3', state: expect.objectContaining({ active: false }) },
  ]);
});
