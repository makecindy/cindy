import type { TaskTag } from '@cindy/maker-shared';
// Emitted only after the existing local/remote owner ingress guards accept a push.
const listeners = new Set<(deviceId: string | undefined, tags: TaskTag[]) => void>();
export function emitTaskTagCatalog(deviceId: string | undefined, tags: TaskTag[]): void {
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
