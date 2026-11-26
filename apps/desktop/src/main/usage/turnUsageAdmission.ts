import type { DbClient } from '../localDb/client/DbClient.js';
import { AsyncLocalStorage } from 'node:async_hooks';

/** Only the desktop Session event recorder enters this context. Recheck before starting
 * each independent write, including a recorder resumed by pricing or model lookup. */
export const turnUsageAdmission = new AsyncLocalStorage<() => boolean>();

export function mayRecordTurnUsage(): boolean {
  return turnUsageAdmission.getStore()?.() !== false;
}

/** Every operation of one admitted message cost patch uses its original connection. */
export const messageCostDatabase = new AsyncLocalStorage<DbClient>();

/** A same-account repair gets its current window stamp. Once that account has
 * changed, no continuation may issue a push, even if it finished an admitted write. */
export function turnUsageBroadcastScope<T>(original: T, capture: () => T): T {
  return turnUsageAdmission.getStore()?.() ? capture() : original;
}
