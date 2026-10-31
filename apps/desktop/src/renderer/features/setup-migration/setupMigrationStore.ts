/**
 * Window-local open state of the new-computer setup dialog. Settings, the first-run
 * suggestion and the checklist all open the same dialog; nothing here is persisted.
 */
import { useSyncExternalStore } from 'react';

export interface SetupMigrationDialogState {
  open: boolean;
  /** Computer to read right away (from the first-run suggestion). */
  deviceId: string | null;
  /** Bumps on every open so the dialog restarts from a clean state. */
  session: number;
}

let state: SetupMigrationDialogState = { open: false, deviceId: null, session: 0 };
const listeners = new Set<() => void>();

function emit(next: SetupMigrationDialogState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function openSetupMigration(deviceId: string | null = null): void {
  emit({ open: true, deviceId, session: state.session + 1 });
}

export function closeSetupMigration(): void {
  if (state.open) emit({ ...state, open: false, deviceId: null });
}

export function subscribeSetupMigration(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getSetupMigrationState(): SetupMigrationDialogState {
  return state;
}

export function useSetupMigrationDialog(): SetupMigrationDialogState {
  return useSyncExternalStore(subscribeSetupMigration, getSetupMigrationState);
}

/** Settings and the dialog re-read the persisted checklist after either changes it. */
const stateListeners = new Set<() => void>();

export function notifySetupMigrationStateChanged(): void {
  for (const listener of stateListeners) listener();
}

export function subscribeSetupMigrationStateChanged(listener: () => void): () => void {
  stateListeners.add(listener);
  return () => {
    stateListeners.delete(listener);
  };
}

/**
 * "Go through the list": this window walks the checklist one item at a time, opening each item's
 * Settings page. Window-local; the persisted checklist stays the source of truth for done items.
 */
export interface SetupMigrationWalkthroughState {
  /** Item ids in list order, captured when the walkthrough started. */
  ids: readonly string[];
  /** Index into `ids` of the item shown now; equals `ids.length` once the list is finished. */
  index: number;
}

let walkthrough: SetupMigrationWalkthroughState | null = null;
const walkthroughListeners = new Set<() => void>();

function emitWalkthrough(next: SetupMigrationWalkthroughState | null): void {
  walkthrough = next;
  for (const listener of walkthroughListeners) listener();
}

export function startSetupMigrationWalkthrough(ids: readonly string[]): void {
  emitWalkthrough(ids.length > 0 ? { ids: [...ids], index: 0 } : null);
}

/** Moves past the current item, skipping ids that `isDone` reports finished meanwhile. */
export function advanceSetupMigrationWalkthrough(isDone: (id: string) => boolean): void {
  if (!walkthrough) return;
  let index = walkthrough.index + 1;
  while (index < walkthrough.ids.length && isDone(walkthrough.ids[index])) index += 1;
  emitWalkthrough({ ...walkthrough, index });
}

export function stopSetupMigrationWalkthrough(): void {
  emitWalkthrough(null);
}

export function getSetupMigrationWalkthrough(): SetupMigrationWalkthroughState | null {
  return walkthrough;
}

export function useSetupMigrationWalkthrough(): SetupMigrationWalkthroughState | null {
  return useSyncExternalStore(
    (listener) => {
      walkthroughListeners.add(listener);
      return () => {
        walkthroughListeners.delete(listener);
      };
    },
    getSetupMigrationWalkthrough,
  );
}
