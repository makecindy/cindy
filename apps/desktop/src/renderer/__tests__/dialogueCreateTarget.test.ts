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
    expect(resolveDialogueDeviceTarget(['remote-a'], devices)).toEqual({
      deviceId: 'remote-a',
      deviceName: 'Remote A',
    });
    expect(resolveDialogueDeviceTarget(['remote-b'], devices)).toEqual({
      deviceId: 'remote-b',
      deviceName: 'Remote B',
    });
  });

  it('keeps the local default when the machine scope is not a unique remote target', () => {
    expect(resolveDialogueDeviceTarget(MACHINE_ALL, devices)).toBeNull();
    expect(resolveDialogueDeviceTarget([MACHINE_LOCAL], devices)).toBeNull();
    expect(resolveDialogueDeviceTarget([MACHINE_LOCAL, 'remote-a'], devices)).toBeNull();
    expect(resolveDialogueDeviceTarget(['remote-a', 'remote-b'], devices)).toBeNull();
  });

  it('does not inherit an unavailable or rejected device', () => {
    expect(resolveDialogueDeviceTarget(['missing'], devices)).toBeNull();
    expect(resolveDialogueDeviceTarget(['remote-rejected'], devices)).toBeNull();
  });
});
