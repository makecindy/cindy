import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { AppState } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useAuth } from "@/auth/AuthContext";
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from "@/auth/authOwnerGeneration";
import { useDeviceLink } from "@/device-link/DeviceLinkContext";
import type { RemoteResourceHostTarget } from "@/device-link/remoteResources";
import { createPluginManagementClient, pluginManagementErrorCode, type PluginManagementClient } from "./pluginManagementClient";
import {
  marketItemMatchesPlugin, samePluginMarketSourceIdentity, type ManagedMarketDetail, type ManagedMarketItem,
} from "./pluginManagementTypes";
import {
  PLUGIN_MARKET_QUERY_MAX, pluginMarketErrorKey, pluginMarketMatchesFilter, pluginMarketOrganizationErrorKey,
  pluginMarketRequest, pluginMarketSourceUnverified, type PluginMarketCounts, type PluginMarketFilter, type PluginMarketPage,
} from "./pluginMarketCatalog";
import { usePluginManagement } from "./usePluginManagement";
import type { PluginManagementState } from "./pluginManagementController";

/** Same freshness window as the computer's market browser; pull-to-refresh always re-reads. */
const MARKET_REFRESH_MS = 30_000;
const CACHED_LISTS = 6;
const SEARCH_DEBOUNCE_MS = 300;
/** Plugin change notifications from one computer often come in a burst (install, enable, readback): read once after. */
const PLUGIN_CHANGE_COALESCE_MS = 500;
/** Publisher tabs filter public pages locally; bound how many empty pages one view may chain. */
const MAX_EMPTY_CHAIN = 3;

export type PluginMarketStatus = "noComputer" | "offline" | "loading" | "outdated" | "failed" | "ready";
export type PluginMarketRowState =
  | { kind: "idle" }
  | { kind: "waiting" }
  | { kind: "installing" }
  | { kind: "unknown" }
  | { kind: "failed"; messageKey: string }
  | { kind: "conflict" }
  /** Custom market on an older Host that does not name the repository: install on the computer instead. */
  | { kind: "sourceUnverified" }
  | { kind: "installed" };
interface CatalogList {
  key: string;
  /** The computer these rows describe; an install on one computer never edits another's list. */
  deviceId: string;
  /** Read generation: a reply lands only if no install invalidated this list after the read started. */
  token: number;
  status: "loading" | "ready" | "failed";
  items: ManagedMarketItem[];
  nextCursor: string | null;
  loadingMore: boolean;
  meta: Omit<PluginMarketPage, "items" | "nextCursor" | "counts"> | null;
  at: number;
}
interface CountsEntry { key: string; deviceId: string; counts: PluginMarketCounts | null; customSourceNames: string[]; at: number }
interface InstallAttempt {
  id: number;
  target: RemoteResourceHostTarget;
  item: ManagedMarketItem;
  detail?: ManagedMarketDetail;
  started: boolean;
  confirmed: boolean;

}
export interface PluginMarketDetailState {
  item: ManagedMarketItem;
  target: RemoteResourceHostTarget;
  detail?: ManagedMarketDetail;
  loading: boolean;
  failed: boolean;
}
export interface UsePluginMarketOptions {
  /** The market list or search results are visible on the focused screen. */
  visible: boolean;
  focused: boolean;
  targets: readonly RemoteResourceHostTarget[];
  isOnline(target: RemoteResourceHostTarget): boolean;
  /** Installed-tab computer filter; empty means all computers. */
  installedDeviceId: string;
  query: string;
  /** Another management write on this screen (e.g. an update) owns the consent sheet; new installs wait. */
  blocked?: boolean;
  /** Called once per successful install; instanceKey is absent only if the Host readback failed. */
  onInstalled(target: RemoteResourceHostTarget, instanceKey: string | undefined, item: ManagedMarketItem): void;
}

function useDebounced(value: string, delay: number) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    if (!value.trim()) { setDebounced(value); return; }
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);
  return debounced;
}

/**
 * Browse one computer's market page by page and install through the existing
 * management controller. Every read and write is fenced by account owner,
 * target computer and connection generation; nothing is replayed.
 */
