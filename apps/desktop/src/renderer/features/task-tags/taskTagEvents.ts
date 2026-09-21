import { normalizeTaskTags, type TaskTag, type TaskTagColor } from '@cindy/maker-shared';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';

type Catalog = { tags: TaskTag[]; supportedColors?: readonly TaskTagColor[] };
const catalogs = new Map<string | undefined, Catalog>();
let owner = getDataOwnerGeneration();
let generation = 0;
let requestSequence = 0;
const deviceGenerations = new Map<string | undefined, number>();
const catalogGenerations = new Map<string | undefined, number>();
function ensureOwner() {
  if (!isDataOwnerGenerationCurrent(owner)) {
    resetTaskTagCatalogCache();
    owner = getDataOwnerGeneration();
  }
}
export function resetTaskTagCatalogCache() {
  generation++;
  catalogs.clear();
  deviceGenerations.clear();
  catalogGenerations.clear();
}
export function evictTaskTagCatalog(deviceId: string) {
  ensureOwner();
  catalogs.delete(deviceId);
  deviceGenerations.set(deviceId, (deviceGenerations.get(deviceId) ?? 0) + 1);
  for (const listener of listeners) listener(deviceId, []);
}
export function readTaskTagCatalog(deviceId: string | undefined) {
  ensureOwner();
  return catalogs.get(deviceId);
}
export function captureTaskTagScope(deviceId: string | undefined) {
  ensureOwner();
  const capturedOwner = owner;
  const capturedGeneration = generation;
  const peer = deviceGenerations.get(deviceId);
  const sequence = ++requestSequence;
  const current = () =>
    isDataOwnerGenerationCurrent(capturedOwner) &&
    generation === capturedGeneration &&
    deviceGenerations.get(deviceId) === peer;
  return {
    current,
    store(tags: TaskTag[], supportedColors?: readonly TaskTagColor[]) {
      if (!current() || (catalogGenerations.get(deviceId) ?? 0) > sequence) return;
      catalogGenerations.set(deviceId, sequence);
      const previous = catalogs.get(deviceId);
      catalogs.delete(deviceId);
      catalogs.set(deviceId, {
        tags: normalizeTaskTags(tags, 256),
        supportedColors: supportedColors ?? previous?.supportedColors,
      });
      if (catalogs.size > 32) catalogs.delete(catalogs.keys().next().value);
    },
  };
}
// Emitted only after the existing local/remote owner ingress guards accept a push.
const listeners = new Set<(deviceId: string | undefined, tags: TaskTag[]) => void>();
export function emitTaskTagCatalog(deviceId: string | undefined, tags: TaskTag[]): void {
  captureTaskTagScope(deviceId).store(tags);
  for (const listener of listeners) listener(deviceId, tags);
}
export function subscribeTaskTagCatalog(
  listener: (deviceId: string | undefined, tags: TaskTag[]) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
