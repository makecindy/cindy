/**
 * Provider display-order helpers shared by Main and Renderer.
 *
 * The persisted value is an override, not a catalog snapshot: known ids follow the
 * user's explicit order and providers introduced later append in catalog order.
 */

export const MAX_PROVIDER_ORDER_ITEMS = 4096;
export const MAX_PROVIDER_ORDER_ID_LENGTH = 256;

/** Normalize untrusted persisted data without allowing duplicate or unbounded ids. */
export function normalizeProviderOrder(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const order: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.length > MAX_PROVIDER_ORDER_ID_LENGTH ||
      seen.has(value)
    ) {
      continue;
    }
    seen.add(value);
    order.push(value);
    if (order.length >= MAX_PROVIDER_ORDER_ITEMS) break;
  }
  return order;
}

/** Apply an explicit display order while appending unseen providers in source order. */
export function applyProviderOrder<T extends { id: string }>(
  providers: readonly T[],
  order: readonly string[],
): T[] {
  const byId = new Map(providers.map((provider) => [provider.id, provider]));
  const result: T[] = [];
  const included = new Set<string>();
  for (const id of order) {
    const provider = byId.get(id);
    if (!provider || included.has(id)) continue;
    included.add(id);
    result.push(provider);
  }
  for (const provider of providers) {
    if (included.has(provider.id)) continue;
    included.add(provider.id);
    result.push(provider);
  }
  return result;
}

/** Id-only variant of applyProviderOrder for callers that hold plain provider ids. */
export function applyProviderOrderIds(
  ids: readonly string[],
  order: readonly string[],
): string[] {
  return applyProviderOrder(
    ids.map((id) => ({ id })),
    order,
  ).map((item) => item.id);
}

/**
 * Replace only the visible providers' slots in a full catalog order. This keeps
 * currently hidden/disconnected providers stable when the settings list is reordered.
 */
export function mergeVisibleProviderOrder(
  currentOrder: readonly string[],
  reorderedVisibleIds: readonly string[],
): string[] {
  const reorderedSet = new Set(reorderedVisibleIds);
  if (reorderedSet.size !== reorderedVisibleIds.length) return [...currentOrder];
  const currentSet = new Set(currentOrder);
  if (reorderedVisibleIds.some((id) => !currentSet.has(id))) {
    return [...currentOrder];
  }
  let visibleIndex = 0;
  return currentOrder.map((id) =>
    reorderedSet.has(id) ? reorderedVisibleIds[visibleIndex++]! : id,
  );
}

/**
 * Add providers the first time they appear, then apply the visible-list order while
 * retaining previously observed providers that are currently hidden.
 */
export function mergeObservedProviderOrder(
  currentOrder: readonly string[],
  reorderedVisibleIds: readonly string[],
): string[] {
  if (new Set(reorderedVisibleIds).size !== reorderedVisibleIds.length) {
    return [...currentOrder];
  }
  const expanded = [...currentOrder];
  const seen = new Set(currentOrder);
  for (const id of reorderedVisibleIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    expanded.push(id);
  }
  return mergeVisibleProviderOrder(expanded, reorderedVisibleIds);
}
