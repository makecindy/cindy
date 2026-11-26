import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { MessageAnnotation, MessageAnnotationRequest } from '../../shared/messageAnnotations';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent, subscribeDataOwnerGeneration } from '../contexts/dataOwnerGeneration';

const empty: readonly MessageAnnotation[] = [];
const records = new Map<string, readonly MessageAnnotation[]>();
const listeners = new Set<() => void>();
const pending = new Map<string, Promise<readonly MessageAnnotation[]>>();
const operations = new Map<string, Promise<readonly MessageAnnotation[]>>();
const notify = () => listeners.forEach(fn => fn());
const unsubscribeOwner = subscribeDataOwnerGeneration(() => { records.clear(); pending.clear(); operations.clear(); notify(); });
if (import.meta.hot) import.meta.hot.dispose(unsubscribeOwner);

export function updateMessageAnnotations(request: MessageAnnotationRequest): Promise<readonly MessageAnnotation[]> {
  const owner = getDataOwnerGeneration();
  // A focus refresh must not overtake a save waiting for plugin approval/SQLite.
  // Invalidate read deduplication so a read requested after a mutation joins behind it.
  if (request.action !== 'list') pending.delete(request.sessionId);
  const previous = operations.get(request.sessionId);
  const operation = (async () => {
    if (previous) await previous.catch(() => {});
    if (!isDataOwnerGenerationCurrent(owner)) throw new Error('[ANNOTATION_OWNER_CHANGED]');
    const result = await window.electronAPI.localDb.messageAnnotations(request);
    if (!isDataOwnerGenerationCurrent(owner)) throw new Error('[ANNOTATION_OWNER_CHANGED]');
    records.set(request.sessionId, result);
    notify();
    return result;
  })().finally(() => {
    if (operations.get(request.sessionId) === operation) operations.delete(request.sessionId);
  });
  operations.set(request.sessionId, operation);
  return operation;
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
    const unsubscribeQueue = window.electronAPI.maker?.onInputProjection?.(projection => {
      if (projection.sessionId === sessionId && (records.get(sessionId)?.length ?? 0) > 0) {
        // Queue cancellation releases annotations even while the window stays focused.
        // Bypass read deduplication: a pre-event list may still be in flight.
        void updateMessageAnnotations({ action: 'list', sessionId }).catch(() => {});
      }
    });
    window.addEventListener('focus', refresh);
    return () => { window.removeEventListener('focus', refresh); unsubscribeQueue?.(); };
  }, [sessionId, owner]);
  return annotations;
}
