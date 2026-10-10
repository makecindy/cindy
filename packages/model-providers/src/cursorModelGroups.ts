/** Cursor picker groups are display metadata, never routing or billing authorization. */
export const CURSOR_MODEL_GROUPS = {
  auto: 'cursor:auto',
  models: 'cursor:models',
  other: 'cursor:other',
} as const;

// Verified against https://prod.cursor.com/help/models-and-usage/usage-limits
// on 2026-10-09. ACP currently omits pool labels. Only classify offered models;
// unknown first-party versions stay unclassified until upstream identifies them.
const CURSOR_POOL_MODELS = new Set(['grok-4.7', 'grok-4.6', 'grok-4.5', 'composer-2.5']);
const THIRD_PARTY_MODEL = /^(?:claude-|gpt-|codex-|gemini-|muse-|kimi-|glm-)/;
const NATIVE_GROUP_PREFIX = 'cursor:native:';
const CANONICAL_GROUPS = new Set<string>(Object.values(CURSOR_MODEL_GROUPS));

export function cursorModelGroup(id: string, name: string, nativeGroup?: string): string | undefined {
  if (name === 'Auto') return CURSOR_MODEL_GROUPS.auto;
  if (nativeGroup) {
    if (nativeGroup === 'Cursor Models') return CURSOR_MODEL_GROUPS.models;
    if (nativeGroup === 'Other Models') return CURSOR_MODEL_GROUPS.other;
    // Catalog group metadata is bounded to 128 characters.
    return nativeGroup.length <= 128 - NATIVE_GROUP_PREFIX.length ? `${NATIVE_GROUP_PREFIX}${nativeGroup}` : undefined;
  }
  if (CURSOR_POOL_MODELS.has(id)) return CURSOR_MODEL_GROUPS.models;
  if (THIRD_PARTY_MODEL.test(id)) return CURSOR_MODEL_GROUPS.other;
  return undefined;
}

/** Split within a provider; retain native order, source identity and unclassified offers. */
export function providerModelDisplayGroups<T>(
  providerId: string,
  items: readonly T[],
  groupOf: (item: T) => string | undefined,
): { group: string | null; items: T[] }[] {
  if (!items.length) return [];
  if (providerId !== 'cursor') return [{ group: null, items: [...items] }];
  const groups = new Map<string | null, T[]>();
  for (const item of items) {
    const value = groupOf(item);
    const group = value && (CANONICAL_GROUPS.has(value)
      || value.startsWith(NATIVE_GROUP_PREFIX)) ? value : null;
    const bucket = groups.get(group);
    if (bucket) bucket.push(item);
    else groups.set(group, [item]);
  }
  const order: (string | null)[] = [CURSOR_MODEL_GROUPS.auto, CURSOR_MODEL_GROUPS.models, CURSOR_MODEL_GROUPS.other];
  for (const group of groups.keys()) if (!order.includes(group)) order.push(group);
  return order.filter(group => groups.has(group)).map(group => ({ group, items: groups.get(group)! }));
}

/** Official pool names are localized by each client; remote headings retain their computer name. */
export function providerModelDisplayGroupTitle(
  provider: string,
  group: string | null | undefined,
  labels: { models: string; other: string },
): string {
  const label = group === CURSOR_MODEL_GROUPS.models ? labels.models
    : group === CURSOR_MODEL_GROUPS.other ? labels.other
    : group?.startsWith(NATIVE_GROUP_PREFIX) ? group.slice(NATIVE_GROUP_PREFIX.length) : null;
  return label ? provider === 'Cursor' ? label : `${provider} · ${label}` : provider;
}
