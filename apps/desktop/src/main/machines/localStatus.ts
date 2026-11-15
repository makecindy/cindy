/**
 * 读这台电脑此刻的资源情况（docs/product-rules/cindy-machines.md）。每项独立失败：读不到的是 null，
 * 不影响其他项，也不用近似值冒充。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import { powerMonitor } from 'electron';
import type { MachineStatus } from '@cindy/device-link';
import { parseVmStatAvailableBytes } from './sshStatus.js';

const run = promisify(execFile);
const CPU_SAMPLE_MS = 200;

let runningTasks: (() => Promise<number>) | null = null;
export function configureLocalMachineActivity(read: () => Promise<number>): void { runningTasks = read; }

const attempt = <T>(read: () => T): T | null => { try { return read(); } catch { return null; } };

function cpuTimes() {
  return os.cpus().reduce((sum, { times }) => ({
    idle: sum.idle + times.idle,
    total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
  }), { idle: 0, total: 0 });
}

async function busyPercent(): Promise<number | null> {
  const before = cpuTimes();
  await new Promise(resolve => setTimeout(resolve, CPU_SAMPLE_MS));
  const after = cpuTimes();
  const total = after.total - before.total;
  return total > 0 ? Math.round((1 - (after.idle - before.idle) / total) * 100) : null;
}

async function availableMemory(): Promise<number | null> {
  if (process.platform !== 'darwin') return os.freemem(); // Linux 是 MemAvailable，Windows 是可用物理内存。
  try { return parseVmStatAvailableBytes((await run('/usr/bin/vm_stat', { timeout: 2_000 })).stdout); }
  catch { return null; }
}

async function homeDisk(): Promise<MachineStatus['disk']> {
  try {
    const space = await fs.statfs(os.homedir());
    return { freeBytes: space.bavail * space.bsize, totalBytes: space.blocks * space.bsize };
  } catch { return null; }
}

export async function readLocalMachineStatus(): Promise<MachineStatus> {
  const [busy, memory, disk] = await Promise.all([busyPercent(), availableMemory(), homeDisk()]);
  return {
    capturedAt: new Date().toISOString(),
    cpu: {
      logicalCores: os.cpus().length,
      busyPercent: busy,
      loadAverage1m: process.platform === 'win32' ? null : os.loadavg()[0] ?? null,
    },
    memory: { totalBytes: os.totalmem(), availableBytes: memory },
    disk,
    idleSeconds: attempt(() => powerMonitor.getSystemIdleTime()),
    onBattery: attempt(() => powerMonitor.isOnBatteryPower()),
    runningTasks: runningTasks ? await runningTasks().catch(() => null) : null,
  };
}
