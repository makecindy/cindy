import {
  MACHINE_ALL,
  MACHINE_LOCAL,
  type MachineSelection,
} from '@/features/device-link/selectedMachineStore';
import type { SwitcherDevice } from '@/features/device-link/switcherDevices';

export interface DialogueDeviceTarget {
  deviceId: string;
  deviceName: string;
}

export type DialogueDeviceTargetResolution =
  | { status: 'pending' }
  | { status: 'ready'; target: DialogueDeviceTarget | null };

/**
 * “对话”分组的新建入口只在作用域明确指向一台远程机器时继承设备。
 * “所有”、本机、混合或多台远程机器都没有唯一目标，继续使用既有本机默认。
 */
export function resolveDialogueDeviceTarget(
  selectedMachineId: MachineSelection,
  devices: readonly SwitcherDevice[],
  deviceListSettled: boolean,
): DialogueDeviceTargetResolution {
  if (selectedMachineId === MACHINE_ALL || selectedMachineId.length !== 1) {
    return { status: 'ready', target: null };
  }
  const deviceId = selectedMachineId[0];
  if (deviceId === MACHINE_LOCAL) return { status: 'ready', target: null };
  const device = devices.find((candidate) => candidate.deviceId === deviceId);
  if (!device) {
    return deviceListSettled ? { status: 'ready', target: null } : { status: 'pending' };
  }
  if (device.status === 'rejected') return { status: 'ready', target: null };
  return { status: 'ready', target: { deviceId, deviceName: device.name } };
}
