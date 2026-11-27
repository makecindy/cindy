/**
 * Cloud Cindy copy lives in `locales/<locale>/cloud.json`, not in `common.json`.
 * The renderer (renderer/i18n/cloudStrings.ts) and the main process (main/cloudStrings.ts)
 * both fold it into `common` with this merge, so call sites keep their keys.
 */
type Bundle = Record<string, unknown>;

const isObject = (value: unknown): value is Bundle =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Adds cloud keys to a common bundle without mutating either input. Existing keys win. */
export function mergeCloudStrings(common: Bundle, cloud: Bundle): Bundle {
  const merged: Bundle = { ...common };
  for (const [key, value] of Object.entries(cloud)) {
    const existing = merged[key];
    if (existing === undefined) merged[key] = value;
    else if (isObject(existing) && isObject(value)) merged[key] = mergeCloudStrings(existing, value);
  }
  return merged;
}
