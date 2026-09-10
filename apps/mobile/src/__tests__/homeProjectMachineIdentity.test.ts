import { describe, expect, it } from 'vitest';
import type { MobileHomeDeviceFilterItem, MobileHomeProjectGroup } from '@/session/mobileHome';
import { buildHomeProjectMachineIdentities } from '@/session/homeProjectMachineIdentity';

function project(key: string, deviceId: string | null, deviceName: string): MobileHomeProjectGroup {
  return {
    key, deviceId, deviceName, title: 'folder', workingDir: '/folder',
    sessions: [], sessionCount: 0, pendingInteractionCount: 0,
    latestActivityAt: '', subtitle: '',
  };
}

function device(deviceId: string, label: string, available = true): MobileHomeDeviceFilterItem {
  return {
    id: deviceId, deviceId, label, available, selected: false,
    sessionCount: 0, waitingCount: 0, state: available ? 'ready' : 'offline', statusLabel: '',
  };
}

describe('project machine identity parity with Desktop', () => {
  it('shows names without IDs for distinct devices and repeated projects on one device', () => {
    const result = buildHomeProjectMachineIdentities({
      projects: [project('a', 'win', 'Windows'), project('b', 'mac', 'MacBook'), project('c', 'mac', 'MacBook')],
      deviceFilters: [device('win', 'Windows'), device('mac', 'MacBook')],
      selectedDeviceId: null,
    });
    expect([...result.values()].map((item) => item.displayLabel)).toEqual(['Windows', 'MacBook', 'MacBook']);
    expect(result.get('a')).toEqual({ displayLabel: 'Windows', disconnected: false, hideLabel: false });
  });

  it('only disambiguates visible projects on distinct same-named devices, ignoring case and padding', () => {
    const deviceFilters = [device('one', ' MacBook '), device('two', 'macbook')];
    const result = buildHomeProjectMachineIdentities({
      projects: [project('a', 'one', 'MacBook'), project('b', 'two', 'macbook')],
      deviceFilters, selectedDeviceId: null,
    });
    expect(result.get('a')?.displayLabel).toBe('MacBook · one');
    expect(result.get('b')?.displayLabel).toBe('macbook · two');
    const onlyOneVisible = buildHomeProjectMachineIdentities({
      projects: [project('a', 'one', 'MacBook')], deviceFilters, selectedDeviceId: null,
    });
    expect(onlyOneVisible.get('a')?.displayLabel).toBe('MacBook');
  });

  it('hides redundant labels under a selected device but retains offline identity for the icon', () => {
    const result = buildHomeProjectMachineIdentities({
      projects: [project('a', 'mac', 'MacBook')],
      deviceFilters: [device('mac', 'MacBook', false)], selectedDeviceId: 'mac',
    });
    expect(result.get('a')).toEqual({ displayLabel: 'MacBook', disconnected: true, hideLabel: true });
  });

  it('reflects a failed connection and a later recovery without hiding the machine label', () => {
    const home = {
      projects: [project('a', 'mac', 'MacBook')],
      deviceFilters: [device('mac', 'MacBook')], selectedDeviceId: null,
    };
    expect(buildHomeProjectMachineIdentities(home, { mac: 'failed' }).get('a')?.disconnected).toBe(true);
    expect(buildHomeProjectMachineIdentities(home, { mac: 'idle' }).get('a')?.disconnected).toBe(false);
  });

  it('uses the current device name, falls back to ID for empty names, and skips unowned folders', () => {
    const result = buildHomeProjectMachineIdentities({
      projects: [project('a', 'mac', 'Old name'), project('b', 'win', ''), project('c', null, '')],
      deviceFilters: [device('mac', 'Renamed Mac'), device('win', '  ')], selectedDeviceId: null,
    });
    expect(result.get('a')?.displayLabel).toBe('Renamed Mac');
    expect(result.get('b')?.displayLabel).toBe('win');
    expect(result.has('c')).toBe(false);
  });
});
