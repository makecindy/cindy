import { useCallback, useSyncExternalStore } from 'react';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  isDataOwnerPushCurrent,
} from '@/contexts/dataOwnerGeneration';
import type { CindyMakeGlobalState, MakeDoctorReport } from '../../shared/cindyMakeDoctor';

const empty: CindyMakeGlobalState = {};
let state: CindyMakeGlobalState = empty;
let owner = getDataOwnerGeneration();
let loaded = false;
let unsubscribe: (() => void) | undefined;
const listeners = new Set<() => void>();
let connection = 0;

function connect(): void {
  if (!isDataOwnerGenerationCurrent(owner)) {
    unsubscribe?.();
    unsubscribe = undefined;
    state = empty;
    loaded = false;
    owner = getDataOwnerGeneration();
  }
  if (unsubscribe || typeof window === 'undefined' || !window.electronAPI) return;
  const generation = owner;
  const connectionId = ++connection;
  const previous = state;
  let pushed = false;
  const apply = (next: CindyMakeGlobalState) => {
    if (
      connectionId !== connection ||
      !isDataOwnerGenerationCurrent(generation) ||
      !isDataOwnerPushCurrent(next.ownerStamp)
    )
      return false;
    state = next;
    loaded = true;
    for (const listener of listeners) listener();
    return true;
  };
  unsubscribe =
    window.electronAPI.onCindyMakeState?.((next) => {
      pushed = apply(next) || pushed;
    }) ?? (() => {});
  void Promise.resolve(window.electronAPI.getCindyMakeState?.())
    .then((next) => {
      if (next && !pushed && state === previous) apply(next);
    })
    .catch(() => undefined);
}

export const cindyMakeState = {
  async manageTask(sessionId: string, action: 'end' | 'finish' | 'delete'): Promise<void> {
    const generation = getDataOwnerGeneration();
    await window.electronAPI.manageCindyMakeTask(sessionId, action);
    if (!isDataOwnerGenerationCurrent(generation)) return;
    // Main only acknowledges success after cleanup and its completion marker.
    // Apply that fact immediately; a delayed snapshot must not keep the task spinning.
    const tasks = Object.fromEntries(
      Object.entries(state.tasks ?? {}).filter(
        ([, report]) => report.task?.sessionId !== sessionId,
      ),
    );
    const taskActions = { ...state.taskActions };
    delete taskActions[sessionId];
    state = { ...state, tasks: Object.keys(tasks).length ? tasks : undefined, taskActions };
    for (const listener of listeners) listener();
  },
  async refresh(): Promise<void> {
    const generation = getDataOwnerGeneration();
    const previous = state;
    const next = await window.electronAPI.getCindyMakeState?.();
    if (
      !next ||
      !isDataOwnerGenerationCurrent(generation) ||
      !isDataOwnerPushCurrent(next.ownerStamp) ||
      state !== previous
    )
      return;
    state = next;
    loaded = true;
    for (const listener of listeners) listener();
  },
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    connect();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        connection += 1;
        unsubscribe?.();
        unsubscribe = undefined;
      }
    };
  },
  getSnapshot(): CindyMakeGlobalState {
    return isDataOwnerGenerationCurrent(owner) ? state : empty;
  },
  isLoaded(): boolean {
    return loaded && isDataOwnerGenerationCurrent(owner);
  },
  taskForSession(sessionId: string): MakeDoctorReport | undefined {
    return Object.values(cindyMakeState.getSnapshot().tasks ?? {}).find(
      (report) => report.task?.sessionId === sessionId,
    );
  },
};

export function useCindyMakeState(): CindyMakeGlobalState {
  const generation = getDataOwnerGeneration();
  const subscribe = useCallback(
    (listener: () => void) => cindyMakeState.subscribe(listener),
    [generation.dataOwnerId, generation.generation],
  );
  return useSyncExternalStore(subscribe, cindyMakeState.getSnapshot, () => empty);
}
