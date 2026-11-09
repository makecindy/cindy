/** Retain equal parts of a JSON response so polling does not invalidate a rendered
 * conversation. Compare every field (including removals); this is presentation
 * sharing, never a freshness or authorization cache. Non-JSON values pass through. */
export function reuseJsonSnapshot<T>(previous: unknown, next: T, depth = 0): T {
  if (Object.is(previous, next)) return previous as T;
  if (!previous || !next || typeof previous !== 'object' || typeof next !== 'object' || depth > 64) return next;
  const array = Array.isArray(next);
  if (array !== Array.isArray(previous)) return next;
  if (!array && (Object.getPrototypeOf(previous) !== Object.prototype || Object.getPrototypeOf(next) !== Object.prototype)) return next;
  const old = previous as Record<string, unknown>;
  const value = next as Record<string, unknown>;
  const keys = Object.keys(value);
  const shared = (array ? new Array((next as unknown[]).length) : {}) as Record<string, unknown>;
  let equal = keys.length === Object.keys(old).length && (!array || (previous as unknown[]).length === (next as unknown[]).length);
  for (const key of keys) {
    const owns = Object.prototype.hasOwnProperty.call(old, key);
    const child = owns ? reuseJsonSnapshot(old[key], value[key], depth + 1) : value[key];
    // A JSON field named __proto__ is data too, not a prototype assignment.
    if (key === '__proto__') Object.defineProperty(shared, key, { value: child, enumerable: true, configurable: true, writable: true });
    else shared[key] = child;
    if (!owns || !Object.is(child, old[key])) equal = false;
  }
  return equal ? previous as T : shared as T;
}
