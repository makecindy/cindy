import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import { buildDeviceInfo } from '../../../desktop/src/main/device-link/deviceInfoCore.js';
import { readLocalMachineStatusCore } from '../../../desktop/src/main/machines/localStatusCore.js';

const run = promisify(execFile);
const probe = { timeout: 2_000, maxBuffer: 256 * 1024, env: { LC_ALL: 'C' } };

export function readHostDeviceName(): string {
  return process.env.CINDY_HOST_DEVICE_NAME?.trim() || `${os.hostname()} · Cindy Host`;
}

export async function readHostDeviceInfo() {
  let version = os.release();
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await run('/usr/bin/sw_vers', ['-productVersion'], probe);
      version = stdout.trim() || version;
    } catch {
      // Use the kernel release if the product version is unavailable.
    }
  }
  return buildDeviceInfo(version);
}

async function readMacIdleSeconds(): Promise<number | null> {
  const { stdout } = await run('/usr/sbin/ioreg', ['-r', '-l', '-c', 'IOHIDSystem', '-d', '1'], probe);
  const idle = Number(/^\s*"?HIDIdleTime"?\s*=\s*(\d+)\s*$/m.exec(stdout)?.[1]);
  return Number.isFinite(idle) ? Math.floor(idle / 1_000_000_000) : null;
}

async function readMacOnBattery(): Promise<boolean | null> {
  const { stdout } = await run('/usr/bin/pmset', ['-g', 'batt'], probe);
  const source = /^Now drawing from '([^']+)'/m.exec(stdout)?.[1];
  return source === 'Battery Power' ? true : source === 'AC Power' ? false : null;
}

export function readHostMachineStatus(readRunningTasks: () => number) {
  // The Node process has no Electron powerMonitor. On Mac, read the system
  // facts on demand without starting or writing an Electron profile.
  return readLocalMachineStatusCore({
    readRunningTasks,
    ...(process.platform === 'darwin' && { readIdleSeconds: readMacIdleSeconds, readOnBattery: readMacOnBattery }),
  });
}
