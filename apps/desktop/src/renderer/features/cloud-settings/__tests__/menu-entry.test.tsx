// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MachineSwitcherMenu } from '@/features/cc-agent/sidebar/MachineSwitcherMenu';

const state = vi.hoisted(() => ({
  mode: 'cloud',
  authUser: null as null | { id: string; orgId: string; membershipKind: 'org' },
  selected: vi.fn(),
  toggle: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: state.mode }),
  useOptionalAuthUser: () => state.authUser,
  useOptionalDataOwnerGeneration: () => 0,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({
  useDeviceLinkDeviceList: () => [],
}));
vi.mock('@/features/device-link/useMachineSwitcher', () => ({
  useMachineSwitcher: () => ({
    devices: [],
    selectedDeviceId: 'all',
    select: state.selected,
    toggle: state.toggle,
  }),
  useRemoteSessionBootstrapLoading: () => false,
}));
vi.mock('@/hooks/useActiveMainView', () => ({
  useActiveMainView: () => ({ navigateToView: vi.fn() }),
}));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), error: vi.fn() } }));
afterEach(() => {
  cleanup();
  state.mode = 'cloud';
  state.authUser = null;
  delete (window as { electronAPI?: unknown }).electronAPI;
  vi.clearAllMocks();
});

async function setup() {
  render(
    <MemoryRouter initialEntries={['/cc-agent/new']}>
      <Routes>
        <Route path="/cc-agent/new" element={<MachineSwitcherMenu />} />
        <Route path="/cloud-settings" element={<p>native cloud settings</p>} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.keyDown(screen.getByRole('button'), { key: 'Enter' });
  await screen.findByRole('menu');
}
it.each(['cloud', 'local'])(
  'keeps instance management inside Settings, not the device menu (%s)',
  async (mode) => {
    state.mode = mode;
    await setup();
    expect(screen.queryByRole('menuitem', { name: 'cloudSettings.instance.title' })).toBeNull();
    expect(
      screen.getByRole('menuitem', { name: 'ccAgent.sidebar.machineSwitcher.remoteSettings' }),
    ).toBeTruthy();
    expect(state.selected).not.toHaveBeenCalled();
    expect(state.toggle).not.toHaveBeenCalled();
  },
);

// 测试价值
// - 生产入口与可观察结果:MachineSwitcherMenu 侧栏任务范围下拉菜单;有云主机入口权限的组织成员打开菜单时不再出现管理/添加/准备中云主机入口,也不再发起 cloudComputerEntry IPC 读取。
// - Bug／规则依据:2026-11-27 用户纠正(DESIGN.md §4 Device access pills / My devices):云主机的添加与管理只放在「远程连接 → 我的设备」,不放在侧栏任务范围菜单。
// - 现有覆盖缺口:原用例把 useOptionalAuthUser 固定为 null 且未注入 cloudComputerEntry,无法拦住侧栏菜单渲染云主机入口。
// - 最小失败输入:组织成员 + deviceLink.cloudComputerEntry 返回可管理且可再添加一台的云主机入口 → 修复前菜单会渲染 manageCloud / addCloud 两项并调用该 IPC。
// - tier:unit(jsdom),复用本文件已有的 MachineSwitcherMenu 菜单渲染夹具。
it('keeps cloud computer actions out of the sidebar machine menu even for eligible org members', async () => {
  const cloudComputerEntry = vi.fn(async () => ({
    enabled: true,
    membershipId: 'member-1',
    organizationId: 'org-1',
    url: 'https://console.example.test/console/orgs/org-1/personal/cloud',
    computer: { status: 'linked' },
    canAdd: true,
  }));
  state.authUser = { id: 'member-1', orgId: 'org-1', membershipKind: 'org' };
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { deviceLink: { cloudComputerEntry } },
  });

  await setup();
  // Flush microtasks so an accidental async cloudComputerEntry read would resolve and render before assertion.
  await act(async () => {
    await Promise.resolve();
  });

  expect(
    screen.queryByRole('menuitem', { name: 'ccAgent.sidebar.machineSwitcher.manageCloud' }),
  ).toBeNull();
  expect(
    screen.queryByRole('menuitem', { name: 'ccAgent.sidebar.machineSwitcher.addCloud' }),
  ).toBeNull();
  expect(
    screen.queryByRole('menuitem', { name: 'ccAgent.sidebar.machineSwitcher.preparingCloud' }),
  ).toBeNull();
  expect(cloudComputerEntry).not.toHaveBeenCalled();
  expect(
    screen.getByRole('menuitem', { name: 'ccAgent.sidebar.machineSwitcher.remoteSettings' }),
  ).toBeTruthy();
});
