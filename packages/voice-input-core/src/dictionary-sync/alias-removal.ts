/**
 * 别名删除下界。
 *
 * 别名计数是按节点分桶的 GCounter，不能直接删 key：离线副本会把旧值合并回来。
 * 删除时在**同一个化身的 aliases map** 里写一条零计数的隐藏别名，key 固定标识
 * “原别名 + 计数节点”，`lastSeenAt` 借作已观察计数下界。这样有三点好处：
 *
 * 1. 旧客户端会原样合并、改名搬运这条隐藏别名，但因为计数为 0 不会展示它；
 * 2. 同一别名反复删加只更新固定 key，状态不会按编辑次数增长；
 * 3. `lastSeenAt` 在旧版合并里本来就取 max，因此并发删除也会保留更高下界。
 *
 * 旧客户端不知道如何扣除下界，所以升级前仍可能显示已删除的历史别名；但它不会
 * 丢掉或破坏删除意图，新客户端再次接收状态后会正确物化。
 */

import { compareHlc, hlcWallMs, type HlcTimestamp } from "./hlc";
import {
  createDictionaryMap,
  type GCounter,
  type SyncAliasState,
} from "./types";

const ALIAS_REMOVAL_KEY_PREFIX = "\u0000cindy-alias-removal-v1:";

export interface AliasRemovalMarker {
  aliasKey: string;
  counterNodeId: string;
  removedCount: number;
}

export interface AliasRemovalState {
  floor: GCounter;
  latestStamp: HlcTimestamp;
}

export type AliasRemovalIndex = Map<string, AliasRemovalState>;

export function isAliasRemovalMarkerKey(aliasKey: string): boolean {
  return aliasKey.startsWith(ALIAS_REMOVAL_KEY_PREFIX);
}

export function createAliasRemovalMarker(
  stamp: HlcTimestamp,
  marker: AliasRemovalMarker,
): { key: string; state: SyncAliasState } {
  const payload = encodeURIComponent(
    JSON.stringify([1, marker.aliasKey, marker.counterNodeId]),
  );
  return {
    key: `${ALIAS_REMOVAL_KEY_PREFIX}${payload}`,
    state: {
      text: "",
      textStamp: stamp,
      counters: createDictionaryMap<number>(),
      // 隐藏 marker 不参与展示；这里借用旧版 merge 已有的 max 寄存器保存删除下界。
      lastSeenAt: marker.removedCount,
    },
  };
}

export function parseAliasRemovalMarker(
  aliasKey: string,
  alias: SyncAliasState,
): AliasRemovalMarker | null {
  if (!isAliasRemovalMarkerKey(aliasKey)) return null;
  try {
    const raw = JSON.parse(
      decodeURIComponent(aliasKey.slice(ALIAS_REMOVAL_KEY_PREFIX.length)),
    );
    if (!Array.isArray(raw) || raw.length !== 3 || raw[0] !== 1) return null;
    const [, removedAliasKey, counterNodeId] = raw;
    if (
      typeof removedAliasKey !== "string" ||
      removedAliasKey.length === 0 ||
      isAliasRemovalMarkerKey(removedAliasKey)
    ) {
      return null;
    }
    if (typeof counterNodeId !== "string" || counterNodeId.length === 0)
      return null;
    if (!Number.isSafeInteger(alias.lastSeenAt) || alias.lastSeenAt <= 0)
      return null;
    if (Object.values(alias.counters).some((count) => count > 0)) return null;
    return {
      aliasKey: removedAliasKey,
      counterNodeId,
      removedCount: alias.lastSeenAt,
    };
  } catch {
    return null;
  }
}

export function indexAliasRemovalMarkers(
  aliases: Readonly<Record<string, SyncAliasState>>,
): AliasRemovalIndex {
  const index: AliasRemovalIndex = new Map();
  for (const [aliasKey, alias] of Object.entries(aliases)) {
    const marker = parseAliasRemovalMarker(aliasKey, alias);
    if (!marker) continue;
    let removal = index.get(marker.aliasKey);
    if (!removal) {
      removal = {
        floor: createDictionaryMap<number>(),
        latestStamp: alias.textStamp,
      };
      index.set(marker.aliasKey, removal);
    }
    removal.floor[marker.counterNodeId] = Math.max(
      removal.floor[marker.counterNodeId] ?? 0,
      marker.removedCount,
    );
    if (compareHlc(alias.textStamp, removal.latestStamp) > 0) {
      removal.latestStamp = alias.textStamp;
    }
  }
  return index;
}

export function readAliasVisibleCount(
  counters: GCounter,
  removalFloor?: GCounter,
): number {
  let total = 0;
  for (const [nodeId, value] of Object.entries(counters)) {
    if (!Number.isFinite(value) || value <= 0) continue;
    total += Math.max(0, Math.floor(value) - (removalFloor?.[nodeId] ?? 0));
  }
  return total;
}

/**
 * 读取一个别名的当前可见计数。
 *
 * GC 后同一节点重新添加别名时，旧副本可能带回更高的历史计数与删除下界，让
 * GCounter 差值重新变成 0。别名的 LWW 文本时间戳同时承担这一代“重新添加”的
 * 证据：它晚于最新删除 marker 时至少保留 1 次用户确认，避免旧下界吞掉新值。
 */
export function readAliasStateVisibleCount(
  alias: SyncAliasState,
  removal?: AliasRemovalState,
): number {
  const count = readAliasVisibleCount(alias.counters, removal?.floor);
  if (count > 0 || !removal) return count;
  return compareHlc(alias.textStamp, removal.latestStamp) > 0 ? 1 : 0;
}

/**
 * 成组回收已经不可见且删除时间超过 TTL 的别名与删除下界。
 *
 * 原别名和 marker 必须一起删除：只删其中一边，要么会让旧计数立刻复活，要么会
 * 留下永远没有展示意义的孤儿状态。超过 TTL 才回流的旧副本仍可能把别名带回来，
 * 这个兼容边界与词条化身墓碑回收一致。
 */
export function gcExpiredRemovedAliases(
  aliases: Readonly<Record<string, SyncAliasState>>,
  thresholdMs: number,
): Record<string, SyncAliasState> {
  const floors = indexAliasRemovalMarkers(aliases);
  const latestRemovalMs = new Map<string, number>();
  for (const [aliasKey, alias] of Object.entries(aliases)) {
    const marker = parseAliasRemovalMarker(aliasKey, alias);
    if (!marker) continue;
    latestRemovalMs.set(
      marker.aliasKey,
      Math.max(latestRemovalMs.get(marker.aliasKey) ?? 0, hlcWallMs(alias.textStamp)),
    );
  }

  const expiredAliasKeys = new Set<string>();
  for (const [aliasKey, removalMs] of latestRemovalMs) {
    const alias = aliases[aliasKey];
    if (alias && readAliasStateVisibleCount(alias, floors.get(aliasKey)) > 0) continue;
    if (removalMs < thresholdMs) expiredAliasKeys.add(aliasKey);
  }
  if (expiredAliasKeys.size === 0) return aliases as Record<string, SyncAliasState>;

  const collected = createDictionaryMap<SyncAliasState>();
  for (const [aliasKey, alias] of Object.entries(aliases)) {
    const marker = parseAliasRemovalMarker(aliasKey, alias);
    const removedAliasKey = marker?.aliasKey ?? aliasKey;
    if (!expiredAliasKeys.has(removedAliasKey)) collected[aliasKey] = alias;
  }
  return collected;
}
