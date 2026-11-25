import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { MessageAnnotation, MessageAnnotationRequest } from '../../shared/messageAnnotations';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '../contexts/dataOwnerGeneration';

const empty: readonly MessageAnnotation[] = [];
const records = new Map<string, readonly MessageAnnotation[]>();
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<readonly MessageAnnotation[]>>();
const revisions = new Map<string, number>();
const notify = () => listeners.forEach(fn => fn());
const unsubscribeOwner = subscribeDataOwnerGeneration(() => { records.clear(); pending.clear(); revisions.clear(); notify(); });
if (import.meta.hot) import.meta.hot.dispose(unsubscribeOwner);

export async function updateMessageAnnotations(request: MessageAnnotationRequest): Promise<readonly MessageAnnotation[]> {
  const owner = getDataOwnerGeneration();
  const revision = (revisions.get(request.sessionId) ?? 0) + 1;
  revisions.set(request.sessionId, revision);
  const result = await window.electronAPI.localDb.messageAnnotations(request);
  if (!isDataOwnerGenerationCurrent(owner)) throw new Error('[ANNOTATION_OWNER_CHANGED]');
  if (revisions.get(request.sessionId) === revision) {
    records.set(request.sessionId, result);
    notify();
  }
  return result;
}
export function loadMessageAnnotations(sessionId: string): Promise<readonly MessageAnnotation[]> {
  const existing = pending.get(sessionId);
  if (existing) return existing;
  const promise = updateMessageAnnotations({ action: 'list', sessionId }).finally(() => {
    if (pending.get(sessionId) === promise) pending.delete(sessionId);
  });
  pending.set(sessionId, promise);
  return promise;
}
export function useMessageAnnotations(sessionId: string | null | undefined) {
  const owner = useSyncExternalStore(subscribeDataOwnerGeneration, getDataOwnerGeneration);
  const subscribe = useCallback((fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; }, []);
  const snapshot = useCallback(() => sessionId ? records.get(sessionId) ?? empty : empty, [sessionId]);
  const annotations = useSyncExternalStore(subscribe, snapshot);
  useEffect(() => {
    if (!sessionId || !window.electronAPI?.localDb?.messageAnnotations) return;
    const refresh = () => { void loadMessageAnnotations(sessionId).catch(() => {}); };
    refresh();
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [sessionId, owner]);
  return annotations;
}
