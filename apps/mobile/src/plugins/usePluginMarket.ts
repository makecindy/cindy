import { pluginOperationOpens, type PluginOperationNotOpened } from "./pluginOperationOpens";
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
import { usePluginCheckConclusions, usePluginManagement, usePluginPendingChecks } from "./usePluginManagement";
import { pluginManagementSlotFor, pluginOperationHold, usePluginManagementSlot, type PluginSlotToken } from "./pluginManagementSlot";

/** Same freshness window as the computer's market browser; pull-to-refresh always re-reads. */
const MARKET_REFRESH_MS = 30_000;
const CACHED_LISTS = 6;
const SEARCH_DEBOUNCE_MS = 300;
/** Plugin change notifications from one computer often come in a burst (install, enable, readback): read once after. */
const PLUGIN_CHANGE_COALESCE_MS = 500;
/** Install attempts still holding their computer's slot, per account, for the plugins page mounted again (see usePluginMarket). */
const pendingInstalls = new Map<string, InstallAttempt>();
/** Attempt numbers are unique across mounts (a kept attempt and a new one never share a controller scope). */
let nextAttemptId = 0;
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
  /** The page's management slot, taken when Install was pressed (see pluginManagementSlot.ts). */
  token: PluginSlotToken;
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
  /** The read was cancelled (the market left the screen, the computer went away, the app went to the background):
   *  not a failure; it is read again when the market is shown again. */
  interrupted?: boolean;
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
  /** Called once per successful install; instanceKey is absent only if the Host readback failed. */
  /**
   * The install succeeded: `instanceKey` when the computer's facts prove this install's instance (it opens), otherwise
   * why not (`notOpened`: a `pluginOperationOpens` reason, or `unread` when the computer could not be read).
   */
  onInstalled(target: RemoteResourceHostTarget, instanceKey: string | undefined, item: ManagedMarketItem,
    notOpened?: PluginOperationNotOpened | "unread"): void;
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
  // An attempt still holding its computer's slot outlives this hook (maintainer review 17:43): the plugins page mounted
  // again takes it back, with its computer, plugin and attempt number, so its row shows it and "Check result" looks up
  // the same operation through the controller that was kept for it (see usePluginManagement). Once its result waits
  // for the person to check it, the attempt ends here and its pending check carries on (maintainer review 18:45).
  const attemptOwner = `${owner.accountKey}\u0000${owner.generation}`;
  const [install, setInstallState] = useState<InstallAttempt | null>(() => {
    const kept = pendingInstalls.get(attemptOwner);
    return kept && pluginManagementSlotFor(owner).holds(kept.token) ? kept : null;
  });
  const installRef = useRef(install);
  installRef.current = install;
  const setInstall = useCallback((attempt: InstallAttempt | null) => {
    if (attempt) pendingInstalls.set(attemptOwner, attempt);
    else if (installRef.current && pendingInstalls.get(attemptOwner)?.id === installRef.current.id) pendingInstalls.delete(attemptOwner);
    setInstallState(attempt);
  }, [attemptOwner]);
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
  /**
   * A read that ended because its fence closed (left the market, lost the computer, went to the background, unmounted)
   * is cancelled, not failed: it leaves no "failed" behind and is read again when the market is shown again. Used by
   * every market read's error path (probe, pages, counts, detail).
   */
  const readCancelled = (error: unknown) => !readsOpen() || pluginManagementErrorCode(error) === "PLUGIN_MANAGEMENT_STALE";
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
    } catch (error) {
      if (!latest()) return;
      // Cancelled: forget it, so showing the market again probes again.
      if (readCancelled(error)) setProbe((current) => current?.scope === probeScope && current.status === "loading" ? undefined : current);
      else setProbe({ scope: probeScope, status: "failed" });
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
  // The computer came back (for example restarted after updating Cindy, as the "outdated" note asks): a result other
  // than "supported" is probed again once, without waiting for a pull to refresh.
  const wasOnline = useRef(online);
  useEffect(() => {
    const cameBack = online && !wasOnline.current;
    wasOnline.current = online;
    if (cameBack && active && probe?.scope === scope && (probe.status === "outdated" || probe.status === "failed")) void readProbe();
  }, [online, active, scope, probe, readProbe]);
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
  const liveDetail = useRef(detail);
  liveDetail.current = detail;
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
    } catch (error) {
      if (generation !== detailRead.current) return;
      setDetail(readCancelled(error) ? { item, target: host, loading: false, failed: false, interrupted: true }
        : { item, target: host, loading: false, failed: true });
    }
  }, [client, isOnline]);
  const openDetail = useCallback((item: ManagedMarketItem) => {
    if (target) void readDetail(item, target);
  }, [readDetail, target]);
  const closeDetail = useCallback(() => { detailRead.current += 1; setDetail(null); }, []);
  // A detail read cancelled while it was open is read again once the market is shown again.
  useEffect(() => {
    if (active && detail?.interrupted && detail.target.deviceId === deviceId) void readDetail(detail.item, detail.target);
  }, [active, detail?.interrupted, deviceId, readDetail]);
  // The detail belongs to one computer and connection; drop it when either changes.
  useEffect(() => { detailRead.current += 1; setDetail(null); }, [scope]);

  // ---- Install: a fresh existing controller per attempt; its state drives the row and the consent sheet.
  // Installs only start after the paged-catalog probe, so the Host also accepts the light installed read.
  const management = usePluginManagement(install?.target.deviceId, install ? isOnline(install.target) : false,
    focused, install ? `plugin-market:${install.id}` : "plugin-market", false, "installed");
  // The page's one management slot decides whether Install may start: taken synchronously on the press (a second
  // press, a press from a stale render or from another entry in the same frame cannot take it), released by this
  // attempt's token when it ends, or by the controller once the install it was handed over to is over.
  const { slot, holderOn } = usePluginManagementSlot();
  // Pending checks (maintainer review 18:45): an install this phone wrote whose result waits to be checked keeps its
  // row on this computer ("Check result" looks up the original operation), whatever this view does meanwhile.
  const checks = usePluginPendingChecks();
  const checkFor = (pluginId: string) => checks.find((check) => check.entry === "market-install"
    && check.who.deviceId === deviceId && check.who.pluginId === pluginId);
  // A kept attempt that had started was handed over to its controller already.
  const handedOver = useRef(install?.started ? install.id : 0);
  /** The attempt whose controller had an operation (begin issued): only then can it be handed to a pending check. */
  const operationSeen = useRef(0);
  const startInstall = useCallback((item: ManagedMarketItem, known?: ManagedMarketDetail) => {
    if (installRef.current || !target || !online || probeStatus !== "supported" || item.installState !== "not-installed"
      || pluginMarketSourceUnverified(known ?? item)) return;
    const token = slot.tryAcquire("market-install", { name: item.name, deviceId: target.deviceId, deviceName: target.deviceName,
      pluginId: item.pluginId, ghostId: item.ghostId });
    if (!token) return;
    setRowErrors(({ [errorKey(target.deviceId, item.pluginId)]: _removed, ...rest }) => rest);
    const attempt = { id: ++nextAttemptId, token, target, item, detail: known, started: false, confirmed: false };
    installRef.current = attempt;
    setInstall(attempt);
  }, [target, online, probeStatus, slot]);
  // Leaving the page before the controller took the install over: nothing was sent, the slot goes.
  useEffect(() => () => {
    const attempt = installRef.current;
    if (attempt && handedOver.current !== attempt.id) slot.release(attempt.token);
  }, [slot]);
  const finish = useCallback((attempt: InstallAttempt, messageKey?: string) => {
    if (installRef.current?.id !== attempt.id) return;
    setInstall(null);
    installRef.current = null;
    slot.release(attempt.token);
    if (messageKey) setRowErrors((current) => ({ ...current, [errorKey(attempt.target.deviceId, attempt.item.pluginId)]: messageKey }));
  }, [slot]);
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
  const complete = useCallback((attempt: InstallAttempt, instanceKey: string | undefined, notOpened?: PluginOperationNotOpened | "unread") => {
    if (installRef.current?.id !== attempt.id) return;
    finish(attempt);
    // The page is gone: nothing to open, and no read is sent for it.
    if (!mounted.current) return;
    invalidateComputer(attempt.target.deviceId, attempt.item.pluginId);
    // Closing this plugin's market detail also fences a detail read still in flight for it (its reply must not open
    // the detail again, whether or not the installed instance is known).
    if (liveDetail.current?.item.pluginId === attempt.item.pluginId) {
      detailRead.current += 1;
      setDetail(null);
    }
    onInstalled.current(attempt.target, instanceKey, attempt.item, instanceKey ? undefined : notOpened);
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
    // This attempt is still the one on screen; writing also needs the slot still held by it.
    const mine = () => installRef.current?.id === attempt.id;
    // Sending also needs the page still mounted (the same fence as every market read).
    const current = () => mounted.current && mine() && slot.holds(attempt.token);
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
      handedOver.current = attempt.id;
      await controller.install(value, undefined, pluginOperationHold(slot, attempt.token));
      // The controller returns quietly when its connection generation changed or it only published
      // an error (offline, not ready). Nothing was sent, so release this attempt instead of waiting.
      const after = controller.getState();
      if (mine() && !after.operationId && after.outcome === "idle")
        finish(attempt, pluginMarketErrorKey(after.errorCode ?? "PLUGIN_MANAGEMENT_STALE"));
    })();
  }, [install, management.state, management.controller, finish, invoke, slot]);
  useEffect(() => {
    const attempt = install, state = management.state, controller = management.controller;
    if (!attempt?.started || !state || !controller) return;
    // Handed over and its result now waits for the person to check it (the computer's slot went), or its operation is
    // no longer tracked ("Stop tracking"): this attempt ends; its pending check, if any, carries on with the row (see
    // `rowState`). Before begin there is no operation to hand over: the paths below settle it.
    if (state.operationId) operationSeen.current = attempt.id;
    const live = controller.getState();
    if (handedOver.current === attempt.id && !["succeeded", "failed", "cancelled"].includes(state.outcome)
      && (controller.pendingCheck()?.waiting || (operationSeen.current === attempt.id && !live.operationId && !live.busy))) {
      finish(attempt);
      return;
    }
    if (state.outcome === "confirmation" && !attempt.confirmed) {
      const next = { ...attempt, confirmed: true };
      installRef.current = next;
      setInstall(next);
    } else if (state.outcome === "failed") finish(attempt, pluginMarketErrorKey(state.errorCode));
    else if (state.outcome === "cancelled") finish(attempt);
    else if (state.outcome === "succeeded" && !state.busy) {
      // Only while the controller's own post-commit read is out is there nothing to decide on yet. Once it landed, the one
      // decision (pluginOperationOpens, contract V2.10) settles it at once: open the proven instance, or end with why not
      // (② not attributable, ③ an older computer, no instance); a failed read ends it as "could not read".
      if (state.finalReadback === "pending") return;
      if (state.finalReadback === "failed" || state.errorCode) { complete(attempt, undefined, "unread"); return; }
      const opens = state.operationId && state.snapshot ? pluginOperationOpens(
        { operationId: state.operationId, entry: "market-install", who: {}, detail: attempt.detail ?? attempt.item },
        { ghosts: state.snapshot.ghosts, market: state.snapshot.market.items }) : null;
      complete(attempt, opens?.open ? opens.instanceKey : undefined, opens && !opens.open ? opens.reason : "unread");
    }
  }, [install, management.state, management.controller, finish, complete]);
  // Pending checks of this market's installs that ended without this view (usePluginManagement): the row's note, and
  // the computer's lists read again after an install. Each is applied once per mount.
  const conclusions = usePluginCheckConclusions();
  const applied = useRef(new Set<string>());
  useEffect(() => {
    for (const conclusion of conclusions) {
      if (conclusion.entry !== "market-install" || conclusion.shown || applied.current.has(conclusion.operationId) || !conclusion.who.pluginId) continue;
      applied.current.add(conclusion.operationId);
      const { deviceId: on, pluginId } = conclusion.who;
      const note = conclusion.result === "notInstalled" ? "plugins.market.unconfirmedNotInstalled"
        : conclusion.result === "mismatch" ? "plugins.market.unconfirmedMismatch"
        : conclusion.result === "legacy" ? "plugins.market.unconfirmedLegacy"
          : conclusion.result === "failed" ? pluginMarketErrorKey(conclusion.errorCode) : undefined;
      if (note) setRowErrors((current) => ({ ...current, [errorKey(on, pluginId)]: note }));
      else if (conclusion.result === "succeeded" || conclusion.result === "installed") invalidateComputer(on, pluginId);
    }
  }, [conclusions, invalidateComputer]);
  const rowState = (item: ManagedMarketItem): PluginMarketRowState => {
    if (install?.item.pluginId === item.pluginId && install.target.deviceId === deviceId) {
      const outcome = management.state?.outcome;
      if (outcome === "unknown") return { kind: "unknown" };
      if (install.confirmed && (outcome === "running" || outcome === "succeeded")) return { kind: "installing" };
      return { kind: "waiting" };
    }
    const check = checkFor(item.pluginId);
    if (check) return check.waiting || check.state.outcome === "unknown" ? { kind: "unknown" } : { kind: "installing" };
    if (item.installState === "not-installed" && pluginMarketSourceUnverified(item)) return { kind: "sourceUnverified" };
    const failure = deviceId ? rowErrors[errorKey(deviceId, item.pluginId)] : undefined;
    if (failure) return { kind: "failed", messageKey: failure };
    if (item.installState === "conflict") return { kind: "conflict" };
    if (item.installState === "installed" || item.installState === "update-available") return { kind: "installed" };
    return { kind: "idle" };
  };
  /**
   * "Check result" only looks up the original operation (never a second begin); a receipt it finds settles it. If the
   * Host no longer knows it (restart, 15-minute receipt expiry, or begin never arrived), the controller reads the
   * computer again and the pending check settles from those facts (usePluginManagement). While the computer is only
   * unreachable (no NOT_FOUND), the result stays unconfirmed. `item`: the row's plugin (its attempt or pending check).
   */
  const checkResult = useCallback(async (item?: ManagedMarketItem) => {
    const attempt = installRef.current, controller = management.controller;
    if (attempt && controller && (!item || attempt.item.pluginId === item.pluginId)) { await controller.reconcile(); return; }
    if (item) await checkFor(item.pluginId)?.verify();
  }, [management.controller, checks, deviceId]);

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
    canInstall: online && probeStatus === "supported" && !install && !holderOn(target?.deviceId),
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
