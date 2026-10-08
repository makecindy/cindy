import { useSyncExternalStore } from 'react';
import { Bot, Plug, Search, Timer, type LucideIcon } from 'lucide-react';

import { readSidebarOwnerStorage, writeSidebarOwnerStorage } from '@/lib/sidebarOwnerStorage';

/** Stable built-in entries only; installed app entries keep their own visibility settings. */
export type SidebarNavigationItemId = 'automations' | 'plugins' | 'bots' | 'search';

export const SIDEBAR_NAVIGATION_ITEMS: readonly SidebarNavigationItemId[] = [
  'automations',
  'plugins',
  'bots',
  'search',
];

/** One icon per built-in entry, shared by the sidebar rows, the rail, More and Customize. */
export const SIDEBAR_NAVIGATION_ITEM_ICONS: Record<SidebarNavigationItemId, LucideIcon> = {
  automations: Timer,
  plugins: Plug,
  bots: Bot,
  search: Search,
};

export const DEFAULT_SIDEBAR_NAVIGATION_VISIBLE: readonly SidebarNavigationItemId[] = [
  'automations',
  'plugins',
  'bots',
  'search',
];

/**
 * Plugins with a main view join the same order as `app:<ghostId>`. Two settings
 * apply to them: the plugin's own "show in sidebar" switch (per-account main-view
 * store) decides whether it appears anywhere in the sidebar, More included; this
 * module only decides where. Plugins default to More; `appsAtTop` lists the ones
 * placed at the top level (checked in Customize, or already in the sidebar when this
 * first ran for the owner). Entries never placed in the order follow the built-ins.
 */
export type SidebarNavigationAppEntryId = `app:${string}`;
export type SidebarNavigationEntryId = SidebarNavigationItemId | SidebarNavigationAppEntryId;

const APP_ENTRY_PREFIX = 'app:';
const MAX_APP_ENTRY_LENGTH = APP_ENTRY_PREFIX.length + 128;

export function appEntryId(ghostId: string): SidebarNavigationAppEntryId {
  return `${APP_ENTRY_PREFIX}${ghostId}`;
}

export function ghostIdOfEntry(id: SidebarNavigationEntryId): string | null {
  return id.startsWith(APP_ENTRY_PREFIX) ? id.slice(APP_ENTRY_PREFIX.length) : null;
}

export function isBuiltInEntry(id: SidebarNavigationEntryId): id is SidebarNavigationItemId {
  return SIDEBAR_NAVIGATION_ITEMS.includes(id as SidebarNavigationItemId);
}

/**
 * Keep entries missing from an edited order (plugins whose own sidebar switch is
 * off right now) at their previous place: each one goes back right after the entry
 * that preceded it before, or first when nothing did.
 */
export function mergeAbsentOrderEntries(
  edited: readonly SidebarNavigationEntryId[],
  previous: readonly SidebarNavigationEntryId[],
): SidebarNavigationEntryId[] {
  const merged = [...edited];
  previous.forEach((id, index) => {
    if (merged.includes(id)) return;
    const anchor = previous
      .slice(0, index)
      .reverse()
      .find((before) => merged.includes(before));
    merged.splice(anchor === undefined ? 0 : merged.indexOf(anchor) + 1, 0, id);
  });
  return merged;
}

/** Saved order restricted to entries that exist now; unplaced plugins follow in their given order. */
export function resolveSidebarNavigationOrder(
  order: readonly SidebarNavigationEntryId[],
  ghostIds: readonly string[],
): SidebarNavigationEntryId[] {
  const installed = new Set(ghostIds);
  const placed = order.filter((id) => {
    const ghostId = ghostIdOfEntry(id);
    return ghostId === null || installed.has(ghostId);
  });
  return [...placed, ...ghostIds.map(appEntryId).filter((id) => !placed.includes(id))];
}

/** Per-account key; see sidebarOwnerStorage for the owner suffix and switch guard. */
const STORAGE_KEY = 'sidebar-navigation:v2';

export interface SidebarNavigationPrefs {
  order: SidebarNavigationEntryId[];
  /** Built-in entries shown at the top level; the rest live in More. */
  visible: SidebarNavigationItemId[];
  /** Plugin main views placed at the top level; every other sidebar plugin sits in More. */
  appsAtTop: SidebarNavigationAppEntryId[];
}

export type SidebarNavigationPrefsInput = Omit<SidebarNavigationPrefs, 'appsAtTop'> & {
  appsAtTop?: SidebarNavigationAppEntryId[];
};

/** Only explicit differences from the current product defaults are persisted. */
interface SidebarNavigationOverride {
  order?: SidebarNavigationEntryId[];
  /** Built-ins in either direction; plugin entries only ever as `true` (at the top level). */
  visibility?: Partial<Record<SidebarNavigationEntryId, boolean>>;
}

const defaultPrefs = (): SidebarNavigationPrefs => ({
  order: [...SIDEBAR_NAVIGATION_ITEMS],
  visible: [...DEFAULT_SIDEBAR_NAVIGATION_VISIBLE],
  appsAtTop: [],
});
const DEFAULT_SERVER_SNAPSHOT = defaultPrefs();

