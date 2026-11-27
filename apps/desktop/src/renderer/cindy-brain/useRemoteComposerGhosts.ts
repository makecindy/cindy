import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GHOST_COMPOSER_LIST_CHANNEL,
  ghostComposerListSchema,
  MAX_COMPOSER_KNOWN_ICONS,
  type GhostComposerEntry,
  type GhostComposerListOptions,
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
 * The remote catalog used to carry every plugin icon inline (~1 MB) on every read.
 * New hosts tag each icon (`iconRef`) and skip the icons this controller reports
 * holding, so after the first read a catalog is a few KB; old hosts ignore the
 * request option and keep sending icons inline, which are used as before.
 * Icons are content-tagged, so a cached copy never goes stale.
 */
const MAX_CACHED_ICONS = 256;
const iconsByRef = new Map<string, string>();
/** Icon tags each host's latest catalog referenced; reported back as already held. */
const iconRefsByDevice = new Map<string, string[]>();

function rememberIcon(ref: string, dataUrl: string): void {
  iconsByRef.delete(ref);
  iconsByRef.set(ref, dataUrl);
  while (iconsByRef.size > MAX_CACHED_ICONS) iconsByRef.delete(iconsByRef.keys().next().value!);
}

function catalogOptions(deviceId: string): GhostComposerListOptions {
  const knownIcons = (iconRefsByDevice.get(deviceId) ?? [])
    .filter((ref) => iconsByRef.has(ref))
    .slice(0, MAX_COMPOSER_KNOWN_ICONS);
  return { iconRefs: 1, ...(knownIcons.length ? { knownIcons } : {}) };
}

/** Fills omitted icons from the cache; an icon the host could not fit stays generic. */
function resolveCatalogIcons(deviceId: string, ghosts: GhostComposerEntry[]): GhostComposerEntry[] {
  const refs: string[] = [];
  const resolved = ghosts.map((entry) => {
    if (!entry.iconRef) return entry;
    refs.push(entry.iconRef);
    if (entry.iconDataUrl) {
      rememberIcon(entry.iconRef, entry.iconDataUrl);
      return entry;
    }
    const cached = iconsByRef.get(entry.iconRef);
    return cached ? { ...entry, iconDataUrl: cached } : entry;
  });
  iconRefsByDevice.set(deviceId, [...new Set(refs)]);
  return resolved;
}

/**
 * Every remote composer mount used to read the catalog again (twice: the mount and
 * its first "connected" epoch).
 * Composers share one copy per device and directory. Mounting reuses a copy younger
 * than CATALOG_REUSE_MS; opening the menu or reconnecting re-reads one older than
 * CATALOG_SOFT_REFRESH_MS; a host plugin change ("plugins" push) or a retry always
 * re-reads.
 */
const CATALOG_REUSE_MS = 5 * 60_000;
const CATALOG_SOFT_REFRESH_MS = 60_000;
const MAX_CACHED_CATALOGS = 8;

const catalogs = new Map<string, { ghosts: GhostComposerEntry[]; at: number }>();
const inflight = new Map<string, { generation: number; request: Promise<GhostComposerEntry[]> }>();
/** Bumped by a host plugin change; reads started before it neither return nor cache. */
const deviceGenerations = new Map<string, number>();
const invalidationListeners = new Set<(deviceId: string) => void>();
let invalidationInstalled = false;
const STALE_CATALOG = new Error('Stale remote plugin catalog');

/**
 * One listener for the cache's lifetime, not per composer: a copy kept after its
 * composer unmounted must still be dropped when that computer's plugins change.
 */
function ensureInvalidationListener(): void {
  if (invalidationInstalled) return;
  const subscribe = window.electronAPI.deviceLink.onRemotePush;
  if (!subscribe) return;
  invalidationInstalled = true;
  subscribe((push, stamp) => {
    if (
      push.channel !== REMOTE_RESOURCE_CHANGED_CHANNEL ||
      !isDeviceLinkRemotePushCurrent(push, stamp) ||
      (push.payload as { collectionId?: unknown } | null)?.collectionId !== PLUGIN_COLLECTION
    )
      return;
    deviceGenerations.set(push.deviceId, (deviceGenerations.get(push.deviceId) ?? 0) + 1);
    // Every directory's copy for this device is stale.
    for (const cachedKey of [...catalogs.keys()]) {
      if ((JSON.parse(cachedKey) as unknown[])[2] === push.deviceId) catalogs.delete(cachedKey);
    }
    for (const listener of invalidationListeners) listener(push.deviceId);
  });
}

function loadCatalog(key: string, deviceId: string, workingDir: string | null | undefined) {
  const generation = deviceGenerations.get(deviceId) ?? 0;
  const pending = inflight.get(key);
  if (pending?.generation === generation) return pending.request;
  const capturedOwner = getDataOwnerGeneration();
  const request = window.electronAPI.deviceLink
    .invoke(deviceId, GHOST_COMPOSER_LIST_CHANNEL, [workingDir ?? '', catalogOptions(deviceId)])
    .then((raw) => {
      const result = ghostComposerListSchema.safeParse(raw);
      if (!result.success) throw new Error('Invalid remote plugin catalog');
      // A plugin change after this read started: a newer read replaces it.
      if ((deviceGenerations.get(deviceId) ?? 0) !== generation) throw STALE_CATALOG;
      if (!isDataOwnerGenerationCurrent(capturedOwner)) return result.data;
      const ghosts = resolveCatalogIcons(deviceId, result.data);
      catalogs.delete(key);
      catalogs.set(key, { ghosts, at: Date.now() });
      while (catalogs.size > MAX_CACHED_CATALOGS) catalogs.delete(catalogs.keys().next().value!);
      return ghosts;
    })
    .finally(() => {
      if (inflight.get(key)?.request === request) inflight.delete(key);
    });
  inflight.set(key, { generation, request });
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
    ensureInvalidationListener();
    const listener = (changed: string) => {
      if (changed === deviceId) reload();
    };
    invalidationListeners.add(listener);
    return () => {
      invalidationListeners.delete(listener);
    };
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
      .catch((error: unknown) => {
        // The plugin change that made it stale already started a fresh read.
        if (error === STALE_CATALOG) return;
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
