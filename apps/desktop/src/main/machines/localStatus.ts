/** Desktop assembly for the shared machine status reader. */
import { powerMonitor } from 'electron';
import type { MachineStatus } from '@cindy/device-link';
import { readLocalMachineStatusCore } from './localStatusCore.js';

let runningTasks: (() => Promise<number>) | null = null;
export function configureLocalMachineActivity(read: () => Promise<number>): void { runningTasks = read; }

export function readLocalMachineStatus(): Promise<MachineStatus> {
  return readLocalMachineStatusCore({
    readIdleSeconds: () => powerMonitor.getSystemIdleTime(),
    readOnBattery: () => powerMonitor.isOnBatteryPower(),
    readRunningTasks: () => runningTasks?.() ?? null,
  });
}
