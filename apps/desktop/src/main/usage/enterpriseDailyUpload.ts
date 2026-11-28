import { createHash } from 'node:crypto';

const DAY_MS = 86_400_000;

/** A stable UTC slot per installation. The installation key stays local. */
export function dailyUploadSlot(installationKey: string): number {
  return createHash('sha256').update(installationKey).digest().readUInt32BE(0) % DAY_MS;
}

/** Only sealed UTC days are eligible. On late startup, all overdue days are eligible together. */
export function latestUploadableDay(nowMs: number, slotMs: number): string {
  const latestSlotDay = Math.floor((nowMs - slotMs) / DAY_MS);
  return new Date((latestSlotDay - 1) * DAY_MS).toISOString().slice(0, 10);
}
