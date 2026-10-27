import { createContext, useContext, useEffect, useState } from 'react';
import type { ProviderShareReceived } from '@cindy/device-link';
import { useOptionalAuthUser } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  weeklyQuota,
  type ProviderWeeklyQuota,
} from '@/components/new-chat/useProviderWeeklyQuota';
import { providerShareIdOfAgentDeviceId } from '../../../shared/providerShare';
import type { ProviderShareInsights } from '../../../shared/providerShareInsights';
import { useProviderShareReceived } from './providerShareStore';

// Popovers may retain their children during the closing animation. Stop reads at close,
// while directly mounted model lists remain eligible for viewing.
export const ProviderShareQuotaViewingContext = createContext(true);

function shareIdentity(share: ProviderShareReceived | undefined): string {
  return share
    ? JSON.stringify([
        share.shareId,
        share.memberId,
        share.status,
        share.hostOnline,
        share.hostCapable,
      ])
    : '';
}

function readWeeklyQuota(view: ProviderShareInsights): ProviderWeeklyQuota | null {
  if (
    !view.capabilities.quota ||
    view.status.quota !== 'ready' ||
    view.quota?.group !== false ||
    view.quota.accounts.length !== 1
  )
    return null;
  const account = view.quota.accounts[0];
  if (account.state !== 'ready' || account.balance) return null;
  const window = account.windows.find(
    (item) => item.kind === 'week',
  );
  return window
    ? weeklyQuota(
        100 - window.remainingPercent,
        window.resetsAt === null ? null : window.resetsAt / 1000,
        Date.now(),
      )
    : null;
}

const RECHECK_MS = 5_000;
type Entry = {
  owner: ReturnType<typeof getDataOwnerGeneration>;
  identity: string;
  quota: ProviderWeeklyQuota | null;
  lastRead: number;
  revision: number;
  pending: Promise<void> | null;
  listeners: Set<() => void>;
  expiry: ReturnType<typeof setTimeout> | null;
};
const entries = new Map<string, Entry>();
let cacheOwner = getDataOwnerGeneration();

function clear(entry: Entry): void {
  entry.revision++;
  entry.quota = null;
  entry.pending = null;
  for (const notify of entry.listeners) notify();
}

function entryFor(shareId: string, identity: string): Entry {
  if (!isDataOwnerGenerationCurrent(cacheOwner)) {
    for (const entry of entries.values()) if (entry.expiry) clearTimeout(entry.expiry);
    entries.clear();
    cacheOwner = getDataOwnerGeneration();
  }
  const key = JSON.stringify([cacheOwner.dataOwnerId, shareId]);
  let entry = entries.get(key);
  if (!entry || entry.identity !== identity) {
    if (entry?.expiry) clearTimeout(entry.expiry);
    entry = {
      owner: cacheOwner, identity, quota: null, lastRead: -Infinity, revision: 0,
      pending: null, listeners: new Set(), expiry: null,
    };
    entries.set(key, entry);
  }
  return entry;
}

// This observer lives above the directory's changing provider-reader tree. A rail
// remount may reuse its entry, but actually closing/unmounting the picker clears it.
export function useProviderShareQuotaViewing(viewing: boolean): void {
  useEffect(() => {
    const clearUnused = () => {
      for (const entry of entries.values()) if (!entry.listeners.size) clear(entry);
    };
    const visibility = () => {
      if (document.visibilityState === 'hidden') clearUnused();
    };
    if (!viewing) clearUnused();
    document.addEventListener('visibilitychange', visibility);
    return () => {
      document.removeEventListener('visibilitychange', visibility);
      queueMicrotask(clearUnused);
    };
  }, [viewing]);
}

/** Mounted rail only: read permission + quota, never request or retain usage history. */
export function useProviderShareWeeklyQuota(deviceId: string): ProviderWeeklyQuota | null {
  useOptionalAuthUser();
  const viewing = useContext(ProviderShareQuotaViewingContext);
  const { received } = useProviderShareReceived();
  const shareId = providerShareIdOfAgentDeviceId(deviceId);
  const share = received.find((item) => item.shareId === shareId);
  const identity = shareIdentity(share);
  const available = share?.status === 'active' && share.hostOnline && share.hostCapable;
  const entry = shareId ? entryFor(shareId, identity) : null;
  const [, rerender] = useState(0);

  useEffect(() => {
    if (!entry || !shareId) return;
    if (!viewing || !available) {
      clear(entry);
      return;
    }
    let alive = true;
    let valid = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => rerender((value) => value + 1);
    entry.listeners.add(notify);
    if (entry.expiry) clearTimeout(entry.expiry);
    entry.expiry = null;
    const current = () => alive && valid && isDataOwnerGenerationCurrent(entry.owner);
    const load = () => {
      if (timer) clearTimeout(timer);
      if (!current()) return;
      if (document.visibilityState === 'hidden') { clear(entry); return; }
      const remaining = RECHECK_MS - (Date.now() - entry.lastRead);
      if (remaining > 0) {
        timer = setTimeout(load, remaining);
        return;
      }
      if (!entry.pending) {
        entry.lastRead = Date.now();
        const revision = entry.revision;
        const accept = () => entry.revision === revision &&
          isDataOwnerGenerationCurrent(entry.owner) && entry.listeners.size > 0 &&
          document.visibilityState !== 'hidden';
        const request = window.electronAPI.providerShare.command({
          action: 'insights', shareId, includeUsage: false,
        }).then((view) => {
          if (accept()) entry.quota = readWeeklyQuota(view);
        }).catch(() => {
          if (accept()) entry.quota = null;
        }).finally(() => {
          if (entry.pending === request) {
            entry.pending = null;
            entry.lastRead = Date.now();
            for (const listener of entry.listeners) listener();
          }
        });
        entry.pending = request;
      }
      void entry.pending.finally(() => {
        if (current()) {
          if (timer) clearTimeout(timer);
          timer = setTimeout(load, Math.max(0, RECHECK_MS - (Date.now() - entry.lastRead)));
        }
      });
    };
    const off = window.electronAPI.providerShare.onReceivedChanged((shares) => {
      const next = shareIdentity(shares.find((item) => item.shareId === shareId));
      if (next !== identity) {
        valid = false;
        if (timer) clearTimeout(timer);
        clear(entry);
      } else if (!valid) {
        valid = true;
        load();
      }
    });
    const visibility = () => {
      if (timer) clearTimeout(timer);
      clear(entry);
      if (document.visibilityState !== 'hidden') load();
    };
    document.addEventListener('visibilitychange', visibility);
    load();
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
      entry.listeners.delete(notify);
      if (!entry.listeners.size) {
        // Briefly bridge directory remounts; do not retain unused snapshots forever.
        entry.expiry = setTimeout(() => {
          clear(entry);
          const key = JSON.stringify([entry.owner.dataOwnerId, shareId]);
          if (entries.get(key) === entry) entries.delete(key);
        }, RECHECK_MS);
      }
    };
  }, [available, entry, identity, shareId, viewing]);

  return viewing && available && entry && isDataOwnerGenerationCurrent(entry.owner) &&
    document.visibilityState !== 'hidden' && entry.quota
    ? weeklyQuota(entry.quota.usedPercent, entry.quota.resetsAt, Date.now())
    : null;
}
