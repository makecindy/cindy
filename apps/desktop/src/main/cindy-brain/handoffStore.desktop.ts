import { ownerScopedUserDataPath } from '../appSessionState.js';
import { GhostHandoffStore } from './handoffStore.js';

let handoffStoreSingleton: GhostHandoffStore | null = null;

export function isGhostHandoffBusy(instance: string): boolean {
  return handoffStoreSingleton?.isBusy(instance) ?? false;
}

/** Owner-scoped copies; both plugin entry points use the same store. */
export function getGhostHandoffStore(): GhostHandoffStore {
  handoffStoreSingleton ??= new GhostHandoffStore({ root: () => ownerScopedUserDataPath('ghost-handoff') });
  return handoffStoreSingleton;
}
