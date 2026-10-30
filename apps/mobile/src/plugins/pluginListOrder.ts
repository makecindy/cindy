import type { HostedRemoteCollectionItem } from "@/device-link/remoteResources";

const addedAt = (item: HostedRemoteCollectionItem) => {
  const value = item.item.pluginOrder?.addedAt;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : 0;
};
const hostRecentIndex = (item: HostedRemoteCollectionItem) => {
  const value = item.item.pluginOrder?.recentIndex;
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value < 100
    ? value
    : undefined;
};

/** Notification time, version and local discovery time are never installation facts. */
export function sortPluginItems(
  items: readonly HostedRemoteCollectionItem[],
  recentKeys: readonly string[],
): HostedRemoteCollectionItem[] {
  const recent = new Map(recentKeys.map((key, index) => [key, index]));
  const rank = (item: HostedRemoteCollectionItem) => {
    const local = recent.get(item.key);
    if (local !== undefined) return local;
    const host = hostRecentIndex(item);
    return host !== undefined ? recentKeys.length + host : Infinity;
  };
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const left = rank(a.item),
        right = rank(b.item);
      if (left !== right) return left - right;
      return addedAt(b.item) - addedAt(a.item) || a.index - b.index;
    })
    .map(({ item }) => item);
}