export function usePluginMarket(options: UsePluginMarketOptions) {
  const { invoke, connectionEpoch, onRemoteResourceChanged } = useDeviceLink();
  const { accountGeneration } = useAuth();
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const owner = useRef(getMobileAuthOwner()).current;
  const storageKey = `cindy.pluginMarketDevice.v1.${owner.accountKey}`;
  const { targets, isOnline, installedDeviceId, visible, focused } = options;
  const onInstalled = useRef(options.onInstalled);
  onInstalled.current = options.onInstalled;

  // ---- Install attempt (declared first: it pins the market to the installing computer).
  const [install, setInstall] = useState<InstallAttempt | null>(null);
  const installRef = useRef(install);
  installRef.current = install;
  const attemptId = useRef(0);
  /** Failure notes per computer + plugin; the same market plugin can exist on several computers. */
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const errorKey = (deviceId: string, pluginId: string) => JSON.stringify([deviceId, pluginId]);

  // ---- Target computer. Explicit choices win and never change by themselves: this visit's market
  // choice, then the Installed tab's specific computer (both shown as "not connected" when offline).
  // Otherwise pick automatically: the remembered market computer if online, else an online computer,
  // else the remembered or first one. The automatic pick is fixed for this market visit once a computer
  // is known online, so presence changes while browsing never move the list; the next visit re-picks.
  // An install keeps the market on the installing computer until it ends.
  const [choice, setChoice] = useState<string>();
  const [remembered, setRemembered] = useState<string>();
  const [pinned, setPinned] = useState<string>();
  /** The automatic pick waits for the stored preference, so a slow read cannot pin another computer first. */
  const [preferenceRead, setPreferenceRead] = useState(false);
  useEffect(() => {
    let disposed = false;
    void AsyncStorage.getItem(storageKey).then((value) => {
      if (!disposed && isMobileAuthOwnerCurrent(owner) && typeof value === "string" && value.length <= 256) setRemembered(value);
    }).catch(() => { /* Optional local preference. */ }).finally(() => { if (!disposed) setPreferenceRead(true); });
    return () => { disposed = true; };
  }, [storageKey, owner]);
  useEffect(() => { if (installedDeviceId) setChoice(undefined); }, [installedDeviceId]);
  const has = (id: string | undefined) => !!id && targets.some((host) => host.deviceId === id);
  const onlineId = (id: string | undefined) => {
    const host = id ? targets.find((candidate) => candidate.deviceId === id) : undefined;
    return !!host && isOnline(host);
  };
  const autoPick = onlineId(remembered) ? remembered : targets.find((host) => isOnline(host))?.deviceId;
  useEffect(() => { if (!visible) setPinned(undefined); }, [visible]);
  useEffect(() => { if (visible && preferenceRead && !has(pinned) && autoPick) setPinned(autoPick); }, [visible, preferenceRead, pinned, autoPick, targets]);
  const automatic = has(pinned) ? pinned! : autoPick ?? (has(remembered) ? remembered! : targets[0]?.deviceId);
  const explicit = install ? install.target.deviceId : has(choice) ? choice! : has(installedDeviceId) ? installedDeviceId : undefined;
  // Until the preference is read, an automatic pick has no computer yet (the market shows loading, reads nothing).
  const deviceId = explicit ?? (preferenceRead ? automatic : undefined);
  const target = install ? install.target : targets.find((host) => host.deviceId === deviceId);
  const online = !!target && isOnline(target);

  const selectDevice = useCallback((id: string) => {
    if (installRef.current || !targets.some((host) => host.deviceId === id)) return;
    setChoice(id);
    setRemembered(id);
    if (isMobileAuthOwnerCurrent(owner)) void AsyncStorage.setItem(storageKey, id).catch(() => {});
  }, [targets, owner, storageKey]);

  // ---- Read scope: a late reply from another computer, account or connection never lands here.
  const scope = JSON.stringify([deviceId ?? "", accountGeneration, connectionEpoch]);
  const liveScope = useRef(scope);
  liveScope.current = scope;
  // Refs keep their last render's values after unmount; this flag fences sends, replies and follow-up pages.
  // Reset on mount so a development remount (effects run twice) keeps working.
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const activeRef = useRef(false);
  // In the background the route stays focused and the computer stays online for Device Link's exit grace period,
  // but nobody sees the market: queued reads and automatic follow-up pages stop, and resume in the foreground.
  // The ref closes the fence as soon as the app leaves the foreground, before the next render.
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const foregroundRef = useRef(foreground);
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      foregroundRef.current = next === "active";
      setForeground(next === "active");
    });
    return () => subscription.remove();
  }, []);
  /**
   * The one send fence for every market read (probe, pages, counts, detail): the plugins page is mounted and
   * the market is shown on a focused, online computer while the app is in the foreground. The client re-checks
   * it right before a queued request leaves, so nothing queued before unmount, leaving the market or going to
   * the background goes out on the shared link.
   */
  const readsOpen = () => mounted.current && activeRef.current && foregroundRef.current;
  const client = useMemo<PluginManagementClient | null>(() => deviceId
    ? createPluginManagementClient({ invoke, deviceId, isCurrent: () => readsOpen() && liveScope.current === scope })
    : null, [deviceId, invoke, scope]);
  const active = visible && focused && online && foreground && !!client;
  activeRef.current = active;

  const [probe, setProbe] = useState<{ scope: string; status: "loading" | "supported" | "outdated" | "failed" }>();
  // Only the newest probe lands: leaving a computer and coming back starts another probe for the same scope,
  // and the older one must not overwrite its result when it finishes (or times out) later.
  const probeGeneration = useRef(0);
  const readProbe = useCallback(async () => {
    if (!client) return;
    const probeScope = scope, generation = ++probeGeneration.current;
    const latest = () => mounted.current && probeGeneration.current === generation && liveScope.current === probeScope;
    setProbe({ scope: probeScope, status: "loading" });
    try {
      const status = (await client.capability(latest)) === "unsupported" ? "outdated"
        : (await client.catalogPaging(latest)) ? "supported" : "outdated";
      if (latest()) setProbe({ scope: probeScope, status });
    } catch {
      if (latest()) setProbe({ scope: probeScope, status: "failed" });
    }
  }, [client, scope]);
  // Leaving the market cancels an in-flight probe (its sends are fenced anyway); forget its "loading" so coming
  // back to the same computer probes again. A finished result (supported, outdated, failed) is kept.
  useEffect(() => {
    if (active) return;
    probeGeneration.current += 1;
    setProbe((current) => current?.status === "loading" ? undefined : current);
  }, [active]);
  useEffect(() => {
    if (active && probe?.scope !== scope) void readProbe();
  }, [active, scope, probe?.scope, readProbe]);
  const probeStatus = probe?.scope === scope ? probe.status : "loading";
  // An older Host rejects every non-empty snapshot input. If a catalog read says so after the probe
  // passed (e.g. the computer's Cindy changed), probe again — at most once per scope, so a request the
  // Host keeps rejecting (an expired cursor) cannot loop between probe and read.
  const reprobed = useRef<string | undefined>(undefined);
  const reprobe = useCallback((error: unknown, readScope: string) => {
    if (pluginManagementErrorCode(error) !== "INVALID_PARAMS" || liveScope.current !== readScope
      || reprobed.current === readScope) return;
    reprobed.current = readScope;
    void readProbe();
  }, [readProbe]);

  // ---- Lists: one bounded LRU of cursor lists, keyed by scope + source + query.
  const [filter, setFilterState] = useState<PluginMarketFilter>("official");
  const debouncedQuery = useDebounced(options.query, SEARCH_DEBOUNCE_MS).trim().slice(0, PLUGIN_MARKET_QUERY_MAX);
  const searching = !!options.query.trim();
  const request = pluginMarketRequest(filter, debouncedQuery);
  const listKey = JSON.stringify([scope, request.scope, debouncedQuery]);
  const countsKey = JSON.stringify([scope, debouncedQuery]);
  const liveListKey = useRef(listKey);
  liveListKey.current = listKey;
  const liveCountsKey = useRef(countsKey);
  liveCountsKey.current = countsKey;
  // Official and community share the public list; a follow-up page must still serve the filter and the
  // typed (not yet debounced) search the person is looking at now.
  const liveFilter = useRef(filter);
  liveFilter.current = filter;
  const liveQuery = useRef("");
  liveQuery.current = options.query.trim().slice(0, PLUGIN_MARKET_QUERY_MAX);
  /**
   * The one gate for asking for a next page (automatic chain and scroll "load more"): the page is mounted,
   * the market is shown, this is still the cached list on screen, and the typed search equals the settled
   * one. The automatic chain also needs the source filter it judged the page by (official and community
   * share one public list).
   */
  const followUpAllowed = (list: CatalogList, query: string, publisher?: PluginMarketFilter) => readsOpen()
    && lists.current.get(list.key) === list && sameView(liveListKey, list.key, query)
    && (publisher === undefined || liveFilter.current === publisher);
  /**
   * Every list and count read (first page, next pages, counts) is checked against the view it was made for when it
   * leaves the queue and when it lands: its key is still the one on screen and the typed search equals the one it
   * was read with. A search typed while a request waits in the Device Link queue cancels it.
   */
  const sameView = (live: { current: string }, key: string, query: string) => live.current === key && liveQuery.current === query;
  /** A search shows every source, so its pages are judged against "all", not the hidden source filter. */
  const publisher: PluginMarketFilter = debouncedQuery ? "all" : filter;
  const lists = useRef(new Map<string, CatalogList>());
  const counts = useRef(new Map<string, CountsEntry>());
  const chain = useRef(0);
  const remember = <T,>(map: Map<string, T>, key: string, value: T) => {
    map.delete(key); map.set(key, value);
    while (map.size > CACHED_LISTS) map.delete(map.keys().next().value!);
  };
  const readPage = useCallback(async (list: CatalogList, cursor: string | null, publisher: PluginMarketFilter, token = list.token, chained = false) => {
    if (!client) return;
    const readScope = scope;
    const current = () => mounted.current && liveScope.current === readScope && lists.current.get(list.key) === list
      && list.token === token;
    // A reply dropped because the view moved to another computer or connection leaves no request in
    // charge of this entry. Release it so returning here reads again instead of waiting forever.
    const abandon = () => {
      if (lists.current.get(list.key) !== list || list.token !== token) return;
      if (cursor) list.loadingMore = false;
      else if (list.status === "loading") { list.status = list.items.length ? "ready" : "failed"; list.at = 0; }
    };
    try {
      // This request's ticket, re-checked when it leaves the queue and when it lands: a next page still has to
      // serve the list and typed search on screen (and, when chained, the source filter it was judged by).
      const ticket = () => current() && (cursor ? followUpAllowed(list, debouncedQuery, chained ? publisher : undefined)
        : sameView(liveListKey, list.key, debouncedQuery));
      const page = await client.catalog({ query: debouncedQuery, scope: request.scope, cursor, limit: request.limit,
        excludeInstalled: true, counts: false }, ticket);
      if (!current()) { abandon(); return; }
      // A first-page read replaces the list; only later pages are de-duplicated against it.
      const known = new Set(cursor ? list.items.map((item) => item.pluginId) : []);
      const fresh = page.items.filter((item) => !known.has(item.pluginId) && item.installState !== "installed"
        && item.installState !== "update-available");
      list.items = cursor ? [...list.items, ...fresh] : fresh;
      list.nextCursor = page.nextCursor;
      list.meta = { unavailableReason: page.unavailableReason, customSourceNames: page.customSourceNames,
        organizationAccessError: page.organizationAccessError,
        unavailableCustomSourceNames: cursor && list.meta
          ? [...new Set([...list.meta.unavailableCustomSourceNames, ...page.unavailableCustomSourceNames])]
          : page.unavailableCustomSourceNames };
      list.status = "ready"; list.loadingMore = false; list.at = Date.now();
      rerender();
      // A publisher tab may find nothing on a public page; continue a few pages, never unbounded.
      const contributed = fresh.filter((item) => pluginMarketMatchesFilter(item, publisher)).length;
      if (page.nextCursor && contributed === 0 && (publisher === "official" || publisher === "community")
        && chain.current < MAX_EMPTY_CHAIN && followUpAllowed(list, debouncedQuery, publisher)) {
        chain.current += 1;
        list.loadingMore = true;
        await readPage(list, page.nextCursor, publisher, token, true);
      } else chain.current = 0;
    } catch (error) {
      // Dropped because the view moved on (another computer, list or search): release it, it is not a failure.
      if (!current() || !(cursor ? followUpAllowed(list, debouncedQuery) : sameView(liveListKey, list.key, debouncedQuery))) {
        abandon();
        return;
      }
      if (cursor) list.loadingMore = false; else list.status = "failed";
      chain.current = 0;
      rerender();
      reprobe(error, readScope);
    }
  }, [client, scope, debouncedQuery, request.scope, request.limit, reprobe]);
  const startList = useCallback((force: boolean) => {
    const existing = lists.current.get(listKey);
    if (existing && !force && (existing.status === "loading" || (existing.status === "ready" && Date.now() - existing.at < MARKET_REFRESH_MS))) {
      remember(lists.current, listKey, existing);
      return Promise.resolve();
    }
    if (!deviceId) return Promise.resolve();
    const list: CatalogList = { key: listKey, deviceId, token: 0, status: "loading", items: existing?.items ?? [], nextCursor: null,
      loadingMore: false, meta: existing?.meta ?? null, at: 0 };
    remember(lists.current, listKey, list);
    chain.current = 0;
    rerender();
    return readPage(list, null, publisher);
  }, [listKey, deviceId, readPage, publisher]);
  const readCounts = useCallback(async (force: boolean) => {
    if (!client || !deviceId) return;
    const existing = counts.current.get(countsKey);
    if (existing && !force && Date.now() - existing.at < MARKET_REFRESH_MS) return;
    const entry: CountsEntry = { key: countsKey, deviceId, counts: existing?.counts ?? null,
      customSourceNames: existing?.customSourceNames ?? [], at: Date.now() };
    remember(counts.current, countsKey, entry);
    const readScope = scope;
    try {
      // The same light count read as the computer: scope all, one item, counts only.
      const page = await client.catalog({ query: debouncedQuery, scope: "all", limit: 1, excludeInstalled: true, counts: true },
        () => counts.current.get(countsKey) === entry && liveScope.current === readScope
          && sameView(liveCountsKey, countsKey, debouncedQuery));
      if (counts.current.get(countsKey) !== entry) return;
      if (liveScope.current !== readScope) { entry.at = 0; return; }
      entry.counts = page.counts; entry.customSourceNames = page.customSourceNames;
      rerender();
    } catch {
      // Counts never hide usable rows; a later visit may retry.
      if (counts.current.get(countsKey) === entry) entry.at = 0;
    }
  }, [client, deviceId, countsKey, debouncedQuery, scope]);
  const ready = active && probeStatus === "supported";
  // Bumped after an install so the visible source counts are read again (stale entries are at 0).
  const [countsTick, setCountsTick] = useState(0);
  const settled = debouncedQuery === options.query.trim().slice(0, PLUGIN_MARKET_QUERY_MAX);
  useEffect(() => {
    if (!ready || !settled) return;
    void startList(false);
    void readCounts(false);
  }, [ready, settled, listKey, countsKey, startList, readCounts, countsTick]);

  const list = lists.current.get(listKey);
  const countEntry = counts.current.get(countsKey);
  const marketCounts = countEntry?.counts ?? null;
  const customSourceNames = list?.meta?.customSourceNames.length ? list.meta.customSourceNames : countEntry?.customSourceNames ?? [];
  const filters: Array<{ value: PluginMarketFilter; count?: number }> = (["all", "official", "community", "organization", "custom"] as const)
    .filter((value) => value === "organization" ? (marketCounts?.organization ?? 0) > 0 || filter === value
      : value === "custom" ? customSourceNames.length > 0 || filter === value : true)
    .map((value) => ({ value, count: marketCounts?.[value] }));
  const setFilter = useCallback((value: PluginMarketFilter) => setFilterState(value), []);
  const effectiveFilter: PluginMarketFilter = searching ? "all" : filter;
  const items = settled ? (list?.items ?? []).filter((item) => pluginMarketMatchesFilter(item, effectiveFilter)) : [];
  const total = !settled ? undefined : searching ? marketCounts?.all : marketCounts?.[filter];

  const status: PluginMarketStatus = !targets.length ? "noComputer" : !deviceId ? "loading" : !online ? "offline"
    : probeStatus === "outdated" ? "outdated" : probeStatus === "failed" ? "failed"
      : probeStatus === "loading" || !settled || !list || (list.status === "loading" && !list.items.length) ? "loading"
        : list.status === "failed" && !list.items.length ? "failed" : "ready";
  const loadMore = useCallback(() => {
    const current = lists.current.get(listKey);
    if (!ready || !current || current.status !== "ready" || current.loadingMore || !current.nextCursor
      || !followUpAllowed(current, debouncedQuery)) return;
    current.loadingMore = true;
    rerender();
    void readPage(current, current.nextCursor, publisher);
  }, [ready, listKey, readPage, publisher, debouncedQuery]);
  const refresh = useCallback(async () => {
    if (!active) return;
    if (probeStatus !== "supported") { await readProbe(); return; }
    await Promise.all([startList(true), readCounts(true)]);
  }, [active, probeStatus, readProbe, startList, readCounts]);

  // ---- Market detail (market-detail returns the list item plus the full manifest; no README).
  const [detail, setDetail] = useState<PluginMarketDetailState | null>(null);
  const detailRead = useRef(0);
  const readDetail = useCallback(async (item: ManagedMarketItem, host: RemoteResourceHostTarget) => {
    const generation = ++detailRead.current;
    setDetail({ item, target: host, loading: true, failed: false });
    if (!client || client.deviceId !== host.deviceId || !isOnline(host)) {
      setDetail({ item, target: host, loading: false, failed: false });
      return;
    }
    try {
      const value = await client.detail(item.pluginId, () => generation === detailRead.current);
      if (generation === detailRead.current) setDetail({ item: value, target: host, detail: value, loading: false, failed: false });
    } catch {
      if (generation === detailRead.current) setDetail({ item, target: host, loading: false, failed: true });
    }
  }, [client, isOnline]);
  const openDetail = useCallback((item: ManagedMarketItem) => {
    if (target) void readDetail(item, target);
  }, [readDetail, target]);
  const closeDetail = useCallback(() => { detailRead.current += 1; setDetail(null); }, []);
  // The detail belongs to one computer and connection; drop it when either changes.
  useEffect(() => { detailRead.current += 1; setDetail(null); }, [scope]);

  // ---- Install: a fresh existing controller per attempt; its state drives the row and the consent sheet.
  // Installs only start after the paged-catalog probe, so the Host also accepts the light installed read.
  const management = usePluginManagement(install?.target.deviceId, install ? isOnline(install.target) : false,
    focused, install ? `plugin-market:${install.id}` : "plugin-market", false, "installed");
  const blocked = !!options.blocked;
  const startInstall = useCallback((item: ManagedMarketItem, known?: ManagedMarketDetail) => {
    if (installRef.current || blocked || !target || !online || probeStatus !== "supported" || item.installState !== "not-installed"
      || pluginMarketSourceUnverified(known ?? item)) return;
    setRowErrors(({ [errorKey(target.deviceId, item.pluginId)]: _removed, ...rest }) => rest);
    const attempt = { id: ++attemptId.current, target, item, detail: known, started: false, confirmed: false };
    installRef.current = attempt;
    setInstall(attempt);
  }, [target, online, probeStatus, blocked]);
  const finish = useCallback((attempt: InstallAttempt, messageKey?: string) => {
    if (installRef.current?.id !== attempt.id) return;
    installRef.current = null;
    setInstall(null);
    if (messageKey) setRowErrors((current) => ({ ...current, [errorKey(attempt.target.deviceId, attempt.item.pluginId)]: messageKey }));
  }, []);
  /**
   * The plugins on one computer changed (an install here, an uninstall or update in the installed detail, or a
   * `plugins` change notification from that computer): its cached lists and counts no longer describe it. Reads
   * sent before the change are dropped (their replies no longer land); the list on screen reads again now, other
   * cached lists on the next visit. Rows already shown stay until the new page lands, minus a plugin just installed.
   */
  const invalidateComputer = useCallback((changedOn: string, installedPluginId?: string) => {
    for (const [key, entry] of [...lists.current]) {
      if (entry.deviceId !== changedOn) continue;
      entry.token += 1;
      if (installedPluginId) entry.items = entry.items.filter((item) => item.pluginId !== installedPluginId);
      entry.loadingMore = false;
      entry.at = 0;
      if (entry.status === "loading") {
        if (entry.items.length) entry.status = "ready"; else lists.current.delete(key);
      }
    }
    for (const entry of counts.current.values()) if (entry.deviceId === changedOn) entry.at = 0;
    setCountsTick((tick) => tick + 1);
  }, []);
  useEffect(() => {
    const changed = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = onRemoteResourceChanged((source, payload) => {
      if (payload.collectionId !== "plugins") return;
      changed.add(source);
      timer ??= setTimeout(() => {
        timer = undefined;
        const devices = [...changed];
        changed.clear();
        if (mounted.current) for (const device of devices) invalidateComputer(device);
      }, PLUGIN_CHANGE_COALESCE_MS);
    });
    return () => { off(); if (timer) clearTimeout(timer); };
  }, [onRemoteResourceChanged, invalidateComputer]);
  const complete = useCallback((attempt: InstallAttempt, instanceKey: string | undefined) => {
    if (installRef.current?.id !== attempt.id) return;
    finish(attempt);
    invalidateComputer(attempt.target.deviceId, attempt.item.pluginId);
    setDetail((current) => current?.item.pluginId === attempt.item.pluginId ? null : current);
    onInstalled.current(attempt.target, instanceKey, attempt.item);
  }, [finish, invalidateComputer]);
  useEffect(() => {
    const attempt = install, state = management.state, controller = management.controller;
    if (!attempt || attempt.started || !state || !controller) return;
    if (!state.online) { finish(attempt, "plugins.actionFailed"); return; }
    if (state.capability === "unsupported") { finish(attempt, "plugins.market.outdatedShort"); return; }
    if (state.errorCode && !state.snapshot) { finish(attempt, pluginMarketErrorKey(state.errorCode)); return; }
    if (state.capability !== "supported" || !state.snapshot || state.busy) return;
    if (state.snapshot.ghosts.some((ghost) => marketItemMatchesPlugin(attempt.item, ghost))) {
      finish(attempt, "plugins.market.errors.stateChanged");
      return;
    }
    const started = { ...attempt, started: true };
    installRef.current = started;
    setInstall(started);
    const current = () => installRef.current?.id === attempt.id;
    void (async () => {
      let value = attempt.detail;
      if (!value) {
        try {
          value = await createPluginManagementClient({ invoke, deviceId: attempt.target.deviceId, isCurrent: current })
            .detail(attempt.item.pluginId);
        } catch (error) {
          if (current()) finish(attempt, pluginMarketErrorKey(pluginManagementErrorCode(error)));
          return;
        }
      }
      if (!current()) return;
      if (value.releaseId !== attempt.item.releaseId) { finish(attempt, "plugins.management.releaseChanged"); return; }
      // Without a repository the phone cannot show what is allowed.
      if (pluginMarketSourceUnverified(value)) { finish(attempt, "plugins.market.sourceUnverified"); return; }
      // The source read now must be the one the person chose; the controller checks its own last read again.
      const chosen = (attempt.detail ?? attempt.item).sourceIdentity;
      if (value.sourceType !== "server" && !samePluginMarketSourceIdentity(value.sourceIdentity, chosen)) {
        finish(attempt, "plugins.market.sourceChanged");
        return;
      }
      await controller.install(value);
      // The controller returns quietly when its connection generation changed or it only published
      // an error (offline, not ready). Nothing was sent, so release this attempt instead of waiting.
      const after = controller.getState();
      if (current() && !after.operationId && after.outcome === "idle")
        finish(attempt, pluginMarketErrorKey(after.errorCode ?? "PLUGIN_MANAGEMENT_STALE"));
    })();
  }, [install, management.state, management.controller, finish, invoke]);
  /**
   * Settle an install whose original receipt the Host no longer has (NOT_FOUND), from the facts the
   * controller read right after that answer (missingReceiptFacts), never from an earlier snapshot.
   * - No same-id instance in those facts: release the row, "could not confirm; not on this computer now".
   * - A same-id instance is only a lead (a local package can share id and namespace): read the market facts
   *   for this exact plugin; installed at the release we asked for settles as installed and opens that
   *   instance; anything else (conflict, another release or source) releases the row with an unconfirmed
   *   note. The original operation is never sent again; a new install stays the person's explicit choice.
   * Each settling run has a generation: a market-detail reply lands only if no newer verification started
   * and the controller still holds the same facts.
   */
  const settledFacts = useRef<unknown>(undefined);
  const verification = useRef(0);
  const settleMissingReceipt = useCallback(async (attempt: InstallAttempt, facts: NonNullable<PluginManagementState["missingReceiptFacts"]>) => {
    if (settledFacts.current === facts) return;
    settledFacts.current = facts;
    const generation = ++verification.current;
    const controller = management.controller;
    // Valid only while these facts are still the ones read by the newest installed read issued (derived by the
    // controller when asked), and no newer verification started.
    const current = () => installRef.current?.id === attempt.id && verification.current === generation
      && !!controller && controller.currentMissingReceiptFacts() === facts;
    // The one exit for the three outcomes; it re-checks validity right before applying.
    const conclude = (verdict: { installed: string } | "notInstalled" | "mismatch") => {
      if (!current()) return;
      if (verdict === "notInstalled") finish(attempt, "plugins.market.unconfirmedNotInstalled");
      else if (verdict === "mismatch") finish(attempt, "plugins.market.unconfirmedMismatch");
      else complete(attempt, verdict.installed);
    };
    const instance = facts.ghosts.find((ghost) => marketItemMatchesPlugin(attempt.item, ghost));
    if (!instance) { conclude("notInstalled"); return; }
    // Contract V2.9: only the Host's own evidence can make this attempt's result: the computer recorded this attempt's
    // operation id with the installed package and shows it to this device only. An instance installed by another
    // operation (from the computer, another controller, an automatic update), by an older Host, or after this device's
    // identity changed (signed out and in, reinstalled) has none of it and stays unconfirmed. Whether Allow was written
    // does not matter, so a lost reply or a dropped connection cannot lose the evidence.
    const operationId = controller?.getState().operationId;
    if (!operationId) { conclude("mismatch"); return; }
    let market: ManagedMarketDetail;
    try {
      market = await createPluginManagementClient({ invoke, deviceId: attempt.target.deviceId, isCurrent: current })
        .detail(attempt.item.pluginId);
    } catch {
      return; // Market facts not read: still unconfirmed; "Check result" verifies again.
    }
    conclude(market.installState === "installed" && market.releaseId === attempt.item.releaseId
      && market.installedOperationId === operationId ? { installed: instance.instanceKey } : "mismatch");
  }, [invoke, complete, finish, management.controller]);
  useEffect(() => {
    const attempt = install, state = management.state;
    if (!attempt?.started || !state) return;
    if (state.outcome === "confirmation" && !attempt.confirmed) {
      const next = { ...attempt, confirmed: true };
      installRef.current = next;
      setInstall(next);
    } else if (state.outcome === "failed") finish(attempt, pluginMarketErrorKey(state.errorCode));
    else if (state.outcome === "cancelled") finish(attempt);
    else if (state.outcome === "unknown" && !state.busy && state.missingReceiptFacts) {
      // Only facts read after the Host said the receipt is gone settle the result (see settleMissingReceipt).
      // While the receipt may still exist (timeout, offline) the result stays unconfirmed until it is read.
      void settleMissingReceipt(attempt, state.missingReceiptFacts);
    } else if (state.outcome === "succeeded" && !state.busy) {
      // Wait for the controller's post-commit readback; it locates the new physical instance.
      const installed = state.snapshot?.ghosts.find((ghost) => marketItemMatchesPlugin(attempt.item, ghost));
      if (installed || state.errorCode) { complete(attempt, installed?.instanceKey); return; }
      // The committed install stays successful even if the readback never names it.
      const timer = setTimeout(() => complete(attempt, undefined), 5_000);
      return () => clearTimeout(timer);
    }
  }, [install, management.state, finish, complete, settleMissingReceipt]);
  const rowState = (item: ManagedMarketItem): PluginMarketRowState => {
    if (install?.item.pluginId === item.pluginId && install.target.deviceId === deviceId) {
      const outcome = management.state?.outcome;
      if (outcome === "unknown") return { kind: "unknown" };
      if (install.confirmed && (outcome === "running" || outcome === "succeeded")) return { kind: "installing" };
      return { kind: "waiting" };
    }
    if (item.installState === "not-installed" && pluginMarketSourceUnverified(item)) return { kind: "sourceUnverified" };
    const failure = deviceId ? rowErrors[errorKey(deviceId, item.pluginId)] : undefined;
    if (failure) return { kind: "failed", messageKey: failure };
    if (item.installState === "conflict") return { kind: "conflict" };
    if (item.installState === "installed" || item.installState === "update-available") return { kind: "installed" };
    return { kind: "idle" };
  };
  /**
   * "Check result" only looks up the original operation (never a second begin); a receipt it finds settles
   * the attempt. If the Host no longer knows it (restart, 15-minute receipt expiry, or begin never arrived),
   * the controller reads the computer again and the attempt settles from those facts (settleMissingReceipt).
   * While the computer is only unreachable (no NOT_FOUND), the result stays unconfirmed.
   */
  const checkResult = useCallback(async () => {
    const attempt = installRef.current, controller = management.controller;
    if (!attempt || !controller) return;
    // A new verification round: an earlier round's market detail must not land while this round's query runs
    // (the controller also clears its earlier facts before sending the query).
    verification.current += 1;
    settledFacts.current = undefined;
    await controller.reconcile();
    const state = controller.getState();
    if (installRef.current?.id !== attempt.id || state.outcome !== "unknown" || !state.missingReceiptFacts) return;
    await settleMissingReceipt(attempt, state.missingReceiptFacts);
  }, [management.controller, settleMissingReceipt]);

  return {
    target, online, targets, selectDevice,
    filter, filters, setFilter, searching,
    status, items, total,
    hasMore: !!list?.nextCursor && list.status === "ready",
    loadingMore: !!list?.loadingMore,
    refreshing: !!list && list.status === "loading" && list.items.length > 0,
    loadMore, refresh,
    /** The plugins on this computer changed outside the market (e.g. an uninstall in the installed detail). */
    invalidate: invalidateComputer,
    notices: {
      /** A re-read failed but the last rows stay visible (the installed list says the same). */
      stale: settled && list?.status === "failed" && list.items.length > 0,
      unavailable: !!list?.meta?.unavailableReason,
      organizationKey: pluginMarketOrganizationErrorKey(list?.meta?.organizationAccessError),
      unavailableCustomSources: list?.meta?.unavailableCustomSourceNames ?? [],
    },
    rowState,
    installBusy: !!install,
    canInstall: online && probeStatus === "supported" && !install && !blocked,
    install: startInstall,
    checkResult,
    detail, openDetail, closeDetail,
    retryDetail: () => { if (detail) void readDetail(detail.item, detail.target); },
    confirmation: install && management.state && management.controller
      ? { state: management.state, controller: management.controller, deviceName: install.target.deviceName }
      : null,
  };
}
export type PluginMarketModel = ReturnType<typeof usePluginMarket>;