function validIds(value: unknown): SidebarNavigationItemId[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter((id): id is SidebarNavigationItemId =>
            SIDEBAR_NAVIGATION_ITEMS.includes(id as SidebarNavigationItemId),
          ),
        ),
      ]
    : [];
}

function validOrder(value: unknown): SidebarNavigationEntryId[] {
  return Array.isArray(value)
    ? [
        ...new Set(
          value.filter(
            (id): id is SidebarNavigationEntryId =>
              typeof id === 'string' &&
              (isBuiltInEntry(id as SidebarNavigationEntryId) ||
                (id.startsWith(APP_ENTRY_PREFIX) &&
                  id.length > APP_ENTRY_PREFIX.length &&
                  id.length <= MAX_APP_ENTRY_LENGTH)),
          ),
        ),
      ]
    : [];
}

function validAppEntries(value: unknown): SidebarNavigationAppEntryId[] {
  return validOrder(value).filter((id): id is SidebarNavigationAppEntryId => !isBuiltInEntry(id));
}

function normalize(value: unknown): SidebarNavigationPrefs {
  const fallback = defaultPrefs();
  if (!value || typeof value !== 'object') return fallback;
  const candidate = value as { order?: unknown; visible?: unknown; appsAtTop?: unknown };
  const order = validOrder(candidate.order);
  return {
    order: [...order, ...fallback.order.filter((id) => !order.includes(id))],
    visible: Array.isArray(candidate.visible) ? validIds(candidate.visible) : fallback.visible,
    appsAtTop: validAppEntries(candidate.appsAtTop),
  };
}

function applyOverride(value: unknown): SidebarNavigationPrefs {
  const fallback = defaultPrefs();
  if (!value || typeof value !== 'object') return fallback;
  const override = value as SidebarNavigationOverride;
  const order = validOrder(override.order);
  const visibility = override.visibility ?? {};
  return {
    order: [...order, ...fallback.order.filter((id) => !order.includes(id))],
    visible: SIDEBAR_NAVIGATION_ITEMS.filter((id) => {
      const selected = visibility[id];
      return typeof selected === 'boolean'
        ? selected
        : DEFAULT_SIDEBAR_NAVIGATION_VISIBLE.includes(id);
    }),
    appsAtTop: validAppEntries(Object.keys(visibility)).filter((id) => visibility[id] === true),
  };
}

function toOverride(prefs: SidebarNavigationPrefs): SidebarNavigationOverride {
  const defaults = defaultPrefs();
  const override: SidebarNavigationOverride = {};
  if (
    prefs.order.length !== defaults.order.length ||
    prefs.order.some((id, index) => id !== defaults.order[index])
  ) {
    override.order = prefs.order;
  }
  const visibility: NonNullable<SidebarNavigationOverride['visibility']> = {};
  for (const id of SIDEBAR_NAVIGATION_ITEMS) {
    const selected = prefs.visible.includes(id);
    if (selected !== defaults.visible.includes(id)) visibility[id] = selected;
  }
  for (const id of prefs.appsAtTop) visibility[id] = true;
  if (Object.keys(visibility).length) override.visibility = visibility;
  return override;
}

/**
 * Preferences belong to the account, like the other sidebar layout settings:
 * each data owner keeps its own order, top-level entries and plugins in More.
 * Reads go through the owner guard (a synchronous Main check), so parsed values
 * are cached per owner and refreshed only on writes here or storage events from
 * other windows. Without an owner the product defaults apply and nothing is saved.
 */
const cache = new Map<string, SidebarNavigationPrefs>();
const listeners = new Set<() => void>();

function readPrefs(owner: string): SidebarNavigationPrefs {
  const raw = readSidebarOwnerStorage(STORAGE_KEY, owner);
  if (raw === null) return DEFAULT_SERVER_SNAPSHOT;
  try {
    return applyOverride(JSON.parse(raw));
  } catch {
    return DEFAULT_SERVER_SNAPSHOT;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== null && !event.key.startsWith(`${STORAGE_KEY}.owner.`)) return;
    cache.clear();
    listeners.forEach((listener) => listener());
  });
}

export function getSidebarNavigationPrefs(owner: string | null): SidebarNavigationPrefs {
  if (!owner) return DEFAULT_SERVER_SNAPSHOT;
  const cached = cache.get(owner);
  if (cached) return cached;
  const prefs = readPrefs(owner);
  cache.set(owner, prefs);
  return prefs;
}

export function subscribeSidebarNavigationPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Returns whether the preferences reached storage, not just this window's cache. */
export function setSidebarNavigationPrefs(
  owner: string | null,
  prefs: SidebarNavigationPrefsInput,
): boolean {
  if (!owner) return false;
  const next = normalize(prefs);
  // Keep this window consistent even if the owner guard or storage refuses the write.
  cache.set(owner, next);
  const persisted = writeSidebarOwnerStorage(STORAGE_KEY, owner, JSON.stringify(toOverride(next)));
  listeners.forEach((listener) => listener());
  return persisted;
}

