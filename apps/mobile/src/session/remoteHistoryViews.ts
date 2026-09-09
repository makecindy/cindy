import { HistoryViewController, isHistoryViewUnavailable } from '@cindy/maker-shared/message-window';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import type { RemoteMessage } from './types';
import { clearHistoryDisk, historyDiskAuthority, readHistoryDisk, writeHistoryDisk } from './remoteHistoryDiskCache';
import { historyValueBytes } from './historyDiskStore';

// Retain only recently visited views in memory. The existing account/device and
// session reclamation boundaries own invalidation. Older views remain in the disk LRU.
export const MAX_INACTIVE_HISTORY_VIEWS = 8;
const MAX_INACTIVE_HISTORY_BYTES = 4 * 1024 * 1024;
type Reader = Pick<MobileMakerTransport, 'readHistoryView' | 'readWorkDetails' | 'setHistoryExpanded'>;
type Entry = { deviceId: string; sessionId: string; reader: Reader;
  view: HistoryViewController<RemoteMessage>; consumers: number; bytes: number };
const views = new Map<string, Entry>();
const keyFor = (deviceId: string, sessionId: string) => JSON.stringify([deviceId, sessionId]);

export function findRemoteHistoryView(deviceId: string, sessionId: string) {
  return views.get(keyFor(deviceId, sessionId))?.view;
}

export function getRemoteHistoryView(deviceId: string, sessionId: string, reader: Reader): Entry {
  const key = keyFor(deviceId, sessionId);
  const existing = views.get(key);
  if (existing) return existing;
  const entry: Entry = { deviceId, sessionId, reader, consumers: 0, bytes: 0,
    view: new HistoryViewController<RemoteMessage>({
      page: (before) => entry.reader.readHistoryView(sessionId, before),
      details: (ref, after) => entry.reader.readWorkDetails(sessionId, ref, after),
      expanded: (refs) => entry.reader.setHistoryExpanded(sessionId, refs),
    }) };
  return entry;
}

export function mountRemoteHistoryView(entry: Entry, reader: Reader, active: boolean) {
  // Register only after React commits. An abandoned render must not retain a
  // controller or replace the transport used by the currently visible page.
  views.set(keyFor(entry.deviceId, entry.sessionId), entry);
  entry.reader = reader;
  entry.consumers++;
  const authority = historyDiskAuthority(entry.deviceId, entry.sessionId);
  let writeAuthority = authority;
  let pendingSnapshot = entry.view.getSnapshot();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const persist = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    void writeHistoryDisk(writeAuthority, pendingSnapshot);
  };
  const onSnapshot = () => {
    if (timer) clearTimeout(timer);
    const snapshot = entry.view.getSnapshot();
    if (!snapshot.ready) pendingSnapshot = snapshot;
    if (!authority.ownerCurrent()) return;
    if (isHistoryViewUnavailable(snapshot.error)) {
      void clearHistoryDisk(entry.deviceId, entry.sessionId);
      return;
    }
    if (!snapshot.ready || snapshot.loading || snapshot.error) return;
    pendingSnapshot = snapshot;
    // A new authoritative snapshot after rewind gets new write authority. Old timers/unmounts
    // keep their old authority and cannot repopulate a cleared snapshot.
    writeAuthority = historyDiskAuthority(entry.deviceId, entry.sessionId);
    if (!entry.view.isActive()) { persist(); return; }
    timer = setTimeout(persist, 1200);
  };
  const unsubscribe = entry.view.subscribe(onSnapshot);
  // Retire an existing downgrade before activation can clear its error for a retry.
  onSnapshot();
  entry.view.setActive(active);
  void entry.view.restoreCachedView(() => readHistoryDisk(authority));
  return () => {
    unsubscribe();
    persist();
    if (--entry.consumers > 0) return;
    entry.view.setActive(false);
    const key = keyFor(entry.deviceId, entry.sessionId);
    if (views.get(key) !== entry) return;
    const snapshot = entry.view.getSnapshot();
    // Bound accounting work before allocating a serialization of large details.
    entry.bytes = Math.min(MAX_INACTIVE_HISTORY_BYTES + 1,
      2 * historyValueBytes([snapshot.items, snapshot.details, snapshot.expanded], MAX_INACTIVE_HISTORY_BYTES));
    views.delete(key);
    views.set(key, entry);
    let count = 0;
    let bytes = 0;
    for (const candidate of views.values()) {
      if (!candidate.consumers) { count++; bytes += candidate.bytes; }
    }
    for (const [candidateKey, candidate] of views) {
      if (count <= MAX_INACTIVE_HISTORY_VIEWS && bytes <= MAX_INACTIVE_HISTORY_BYTES) break;
      if (candidate.consumers) continue;
      views.delete(candidateKey);
      count--; bytes -= candidate.bytes;
    }
  };
}

/** Hard boundaries also invalidate reads already held by mounted consumers. */
export function resetRemoteHistoryViews(deviceId: string | undefined, sessionId: string): void {
  for (const entry of views.values()) {
    if (entry.sessionId === sessionId && (deviceId === undefined || entry.deviceId === deviceId)) entry.view.reset();
  }
}

export function clearRemoteHistoryViews(deviceId?: string, sessionId?: string): void {
  for (const [key, entry] of views) {
    if (deviceId !== undefined && entry.deviceId !== deviceId) continue;
    if (sessionId !== undefined && entry.sessionId !== sessionId) continue;
    // A blurred screen may remain mounted. Keep its registration so later focus
    // and ingress address the same (now empty) controller.
    if (!entry.consumers) views.delete(key);
    entry.view.setActive(false);
    entry.view.reset();
  }
}
