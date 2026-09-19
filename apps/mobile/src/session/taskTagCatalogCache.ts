import { normalizeTaskTags, type TaskTag, type TaskTagColor } from '@cindy/maker-shared';

// Account/device scoped last-known directories survive panel and page unmounts.
// A disconnect retains display data; revocation and account changes clear it.
type Catalog = { tags: TaskTag[]; supportedColors?: readonly TaskTagColor[] };
const catalogs = new Map<string, Catalog>();
// Account resets invalidate every request; peer eviction affects only that peer.
let generation = 0;
const deviceGenerations = new Map<string, number>();
const keyFor = (owner: string, device: string) => JSON.stringify([owner, device]);

export function taskTagCacheGeneration(device: string) {
  return `${generation}:${deviceGenerations.get(device) ?? 0}`;
}

export function readTaskTagCatalog(
  owner: string | null | undefined,
  device: string | null | undefined,
) {
  return owner && device ? catalogs.get(keyFor(owner, device)) : undefined;
}

export function sameTaskTags(a: readonly TaskTag[], b: readonly TaskTag[]) {
  return (
    a.length === b.length &&
    a.every((tag, i) => {
      const other = b[i];
      return (
        tag.id === other.id &&
        tag.name === other.name &&
        tag.color === other.color &&
        tag.revision === other.revision &&
        tag.sortOrder === other.sortOrder &&
        tag.favoriteOrder === other.favoriteOrder
      );
    })
  );
}

export function writeTaskTagCatalog(
  owner: string | null | undefined,
  device: string,
  tags: unknown,
  supportedColors?: readonly TaskTagColor[],
) {
  if (!owner) return;
  const key = keyFor(owner, device);
  const previous = catalogs.get(key);
  const normalized = normalizeTaskTags(tags, 256);
  const entry: Catalog = {
    tags: previous && sameTaskTags(previous.tags, normalized) ? previous.tags : normalized,
    supportedColors: supportedColors ?? previous?.supportedColors,
  };
  catalogs.delete(key);
  catalogs.set(key, entry);
  if (catalogs.size > 32) catalogs.delete(catalogs.keys().next().value!);
  return entry;
}

export function evictTaskTagCatalog(device: string) {
  deviceGenerations.set(device, (deviceGenerations.get(device) ?? 0) + 1);
  for (const key of catalogs.keys()) {
    if (JSON.parse(key)[1] === device) catalogs.delete(key);
  }
}

export function resetTaskTagCatalogCache() {
  generation++;
  deviceGenerations.clear();
  catalogs.clear();
}
