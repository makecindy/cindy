import { describe, expect, it } from 'vitest';
import type { MobileHomeDeviceFilterItem, MobileHomeProjectGroup } from '@/session/mobileHome';
import { buildHomeProjectMachineIdentities } from '@/session/homeProjectMachineIdentity';

const connected = {
  status: 'online' as const,
  getPresenceAvailability: (_deviceId: string): boolean | null => true,
  unresponsiveDevices: new Set<string>(),
  revokedDevices: new Set<string>(),
};

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
    }, connected);
    expect([...result.values()].map((item) => item.displayLabel)).toEqual(['Windows', 'MacBook', 'MacBook']);
    expect(result.get('a')).toEqual({ displayLabel: 'Windows', disconnected: false, hideLabel: false });
  });

  it('only disambiguates visible projects on distinct same-named devices, ignoring case and padding', () => {
    const deviceFilters = [device('one', ' MacBook '), device('two', 'macbook')];
    const result = buildHomeProjectMachineIdentities({
      projects: [project('a', 'one', 'MacBook'), project('b', 'two', 'macbook')],
      deviceFilters, selectedDeviceId: null,
    }, connected);
    expect(result.get('a')?.displayLabel).toBe('MacBook · one');
    expect(result.get('b')?.displayLabel).toBe('macbook · two');
    const onlyOneVisible = buildHomeProjectMachineIdentities({
      projects: [project('a', 'one', 'MacBook')], deviceFilters, selectedDeviceId: null,
    }, connected);
    expect(onlyOneVisible.get('a')?.displayLabel).toBe('MacBook');
  });

  it('hides redundant labels under a selected device but retains offline identity for the icon', () => {
    const result = buildHomeProjectMachineIdentities({
      projects: [project('a', 'mac', 'MacBook')],
      deviceFilters: [device('mac', 'MacBook', false)], selectedDeviceId: 'mac',
    }, { ...connected, getPresenceAvailability: () => false });
    expect(result.get('a')).toEqual({ displayLabel: 'MacBook', disconnected: true, hideLabel: true });
  });

  // Regression: reopening a task list first paints cached tasks without its local
  // device roster. Unit coverage previously equated that unknown/failed list state
  // with disconnection; exercise the production icon projection across the gap.
  it('keeps the project connected across roster loading, stale offline rows and refreshed rows', () => {
    const home = {
      projects: [project('a', 'mac', 'MacBook')],
      selectedDeviceId: null,
    };
    for (const deviceFilters of [
      [],
      [{ ...device('mac', 'MacBook', false), state: 'unknown' as const }],
      [device('mac', 'MacBook', false)],
      [device('mac', 'MacBook')],
    ]) {
      expect(buildHomeProjectMachineIdentities({ ...home, deviceFilters }, connected).get('a'))
        .toEqual({ displayLabel: 'MacBook', disconnected: false, hideLabel: false });
    }
  });

  it.each([
    ['unknown presence', { getPresenceAvailability: (): boolean | null => null }, false],
    ['offline or remote disabled', { getPresenceAvailability: (): boolean | null => false }, true],
    ['relay reconnecting', { status: 'connecting' as const }, true],
    ['relay stopped', { status: 'stopped' as const }, true],
    ['unresponsive host', { unresponsiveDevices: new Set(['mac']) }, true],
    ['revoked host', { revokedDevices: new Set(['mac']) }, true],
  ] as const)('uses shared evidence for %s even while the roster says ready', (_label, evidence, disconnected) => {
    const home = {
      projects: [project('a', 'mac', 'MacBook')],
      deviceFilters: [device('mac', 'MacBook')], selectedDeviceId: null,
    };
    expect(buildHomeProjectMachineIdentities(home, { ...connected, ...evidence }).get('a')?.disconnected).toBe(disconnected);
    expect(buildHomeProjectMachineIdentities(home, connected).get('a')?.disconnected).toBe(false);
  });

  it('keeps failures scoped to their computer and reads current presence with unchanged list inputs', () => {
    const home = {
      projects: [project('a', 'mac', 'MacBook'), project('b', 'win', 'Windows')],
      deviceFilters: [], selectedDeviceId: null,
    };
    let macAvailable = false;
    const evidence = { ...connected, getPresenceAvailability: (id: string) => id !== 'mac' || macAvailable };
    expect([...buildHomeProjectMachineIdentities(home, evidence).values()].map(row => row.disconnected)).toEqual([true, false]);
    macAvailable = true;
    expect([...buildHomeProjectMachineIdentities(home, evidence).values()].map(row => row.disconnected)).toEqual([false, false]);
  });

  it('uses the current device name, falls back to ID for empty names, and skips unowned folders', () => {
    const result = buildHomeProjectMachineIdentities({
      projects: [project('a', 'mac', 'Old name'), project('b', 'win', ''), project('c', null, '')],
      deviceFilters: [device('mac', 'Renamed Mac'), device('win', '  ')], selectedDeviceId: null,
    }, connected);
    expect(result.get('a')?.displayLabel).toBe('Renamed Mac');
    expect(result.get('b')?.displayLabel).toBe('win');
    expect(result.has('c')).toBe(false);
  });
});