export function useSidebarNavigationPrefs(owner: string | null): SidebarNavigationPrefs {
  return useSyncExternalStore(
    subscribeSidebarNavigationPrefs,
    () => getSidebarNavigationPrefs(owner),
    () => DEFAULT_SERVER_SNAPSHOT,
  );
}

/* ------------------------------------------------------------------------- */
/* Plugin entries joining the sidebar                                        */
/* ------------------------------------------------------------------------- */

/**
 * Plugins are installed per account, so arrivals are tracked per data owner:
 * `known` lists plugins that have been in the sidebar before, `unseen` the ones
 * placed into More on arrival that the user has not looked at yet ("New").
 */
interface SidebarAppArrivals {
  known: string[];
  unseen: string[];
}

const ARRIVALS_STORAGE_KEY = 'sidebar-navigation:apps:v1';
const EMPTY_UNSEEN: readonly string[] = [];

function readArrivals(): Record<string, SidebarAppArrivals> {
  try {
    const raw = JSON.parse(localStorage.getItem(ARRIVALS_STORAGE_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const strings = (value: unknown) =>
      Array.isArray(value)
        ? [...new Set(value.filter((id): id is string => typeof id === 'string'))]
        : [];
    return Object.fromEntries(
      Object.entries(raw as Record<string, Partial<SidebarAppArrivals>>).map(([owner, record]) => [
        owner,
        { known: strings(record?.known), unseen: strings(record?.unseen) },
      ]),
    );
  } catch {
    return {};
  }
}

let arrivals = readArrivals();
const arrivalListeners = new Set<() => void>();

function writeArrivals(next: Record<string, SidebarAppArrivals>): void {
  arrivals = next;
  try {
    localStorage.setItem(ARRIVALS_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Keep this window consistent even if persistence is unavailable.
  }
  arrivalListeners.forEach((listener) => listener());
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== ARRIVALS_STORAGE_KEY) return;
    arrivals = readArrivals();
    arrivalListeners.forEach((listener) => listener());
  });
}

/**
 * Track plugins entering the sidebar so new ones carry a New tag. They need no
 * placement write: plugins default to More. The first run for an owner keeps the
 * plugins already in the sidebar at the top level, so nothing moves on upgrade.
 * Idempotent.
 */
export function reconcileSidebarAppArrivals(
  owner: string,
  ghostIds: readonly string[],
  rosterReady: boolean,
): void {
  // Main reports no plugins at all while an account switch settles, and every real
  // session carries at least the bundled ones. Until the installed roster is known,
  // record nothing: neither a baseline nor arrivals. Once it is, an empty sidebar is
  // a real baseline, so the owner's first sidebar plugin still starts in More.
  if (!rosterReady) return;
  const record = arrivals[owner];
  if (!record) {
    if (ghostIds.length > 0) {
      const prefs = getSidebarNavigationPrefs(owner);
      const kept = setSidebarNavigationPrefs(owner, {
        ...prefs,
        appsAtTop: [...new Set([...prefs.appsAtTop, ...ghostIds.map(appEntryId)])],
      });
      // Without the stored top-level placement a restart would move these plugins
      // into More; leave the first run to be retried instead of recording it.
      if (!kept) return;
    }
    writeArrivals({ ...arrivals, [owner]: { known: [...ghostIds], unseen: [] } });
    return;
  }
  const arrived = ghostIds.filter((id) => !record.known.includes(id));
  // A new plugin removed or switched off before it was seen is no longer news.
  const unseen = record.unseen.filter((id) => ghostIds.includes(id));
  if (arrived.length === 0 && unseen.length === record.unseen.length) return;
  writeArrivals({
    ...arrivals,
    [owner]: { known: [...record.known, ...arrived], unseen: [...unseen, ...arrived] },
  });
}

/** Plugins this owner has had in the sidebar, including ones whose switch is off now. */
export function getSidebarKnownApps(owner: string | null): readonly string[] {
  return owner ? (arrivals[owner]?.known ?? EMPTY_UNSEEN) : EMPTY_UNSEEN;
}

/** Opening More shows every new entry, so they stop being flagged. */
export function markSidebarAppArrivalsSeen(owner: string): void {
  const record = arrivals[owner];
  if (!record || record.unseen.length === 0) return;
  writeArrivals({ ...arrivals, [owner]: { ...record, unseen: [] } });
}

export function useSidebarUnseenApps(owner: string | null): readonly string[] {
  return useSyncExternalStore(
    (listener) => {
      arrivalListeners.add(listener);
      return () => arrivalListeners.delete(listener);
    },
    () => (owner ? (arrivals[owner]?.unseen ?? EMPTY_UNSEEN) : EMPTY_UNSEEN),
    () => EMPTY_UNSEEN,
  );
}

export const __testing = {
  /** Re-read arrivals from storage, as a fresh window would. */
  resetArrivals(): void {
    arrivals = readArrivals();
    arrivalListeners.clear();
  },
  /** Forget cached preferences, as a fresh window would. */
  resetPrefsCache(): void {
    cache.clear();
  },
};
