/** Read-only machine facts shared by the two runtimes. Unavailable samples return null independently. */
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import { promisify } from 'node:util';
import type { MachineStatus } from '@cindy/device-link';
import { parseVmStatAvailableBytes } from './sshStatus.js';

const run = promisify(execFile);
const CPU_SAMPLE_MS = 200;

interface MachineActivityPorts {
  readIdleSeconds?(): number | null | Promise<number | null>;
  readOnBattery?(): boolean | null | Promise<boolean | null>;
  readRunningTasks(): number | null | Promise<number | null>;
}

async function attempt<T>(read: (() => T | Promise<T>) | undefined): Promise<T | null> {
  try { return read ? await read() : null; } catch { return null; }
}

function cpuTimes() {
  const cpus = os.cpus();
  const times = cpus.reduce((sum, { times }) => ({
    idle: sum.idle + times.idle,
    total: sum.total + times.user + times.nice + times.sys + times.idle + times.irq,
  }), { idle: 0, total: 0 });
  return { ...times, logicalCores: cpus.length };
}

async function readCpu(): Promise<MachineStatus['cpu']> {
  const before = cpuTimes();
  await new Promise(resolve => setTimeout(resolve, CPU_SAMPLE_MS));
  const after = cpuTimes();
  const total = after.total - before.total;
  return {
    logicalCores: after.logicalCores,
    busyPercent: total > 0 ? Math.round((1 - (after.idle - before.idle) / total) * 100) : null,
    loadAverage1m: process.platform === 'win32' ? null : os.loadavg()[0] ?? null,
  };
}

async function availableMemory(): Promise<number | null> {
  if (process.platform !== 'darwin') return os.freemem(); // MemAvailable on Linux, available physical memory on Windows.
  return parseVmStatAvailableBytes((await run('/usr/bin/vm_stat', { timeout: 2_000 })).stdout);
}

async function homeDisk(): Promise<NonNullable<MachineStatus['disk']>> {
  const space = await fs.statfs(os.homedir());
  return { freeBytes: space.bavail * space.bsize, totalBytes: space.blocks * space.bsize };
}

export async function readLocalMachineStatusCore(ports: MachineActivityPorts): Promise<MachineStatus> {
  const [cpu, memory, disk, idleSeconds, onBattery, runningTasks] = await Promise.all([
    readCpu(),
    attempt(availableMemory),
    attempt(homeDisk),
    attempt(ports.readIdleSeconds),
    attempt(ports.readOnBattery),
    attempt(ports.readRunningTasks),
  ]);
  return {
    capturedAt: new Date().toISOString(),
    cpu,
    memory: { totalBytes: os.totalmem(), availableBytes: memory },
    disk,
    idleSeconds,
    onBattery,
    runningTasks,
  };
}
