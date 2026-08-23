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

import type { HlcTimestamp } from "./hlc";
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

export type AliasRemovalIndex = Map<string, GCounter>;

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
    let floor = index.get(marker.aliasKey);
    if (!floor) {
      floor = createDictionaryMap<number>();
      index.set(marker.aliasKey, floor);
    }
    floor[marker.counterNodeId] = Math.max(
      floor[marker.counterNodeId] ?? 0,
      marker.removedCount,
    );
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
