import { useEffect, useState } from 'react';
import { useAuth } from '@/contexts/AuthContext';
import { isDataOwnerPushStampCurrent } from '@/contexts/dataOwnerGeneration';
import type { AuxiliaryModelHealthEvent } from '../../shared/auxiliaryModelHealth';

const routeKey = (row: AuxiliaryModelHealthEvent) => row.auxiliaryRef ?? JSON.stringify([row.providerId, row.model]);
const sameError = (a: AuxiliaryModelHealthEvent, b: AuxiliaryModelHealthEvent) =>
  a.errorRevision === b.errorRevision && a.lastErrorAt === b.lastErrorAt && a.httpStatus === b.httpStatus;

/** Conversation pushes invalidate a view. Only the current main-process snapshot may raise a notice. */
function subscribeToConversation(
  sessionId: string,
  publish: (rows: AuxiliaryModelHealthEvent[]) => void,
  onChange?: (event: AuxiliaryModelHealthEvent) => void,
) {
  const api = window.electronAPI?.maker;
  let disposed = false;
  let revision = 0;
  let reading = false;
  const live = new Map<string, AuxiliaryModelHealthEvent>();
  const notices = new Map<string, AuxiliaryModelHealthEvent>();
  const refresh = async () => {
    revision++;
    if (reading || !api?.auxiliaryModelRouteHealthGet) return;
    reading = true;
    try {
      while (!disposed) {
        const expected = revision;
        const snapshot = await api.auxiliaryModelRouteHealthGet(sessionId);
        if (disposed) return;
        if (expected !== revision) continue;
        live.clear();
        for (const row of snapshot) {
          if (row.sessionId !== sessionId || !isDataOwnerPushStampCurrent(row.ownerStamp)) continue;
          const key = routeKey(row);
          live.set(key, row);
          const event = notices.get(key);
          if (event && event.status === row.status && event.noticeId === row.noticeId && event.operation === row.operation && sameError(event, row) &&
            event.ownerStamp.ownerGeneration === row.ownerStamp.ownerGeneration) {
            onChange?.({ ...row, notify: event.notify });
          }
        }
        notices.clear();
        publish([...live.values()]);
        break;
      }
    } catch { /* Leave the last confirmed view until another invalidation. */ }
    finally { reading = false; }
  };
  publish([]);
  const off = api?.onAuxiliaryModelHealthChanged?.(event => {
    if (disposed || !isDataOwnerPushStampCurrent(event.ownerStamp)) return;
    const key = routeKey(event);
    if (event.conversationOnly && event.sessionId && event.sessionId !== sessionId) return;
    if (event.removed) {
      live.delete(key);
      notices.delete(key);
      onChange?.(event);
      publish([...live.values()]);
      if (reading) void refresh();
      return;
    }
    if (event.sessionId !== sessionId && !(event.status === 'recovered' && (reading || live.has(key)))) return;
    if (event.sessionId === sessionId && (event.notify || event.status === 'recovered')) notices.set(key, event);
    void refresh();
  });
  void refresh();
  return () => { disposed = true; off?.(); };
}

/** Pushes carry only statistics. Read private details once per error in this view's scope. */
export function useAuxiliaryRouteHealth(onChange?: (event: AuxiliaryModelHealthEvent) => void, sessionId?: string) {
  const { dataOwnerId, dataOwnerGeneration } = useAuth();
  const [rows, setRows] = useState<AuxiliaryModelHealthEvent[]>([]);
  useEffect(() => {
    if (sessionId !== undefined) return subscribeToConversation(sessionId, setRows, onChange);
    const api = window.electronAPI?.maker;
    const current = new Map<string, AuxiliaryModelHealthEvent>();
    const changed = new Set<string>();
    let initial = true;
    let disposed = false;
    let reading = false;
    let pending = false;
    const publish = () => setRows([...current.values()].sort((a, b) => b.lastErrorAt - a.lastErrorAt));
    const refresh = async () => {
      if (reading) { pending = true; return; }
      if (!api?.auxiliaryModelRouteHealthGet) return;
      reading = true;
      try {
        const snapshot = await api.auxiliaryModelRouteHealthGet(sessionId);
        if (disposed) return;
        for (const row of snapshot) {
          if (!isDataOwnerPushStampCurrent(row.ownerStamp)) continue;
          const key = routeKey(row);
          const latest = current.get(key);
          if (initial && !changed.has(key)) current.set(key, row);
          else if (latest && sameError(latest, row)) current.set(key, { ...latest, upstreamMessage: row.upstreamMessage });
        }
        publish();
      } catch { /* A live summary remains usable if its private detail cannot be read. */ }
      finally {
        initial = false;
        changed.clear();
        reading = false;
        if (pending && !disposed) { pending = false; void refresh(); }
      }
    };
    setRows([]);
    const off = api?.onAuxiliaryModelHealthChanged?.(row => {
      if (disposed || !isDataOwnerPushStampCurrent(row.ownerStamp)) return;
      const key = routeKey(row);
      const previous = current.get(key);
      if (row.conversationOnly) return;
      if (initial) changed.add(key);
      const visible = !row.removed;
      if (visible) {
        const reuse = previous && sameError(previous, row);
        current.set(key, reuse ? { ...row, upstreamMessage: previous.upstreamMessage } : row);
        if (!reuse && row.httpStatus) void refresh();
      } else current.delete(key);
      publish();
      onChange?.(row);
    });
    void refresh();
    return () => { disposed = true; off?.(); };
  }, [dataOwnerId, dataOwnerGeneration, onChange, sessionId]);
  return rows.filter(row => isDataOwnerPushStampCurrent(row.ownerStamp));
}
