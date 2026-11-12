/**
 * Reuse pure projections of immutable history snapshots across view mounts.
 * One result per snapshot; weak keys let the history store's own eviction release it.
 * Every non-message input must be included in dependencies, as with useMemo.
 */
export function createMessageProjectionCache<K extends object, V>() {
  const snapshots = new WeakMap<K, { dependencies: readonly unknown[]; value: V }>();
  return (snapshot: K, dependencies: readonly unknown[], compute: () => V): V => {
    const previous = snapshots.get(snapshot);
    if (
      previous &&
      previous.dependencies.length === dependencies.length &&
      dependencies.every((value, index) => Object.is(value, previous.dependencies[index]))
    ) {
      return previous.value;
    }
    const value = compute();
    snapshots.set(snapshot, { dependencies: [...dependencies], value });
    return value;
  };
}
