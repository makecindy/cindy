import { mergeModelMetadata, parseModelsListResponse, type DiscoveredModel } from '@cindy/model-providers';

/** Follow catalog cursors only on the original endpoint. Never forward credentials to a next-link host. */
export async function collectModelDiscoveryPages(
  first: unknown,
  endpoint: string,
  fetchPage: (url: string) => Promise<unknown>,
): Promise<DiscoveredModel[] | null> {
  const origin = new URL(endpoint);
  const visited = new Set([origin.toString()]);
  const models = new Map<string, DiscoveredModel>();
  let page = first;
  let current = origin;
  for (let count = 0; count < 100; count++) {
    const parsed = parseModelsListResponse(page, endpoint);
    if (!parsed) return models.size ? [...models.values()] : null;
    for (const model of parsed) {
      const previous = models.get(model.id);
      models.set(model.id, previous ? {
        ...previous,
        ...model,
        name: model.discoveredMetadata?.name ?? previous.discoveredMetadata?.name ?? previous.name,
        contextWindow: model.contextWindow ?? previous.contextWindow,
        discoveredMetadata: mergeModelMetadata(previous.discoveredMetadata, model.discoveredMetadata),
        ...(previous.discoveredCost || model.discoveredCost
          ? { discoveredCost: { ...previous.discoveredCost, ...model.discoveredCost } } : {}),
      } : model);
      if (models.size >= 10_000) return [...models.values()];
    }
    if (!page || typeof page !== 'object' || Array.isArray(page)) break;
    const data = page as Record<string, unknown>;
    const next = new URL(current);
    const token = data.nextPageToken ?? data.next_page_token;
    const cursor = data.next_cursor;
    const link = data.next ?? (data.links as { next?: unknown } | undefined)?.next;
    if (typeof token === 'string' && token) next.searchParams.set(typeof data.nextPageToken === 'string' ? 'pageToken' : 'page_token', token);
    else if (typeof cursor === 'string' && cursor) next.searchParams.set('cursor', cursor);
    else if (data.has_more === true && typeof data.last_id === 'string' && data.last_id)
      next.searchParams.set('after_id', data.last_id);
    else if (typeof link === 'string' && link) {
      let resolved: URL;
      try { resolved = new URL(link, current); } catch { break; }
      if (resolved.origin !== origin.origin || resolved.pathname !== origin.pathname || resolved.username || resolved.password) break;
      next.href = resolved.href;
    } else break;
    if (visited.has(next.toString())) break;
    visited.add(next.toString());
    try { page = await fetchPage(next.toString()); } catch { break; }
    current = next;
  }
  return [...models.values()];
}
