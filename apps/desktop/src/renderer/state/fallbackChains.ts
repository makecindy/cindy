/**
 * fallbackChains —— 每个「主模型」一条备用链,localStorage 持久化。
 *
 * 语义:
 *   链条按**主模型身份**(来源 + 模型 + 引擎)索引。换主模型 = 换一条链,
 *   互不牵连;这样在选择器里来回切模型时,各自的备用配置都还在。
 *   `entries[0]` 是主模型自身(冗余存一份,便于 UI 直接渲染整条链),
 *   `entries[1..]` 才是备用。
 *
 * 为什么 effort 存档位 key 而不是显示文案:与 modelFavorites / modelEnginePrefs
 * 同一个教训 —— 文案随语言变,存文案会串档。
 *
 * 账号分区:key 带 dataOwnerId 后缀,与 modelEnginePrefs 同形。
 * 多窗口:监听 storage 事件后**重读** localStorage(不信 event.newValue,迟到事件
 * 带旧值)。写入频率极低(用户显式增删备用),同步写,失败静默吞。
 */

import { useSyncExternalStore } from 'react';

import {
  fallbackEntryUid,
  normalizeFallbackChain,
  type FallbackChain,
  type FallbackChainEntry,
} from '@cindy/maker-shared/fallback-chain';

/**
 * v2: entry identity gained `effort`. v1 chains were keyed without it, so the same
 * model at two thinking levels collapsed into one entry and could not be removed
 * individually. Old data is not migrated — a stale chain is cheap to rebuild and
 * far cheaper than carrying ambiguous identities forward.
 */
const STORAGE_KEY = 'xdt:fallbackChains:v2';

let activeDataOwnerId: string | null = null;

function storageKey(): string {
  return activeDataOwnerId ? `${STORAGE_KEY}:${encodeURIComponent(activeDataOwnerId)}` : STORAGE_KEY;
}

type ChainMap = Record<string, FallbackChain>;

let cache: ChainMap | null = null;
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version += 1;
  for (const listener of listeners) listener();
}

function isEntry(value: unknown): value is FallbackChainEntry {
  if (!value || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    typeof e.providerId === 'string' &&
    !!e.providerId &&
    typeof e.modelId === 'string' &&
    !!e.modelId &&
    typeof e.agent === 'string' &&
    !!e.agent
  );
}

/** 逐条校验后再收:坏字段丢该条,不丢整张表。 */
function parse(raw: string | null): ChainMap {
  if (!raw) return {};
  try {
    const data = JSON.parse(raw) as unknown;
    if (!data || typeof data !== 'object') return {};
    const out: ChainMap = {};
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (!value || typeof value !== 'object') continue;
      const chain = value as Record<string, unknown>;
      if (!Array.isArray(chain.entries)) continue;
      const entries = chain.entries.filter(isEntry).map((entry) => ({
        ...entry,
        uid: typeof entry.uid === 'string' && entry.uid ? entry.uid : fallbackEntryUid(entry),
      }));
      if (entries.length === 0) continue;
      const normalized = normalizeFallbackChain({ entries, enabled: chain.enabled !== false });
      // Older builds could key a chain with the legacy `cc` agent id. Index
      // the migrated chain by its canonical first entry so the current picker
      // can find it immediately instead of showing a fresh empty chain.
      const canonicalKey = normalized.entries[0]
        ? fallbackEntryUid(normalized.entries[0])
        : key;
      const existing = out[canonicalKey];
      out[canonicalKey] = existing
        ? normalizeFallbackChain({
            entries: [...existing.entries, ...normalized.entries],
            enabled: existing.enabled && normalized.enabled,
          })
        : normalized;
    }
    return out;
  } catch {
    return {};
  }
}

function load(): ChainMap {
  if (cache) return cache;
  cache = typeof window === 'undefined' ? {} : parse(window.localStorage.getItem(storageKey()));
  return cache;
}

/** 写回前重读基底:不能带着陈旧缓存整表覆盖另一个窗口刚写入的链。 */
function fresh(): ChainMap {
  return typeof window === 'undefined' ? {} : parse(window.localStorage.getItem(storageKey()));
}

