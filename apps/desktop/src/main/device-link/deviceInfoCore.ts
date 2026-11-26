import os from 'node:os';
import type { DeviceInfo } from '@cindy/device-link';

function normalizeDeviceInfoText(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, 128);
}

export function buildDeviceInfo(systemVersion: string): DeviceInfo {
  const info: DeviceInfo = {};
  const cpuLabel = normalizeDeviceInfoText(os.cpus()[0]?.model);
  if (cpuLabel) info.cpuLabel = cpuLabel;

  const memoryGb = Math.round(os.totalmem() / 1024 ** 3);
  if (Number.isFinite(memoryGb) && memoryGb > 0) info.memoryGb = memoryGb;

  const osVersion = normalizeDeviceInfoText(systemVersion);
  if (osVersion) info.osVersion = osVersion;
  return info;
}
