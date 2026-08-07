import { useSyncExternalStore } from 'react';
import type { GhostPlanProgressSnapshot } from '../../shared/ghost';

const progressBySession = new Map<string, GhostPlanProgressSnapshot>();
const listeners = new Set<() => void>();
let unsubscribe: (() => void) | null = null;

function isProgressSnapshot(value: unknown): value is GhostPlanProgressSnapshot {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as Partial<GhostPlanProgressSnapshot>;
  return (
    typeof snapshot.sessionId === 'string' &&
    typeof snapshot.sessionInstanceId === 'string' &&
    Array.isArray(snapshot.plan) &&
    typeof snapshot.updatedAtMs === 'number'
  );
}

function ensureSubscription(): void {
  if (unsubscribe || typeof window === 'undefined') return;
  unsubscribe = window.electronAPI.maker.onSessionProgressChanged((snapshot) => {
    if (!isProgressSnapshot(snapshot)) return;
    progressBySession.set(snapshot.sessionId, snapshot);
    for (const listener of listeners) listener();
  });
}

function subscribe(listener: () => void): () => void {
  ensureSubscription();
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSessionProgress(sessionId: string | null): GhostPlanProgressSnapshot | null {
  return sessionId ? progressBySession.get(sessionId) ?? null : null;
}

/** The host's ephemeral progress display wins while it is active for this task. */
export function useSessionProgress(sessionId: string | null): GhostPlanProgressSnapshot | null {
  return useSyncExternalStore(subscribe, () => getSessionProgress(sessionId), () => null);
}
