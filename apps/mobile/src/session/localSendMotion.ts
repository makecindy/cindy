import { pendingSendItemKey } from '@/session/pendingSendItems';

/**
 * Sends started from this phone's composer in this app run, by list key (the local bubble and its
 * echo share it). Only these rows enter with motion, pull the list along and hold back their status;
 * queue rows from other devices, relaunch recovery and history keep their still presentation.
 */
const MAX_REMEMBERED = 50;
/** Most sends land before this; a slower one then reveals its spinner instead of flashing it. */
export const LOCAL_SEND_STATUS_DELAY_MS = 600;
/** A local send stays "just sent" this long: later mounts (scrolling back, remounts) stay still. */
export const LOCAL_SEND_FRESH_MS = 15_000;

const startedAt = new Map<string, number>();

export function noteLocalSend(clientId: string, now = Date.now()): void {
  const key = pendingSendItemKey(clientId);
  startedAt.delete(key);
  startedAt.set(key, now);
  if (startedAt.size > MAX_REMEMBERED) startedAt.delete(startedAt.keys().next().value!);
}

/** When this phone sent the row with this list key, or null when it did not. */
export function localSendStartedAt(key: string): number | null {
  return startedAt.get(key) ?? null;
}