function persist(next: ChainMap): void {
  cache = next;
  try {
    window.localStorage.setItem(storageKey(), JSON.stringify(next));
  } catch {
    // 配额 / 隐私模式:内存态照常生效。
  }
  emit();
}

/**
 * 主模型身份 → 链条 key。
 *
 * 与条目身份同一个函数,因此口径必然一致:引擎与深度都参与。同一模型换引擎或换档
 * 都是另一套路由,各自带一条链。
 */
export function fallbackChainKey(main: {
  providerId: string;
  modelId: string;
  agent: string;
  effort?: string | undefined;
}): string {
  return fallbackEntryUid(main);
}

export function getFallbackChain(key: string): FallbackChain | null {
  return load()[key] ?? null;
}

/**
 * Find the chain that CONTAINS this entry, not just the one keyed by it.
 *
 * After a failover the session is running entry #2, so a lookup keyed by the
 * running model finds nothing and the composer would show no chain at all -
 * exactly when the user most wants to see where they are. Looking for the
 * containing chain keeps `1 -> 2 -> 3` on screen with 2 as the live model.
 */
export function findChainContaining(uid: string): FallbackChain | null {
  const direct = load()[uid];
  if (direct) return direct;
  for (const chain of Object.values(load())) {
    if (chain.entries.some((entry) => entry.uid === uid)) return chain;
  }
  return null;
}

/** 备用模型数量(不含主模型),供 footer 角标使用。 */
export function fallbackCountFor(key: string): number {
  const chain = load()[key];
  if (!chain || !chain.enabled) return 0;
  return Math.max(0, chain.entries.length - 1);
}

export function setFallbackChain(key: string, chain: FallbackChain): void {
  const next = { ...fresh() };
  const normalized = normalizeFallbackChain(chain);
  const canonicalKey = normalized.entries[0] ? fallbackEntryUid(normalized.entries[0]) : key;
  delete next[key];
  delete next[canonicalKey];
  // 只剩主模型 = 没有备用行为,删掉整条,不留空壳。
  if (normalized.entries.length > 1) next[canonicalKey] = normalized;
  persist(next);
}

export function appendFallbackEntry(key: string, main: FallbackChainEntry, entry: FallbackChainEntry): void {
  const canonicalKey = fallbackChainKey(main);
  const current = load()[canonicalKey] ?? load()[key] ?? { entries: [main], enabled: true };
  setFallbackChain(canonicalKey, { ...current, entries: [...current.entries, entry] });
}

export function removeFallbackEntry(key: string, uid: string): void {
  const current = load()[key];
  if (!current) return;
  setFallbackChain(key, {
    ...current,
    entries: current.entries.filter(
      (entry, index) =>
        index === 0 ||
        (entry.uid !== uid && fallbackEntryUid(entry) !== uid && fallbackEntryUid(entry) !== `${uid}::`),
    ),
  });
}

export function setFallbackChainEnabled(key: string, enabled: boolean): void {
  const current = load()[key];
  if (!current) return;
  const next = { ...fresh() };
  next[key] = { ...current, enabled };
  persist(next);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const getVersion = (): number => version;

export function useFallbackChainsVersion(): number {
  return useSyncExternalStore(subscribe, getVersion, getVersion);
}

/** 随数据归属账号切换命名空间(与 setModelEnginePrefsOwner 同形)。 */
export function setFallbackChainsOwner(ownerId: string | null): void {
  if (activeDataOwnerId === ownerId) return;
  activeDataOwnerId = ownerId;
  cache = null;
  emit();
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.storageArea && event.storageArea !== window.localStorage) return;
    if (event.key !== null && event.key !== storageKey()) return;
    // 重读而不是采信 event.newValue:迟到事件带旧值,采信会回滚本窗口刚写的链。
    cache = null;
    emit();
  });
}

export const __STORAGE_KEY = STORAGE_KEY;

/** 测试用:丢缓存 + 清本分区,与 modelFavorites / modelEnginePrefs 的同名钩子同形。 */
export function __resetForTest(): void {
  cache = null;
  activeDataOwnerId = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 测试环境没有 storage 时无需清理。
  }
  emit();
}
