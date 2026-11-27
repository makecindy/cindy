// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { DeviceSwitcherPill } from '../DeviceSwitcherPill';
import type { SelectableDevice } from '@/hooks/useControllableDevices';

afterEach(() => {
  cleanup();
});

const PEERS: SelectableDevice[] = [
  { deviceId: 'dev-1', name: 'cindy-dash-us-desktop-99be44', platform: 'linux', online: false },
  { deviceId: 'dev-2', name: 'dashflow', platform: 'darwin', online: false },
  { deviceId: 'dev-3', name: 'Dash Macbook Pro', platform: 'darwin', online: false },
  { deviceId: 'dev-4', name: 'Mac mini', platform: 'darwin', online: true },
  { deviceId: 'dev-5', name: 'Studio', platform: 'darwin', online: true },
];

describe('DeviceSwitcherPill', () => {
  it('renders local machine first, then online peers by recency/name, then offline peers disabled', () => {
    render(
      <DeviceSwitcherPill
        devices={PEERS}
        lastUsedAtByDeviceId={{
          'dev-3': 9000, // offline but recently used → top of offline group, never above online
          'dev-5': 5000, // online & most recently used → first peer
          'dev-4': 2000, // online & older → second peer
        }}
        value={null}
        onChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const options = screen.getAllByTestId('create-agent-device-option');
    expect(options.map((el) => el.textContent)).toEqual([
      'ccAgent.sidebar.machineSwitcher.localMachinenewChat.deviceSwitcher.localHint',
      'StudionewChat.deviceSwitcher.onlineHint',
      'Mac mininewChat.deviceSwitcher.onlineHint',
      'Dash Macbook PronewChat.deviceSwitcher.offlineHint',
      'cindy-dash-us-desktop-99be44newChat.deviceSwitcher.offlineHint',
      'dashflownewChat.deviceSwitcher.offlineHint',
    ]);
    expect((options[0] as HTMLButtonElement).disabled).toBe(false);
    expect((options[1] as HTMLButtonElement).disabled).toBe(false);
    expect((options[2] as HTMLButtonElement).disabled).toBe(false);
    expect((options[3] as HTMLButtonElement).disabled).toBe(true);
    expect((options[4] as HTMLButtonElement).disabled).toBe(true);
    expect((options[5] as HTMLButtonElement).disabled).toBe(true);
  });

  it('places newly online device ahead of offline peers without explicit recency data', () => {
    render(
      <DeviceSwitcherPill
        devices={PEERS}
        value={null}
        onChange={vi.fn()}
        open
        onOpenChange={vi.fn()}
      />,
    );

    const options = screen.getAllByTestId('create-agent-device-option');
    expect(options.map((el) => el.textContent)).toEqual([
      'ccAgent.sidebar.machineSwitcher.localMachinenewChat.deviceSwitcher.localHint',
      'Mac mininewChat.deviceSwitcher.onlineHint',
      'StudionewChat.deviceSwitcher.onlineHint',
      'cindy-dash-us-desktop-99be44newChat.deviceSwitcher.offlineHint',
      'Dash Macbook PronewChat.deviceSwitcher.offlineHint',
      'dashflownewChat.deviceSwitcher.offlineHint',
    ]);
  });

  it('selects an online peer and closes the popover on click', () => {
    const onChange = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <DeviceSwitcherPill
        devices={PEERS}
        lastUsedAtByDeviceId={{ 'dev-4': 5000 }}
        value={null}
        onChange={onChange}
        open
        onOpenChange={onOpenChange}
      />,
    );

    const options = screen.getAllByTestId('create-agent-device-option');
    fireEvent.click(options[1]);
    expect(onChange).toHaveBeenCalledWith('dev-4', 'Mac mini');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('renders nothing when no peer devices are available', () => {
    const { container } = render(
      <DeviceSwitcherPill
        devices={[]}
        value={null}
        onChange={vi.fn()}
        open={false}
        onOpenChange={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
