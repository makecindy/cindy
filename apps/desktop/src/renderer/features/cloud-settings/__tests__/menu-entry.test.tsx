// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { MachineSwitcherMenu } from '@/features/cc-agent/sidebar/MachineSwitcherMenu';

const state = vi.hoisted(() => ({ mode: 'cloud', selected: vi.fn(), toggle: vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ mode: state.mode }),
  useOptionalAuthUser: () => null,
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
