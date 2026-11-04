import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GHOST_COMPOSER_LIST_CHANNEL,
  ghostComposerListSchema,
  type GhostComposerEntry,
} from '../../shared/ghostComposer';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { isDeviceLinkRemotePushCurrent } from '@/lib/remoteDataOwnerPushFence';
import {
  isSharedTaskPeer,
  PLUGIN_COLLECTION,
  REMOTE_RESOURCE_CHANGED_CHANNEL,
} from '@cindy/device-link';

const EMPTY: GhostComposerEntry[] = [];

/**
 * The remote catalog carries plugin icons and reaches ~1 MB, and every remote composer
 * mount used to read it again (twice: the mount and its first "connected" epoch).
 * Composers share one copy per device and directory. Mounting reuses a copy younger
 * than CATALOG_REUSE_MS; opening the menu or reconnecting re-reads one older than
 * CATALOG_SOFT_REFRESH_MS; a host plugin change ("plugins" push) or a retry always
 * re-reads.
 */
const CATALOG_REUSE_MS = 5 * 60_000;
const CATALOG_SOFT_REFRESH_MS = 60_000;
const MAX_CACHED_CATALOGS = 8;

const catalogs = new Map<string, { ghosts: GhostComposerEntry[]; at: number }>();
const inflight = new Map<string, Promise<GhostComposerEntry[]>>();

function loadCatalog(key: string, deviceId: string, workingDir: string | null | undefined) {
  const pending = inflight.get(key);
  if (pending) return pending;
  const capturedOwner = getDataOwnerGeneration();
  const request = window.electronAPI.deviceLink
    .invoke(deviceId, GHOST_COMPOSER_LIST_CHANNEL, workingDir ? [workingDir] : [])
    .then((raw) => {
      const result = ghostComposerListSchema.safeParse(raw);
      if (!result.success) throw new Error('Invalid remote plugin catalog');
      if (isDataOwnerGenerationCurrent(capturedOwner)) {
        catalogs.delete(key);
        catalogs.set(key, { ghosts: result.data, at: Date.now() });
        while (catalogs.size > MAX_CACHED_CATALOGS) catalogs.delete(catalogs.keys().next().value!);
      }
      return result.data;
    })
    .finally(() => inflight.delete(key));
  inflight.set(key, request);
  return request;
}

/** Async device/workdir-scoped catalog; opening the menu never awaits this read. */
export function useRemoteComposerGhosts(
  deviceId: string | null | undefined,
  workingDir: string | null | undefined,
  menuOpen: boolean,
  reconnectEpoch: number,
) {
  const owner = getDataOwnerGeneration();
  const key = JSON.stringify([owner.dataOwnerId, owner.generation, deviceId, workingDir ?? '']);
  const currentKey = useRef(key);
  currentKey.current = key;
  const [snapshot, setSnapshot] = useState<{
    key: string;
    ghosts: GhostComposerEntry[];
    failed: boolean;
  }>();
  // `force` re-reads regardless of age (retry, host plugin change); otherwise a menu
  // open only re-reads a copy older than CATALOG_SOFT_REFRESH_MS.
  const [refresh, setRefresh] = useState({ count: 0, force: false });
  const reload = useCallback(() => setRefresh((value) => ({ count: value.count + 1, force: true })), []);

  const wasMenuOpen = useRef(menuOpen);
  useEffect(() => {
    if (menuOpen && !wasMenuOpen.current) {
      setRefresh((value) => ({ count: value.count + 1, force: false }));
    }
    wasMenuOpen.current = menuOpen;
  }, [menuOpen]);

  useEffect(() => {
    if (!deviceId || isSharedTaskPeer(deviceId)) return undefined;
    return window.electronAPI.deviceLink.onRemotePush?.((push, stamp) => {
      if (
        push.deviceId === deviceId &&
        push.channel === REMOTE_RESOURCE_CHANGED_CHANNEL &&
        isDeviceLinkRemotePushCurrent(push, stamp) &&
        (push.payload as { collectionId?: unknown } | null)?.collectionId === PLUGIN_COLLECTION
      ) {
        // Every directory's copy for this device is stale.
        for (const cachedKey of [...catalogs.keys()]) {
          if ((JSON.parse(cachedKey) as unknown[])[2] === deviceId) catalogs.delete(cachedKey);
        }
        reload();
      }
    });
  }, [deviceId, reload]);

  const lastKey = useRef<string | null>(null);
  const handledRefresh = useRef(0);
  useEffect(() => {
    if (!deviceId || isSharedTaskPeer(deviceId)) return;
    let cancelled = false;
    const capturedOwner = getDataOwnerGeneration();
    const current = () =>
      !cancelled && currentKey.current === key && isDataOwnerGenerationCurrent(capturedOwner);
    const mounted = lastKey.current !== key;
    lastKey.current = key;
    const force = refresh.force && handledRefresh.current !== refresh.count;
    handledRefresh.current = refresh.count;
    const cached = catalogs.get(key);
    if (cached) setSnapshot({ key, ghosts: cached.ghosts, failed: false });
    const age = cached ? Date.now() - cached.at : Infinity;
    const fresh = !force && age < (mounted ? CATALOG_REUSE_MS : CATALOG_SOFT_REFRESH_MS);
    if (fresh) return;
    void loadCatalog(key, deviceId, workingDir)
      .then((ghosts) => {
        if (current()) setSnapshot({ key, ghosts, failed: false });
      })
      .catch(() => {
        // Old hosts may reject the channel. Never substitute the controller's catalog.
        if (current()) setSnapshot({ key, ghosts: EMPTY, failed: true });
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, workingDir, key, reconnectEpoch, refresh]);

  return {
    ghosts: snapshot?.key === key ? snapshot.ghosts : (catalogs.get(key)?.ghosts ?? EMPTY),
    failed: snapshot?.key === key && snapshot.failed,
    reload,
  };
}
