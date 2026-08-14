import { describe, expect, it } from 'vitest';

import { resolveDialogueDeviceTarget } from '@/features/cc-agent/lib/dialogueCreateTarget';
import { MACHINE_ALL, MACHINE_LOCAL } from '@/features/device-link/selectedMachineStore';
import type { SwitcherDevice } from '@/features/device-link/switcherDevices';

const devices: SwitcherDevice[] = [
  { deviceId: 'remote-a', name: 'Remote A', status: 'connected' },
  { deviceId: 'remote-b', name: 'Remote B', status: 'connecting' },
  { deviceId: 'remote-rejected', name: 'Rejected', status: 'rejected' },
];

describe('resolveDialogueDeviceTarget', () => {
  it('inherits the only selected remote machine', () => {
    expect(resolveDialogueDeviceTarget(['remote-a'], devices, true)).toEqual({
      status: 'ready',
      target: { deviceId: 'remote-a', deviceName: 'Remote A' },
    });
    expect(resolveDialogueDeviceTarget(['remote-b'], devices, true)).toEqual({
      status: 'ready',
      target: { deviceId: 'remote-b', deviceName: 'Remote B' },
    });
  });

  it('keeps the local default when the machine scope is not a unique remote target', () => {
    const local = { status: 'ready', target: null };
    expect(resolveDialogueDeviceTarget(MACHINE_ALL, devices, false)).toEqual(local);
    expect(resolveDialogueDeviceTarget([MACHINE_LOCAL], devices, false)).toEqual(local);
    expect(resolveDialogueDeviceTarget([MACHINE_LOCAL, 'remote-a'], devices, false)).toEqual(local);
    expect(resolveDialogueDeviceTarget(['remote-a', 'remote-b'], devices, false)).toEqual(local);
  });

  it('waits for an unresolved unique remote until the directory settles', () => {
    expect(resolveDialogueDeviceTarget(['remote-a'], [], false)).toEqual({ status: 'pending' });
    expect(resolveDialogueDeviceTarget(['remote-a'], [], true)).toEqual({
      status: 'ready',
      target: null,
    });
  });

  it('does not inherit a rejected device', () => {
    expect(resolveDialogueDeviceTarget(['remote-rejected'], devices, true)).toEqual({
      status: 'ready',
      target: null,
    });
  });
});
