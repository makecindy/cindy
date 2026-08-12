import type { ModelRegistry } from './modelAccessBean.js';

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortKeysDeep(source[key]);
    return out;
  }
  return value;
}

/**
 * Deterministic Registry serialization for immutable-revision checks. Object
 * key order is normalized; array order remains part of the snapshot contract.
 */
export function modelRegistryCanonicalJson(registry: ModelRegistry): string {
  return JSON.stringify(sortKeysDeep(registry));
}
