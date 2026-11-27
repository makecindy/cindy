import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The domains of one settings batch read the model catalog once between them; nothing outlives
 * the batch. A failed read is not shared, so the next domain reads again.
 */
const batch = new AsyncLocalStorage<{ catalog?: Promise<unknown> }>();

export function withSharedSettingsModelCatalog<T>(read: () => Promise<T>): Promise<T> {
  return batch.run({}, read);
}

export function sharedSettingsModelCatalog<T>(read: () => Promise<T>): Promise<T> {
  const scope = batch.getStore();
  if (!scope) return read();
  if (!scope.catalog) {
    const pending = read();
    scope.catalog = pending;
    pending.catch(() => { if (scope.catalog === pending) scope.catalog = undefined; });
  }
  return scope.catalog as Promise<T>;
}
