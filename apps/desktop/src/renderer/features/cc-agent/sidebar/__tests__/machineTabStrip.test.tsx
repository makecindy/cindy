// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:MachineTabStrip(侧栏标签下的电脑行)。用户看到哪些电脑、点击 /
 *   Cmd 点击改变哪种选择、右键电脑名出现哪些远程入口及它们做什么。
 * - 规则依据:2026-11-20 用户裁决 —— 离线电脑不显示、只列当前标签有内容的电脑、选中的电脑
 *   始终保留、能切换的不足两台时整行不显示;远程桌面 / 新建项目从旧范围下拉搬到右键。
 * - 现有覆盖缺口:旧 machineSwitcherMenu 测试只读源码断言下拉形态，新电脑行没有行为覆盖。
 * - 最小失败输入:离线但有任务的电脑;没有任务的在线电脑;只有本机有任务;选中的电脑离线。
 * - tier:unit(jsdom;设备与选择 hook 用进程内 fixture)。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18n from '@/i18n';
import { MachineTabStrip } from '../MachineSwitcherMenu';

const fixture = vi.hoisted(() => ({
  selected: 'all' as 'all' | string[],
  devices: [] as { deviceId: string; name: string; status: string; online: boolean }[],
  select: vi.fn(),
  toggle: vi.fn(),
}));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({
  useMachineSwitcher: () => ({
    devices: fixture.devices,
    selectedDeviceId: fixture.selected,
    select: fixture.select,
    toggle: fixture.toggle,
    hasRemote: true,
  }),
  useRemoteSessionBootstrapLoading: () => false,
}));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [
    { deviceId: 'rog', name: 'ROG', platform: 'win32', online: true, remoteControlEnabled: true, controlEnabled: true, isSelf: false },
  ],
  useDeviceLinkDeviceListRequestState: () => ({ status: 'ready', error: null }),
}));
vi.mock('@/features/remote-desktop/useRemoteDesktopAvailability', () => ({
  useRemoteDesktopAvailability: () => ({ available: false, checking: false, reason: null, retryable: false, retry: () => {}, markUnavailable: () => {} }),
}));
vi.mock('@/hooks/useActiveMainView', () => ({ useActiveMainView: () => ({ navigateToView: vi.fn() }) }));
// 电脑行只用到云电脑入口的两个 hook;不加载完整登录上下文，控制收集耗时。
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null, useOptionalDataOwnerGeneration: () => 0 }));

const openRemoteDesktop = vi.fn();
beforeEach(async () => {
  vi.clearAllMocks();
  fixture.selected = 'all';
  fixture.devices = [
    { deviceId: 'rog', name: 'ROG', status: 'connected', online: true },
    { deviceId: 'mini', name: 'Mac mini', status: 'connected', online: true },
    { deviceId: 'studio', name: 'Mac Studio', status: 'connecting', online: false },
    { deviceId: 'old', name: 'Old PC', status: 'connected', online: true },
  ];
  openRemoteDesktop.mockResolvedValue(undefined);
  Object.assign(window, { electronAPI: { openRemoteDesktop } });
  await i18n.changeLanguage('en');
});
afterEach(cleanup);

function strip(content: string[], onCreateProject = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/cc-agent']}>
      <MachineTabStrip machinesWithContent={new Set(content)} onCreateProject={onCreateProject} />
    </MemoryRouter>,
  );
  return onCreateProject;
}
const chipNames = () =>
  screen.queryByRole('toolbar', { name: 'Computers' })
    ? [...screen.getByRole('toolbar', { name: 'Computers' }).querySelectorAll('button')].map((b) => b.textContent)
    : null;

describe('MachineTabStrip', () => {
  it.each([
    {
      about: 'lists only online computers with content in the current tab',
      selected: 'all' as const,
      content: ['local', 'rog', 'mini', 'studio'],
      chips: ['All', 'Local', 'ROG', 'Mac mini'],
    },
    {
      about: 'keeps the selected computer after it goes offline so the user can switch back',
      selected: ['studio'],
      content: ['local', 'rog', 'studio'],
      chips: ['All', 'Local', 'ROG', 'Mac Studio'],
    },
    {
      about: 'hides the row when fewer than two computers have content',
      selected: 'all' as const,
      content: ['local', 'studio'],
      chips: null,
    },
  ])('$about', ({ selected, content, chips }) => {
    fixture.selected = selected;
    strip(content);
    expect(chipNames()).toEqual(chips);
  });

  it('click selects one computer, Cmd-click toggles it into the selection', () => {
    strip(['local', 'rog', 'mini']);
    fireEvent.click(screen.getByRole('button', { name: 'ROG' }));
    expect(fixture.select).toHaveBeenCalledWith(['rog']);
    fireEvent.click(screen.getByRole('button', { name: 'Mac mini' }), { metaKey: true });
    expect(fixture.toggle).toHaveBeenCalledWith('mini');
    fireEvent.click(screen.getByRole('button', { name: 'All' }));
    expect(fixture.select).toHaveBeenCalledWith('all');
  });

  it('right-clicking a computer opens remote desktop and new project for that computer', () => {
    const onCreateProject = strip(['local', 'rog', 'mini']);
    fireEvent.contextMenu(screen.getByRole('button', { name: 'ROG' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Remote desktop' }));
    expect(openRemoteDesktop).toHaveBeenCalledWith({ deviceId: 'rog', name: 'ROG' });

    fireEvent.contextMenu(screen.getByRole('button', { name: 'ROG' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'New project' }));
    expect(onCreateProject).toHaveBeenCalledWith({ deviceId: 'rog', deviceName: 'ROG' });
  });
});
