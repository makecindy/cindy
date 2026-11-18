import { isOpenRouterModelsUrl, mergeModelMetadata, parseModelsListResponse, parseModelsListResponseWithStatus, type DiscoveredModel } from '@cindy/model-providers';

export interface ModelDiscoveryPagesResult {
  models: DiscoveredModel[] | null;
  complete: boolean;
}

/** Follow catalog cursors only on the original endpoint. Never forward credentials to a next-link host. */
export async function collectModelDiscoveryPages(
  first: unknown,
  endpoint: string,
  fetchPage: (url: string) => Promise<unknown>,
): Promise<DiscoveredModel[] | null> {
  const { models } = await collectModelDiscoveryPagesWithStatus(first, endpoint, fetchPage);
  return models;
}

/** Same pagination collector as `collectModelDiscoveryPages`, while reporting whether the full catalog completed. */
export async function collectModelDiscoveryPagesWithStatus(
  first: unknown,
  endpoint: string,
  fetchPage: (url: string) => Promise<unknown>,
): Promise<ModelDiscoveryPagesResult> {
  const origin = new URL(endpoint);
  const visited = new Set([origin.toString()]);
  const models = new Map<string, DiscoveredModel>();
  let complete = true;
  const append = (parsed: DiscoveredModel[]) => {
    for (const model of parsed) {
      if (models.size >= 10_000) {
        complete = false;
        break;
      }
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
    }
  };
  let page = first;
  let current = origin;
  let count = 0;
  for (; count < 100; count++) {
    const parsedResult = parseModelsListResponseWithStatus(page, endpoint);
    if (!parsedResult) {
      return { models: models.size ? [...models.values()] : null, complete: false };
    }
    if (parsedResult.droppedInvalidItems) complete = false;
    const parsed = parsedResult.models;
    if (page && typeof page === 'object' && !Array.isArray(page)) {
      const obj = page as Record<string, unknown>;
      const hasError =
        ('error' in obj && obj.error != null && obj.error !== '') ||
        ('error_code' in obj && obj.error_code !== 0 && obj.error_code != null);
      if (hasError) complete = false;
    }
    append(parsed);
    if (models.size >= 10_000) return { models: [...models.values()], complete: false };
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
      try { resolved = new URL(link, current); } catch { complete = false; break; }
      if (resolved.origin !== origin.origin || resolved.pathname !== origin.pathname || resolved.username || resolved.password) {
        complete = false;
        break;
      }
      next.href = resolved.href;
    } else {
      if (data.has_more === true) complete = false;
      break;
    }
    if (visited.has(next.toString())) { complete = false; break; }
    visited.add(next.toString());
    try { page = await fetchPage(next.toString()); } catch { complete = false; break; }
    current = next;
  }
  if (count >= 100) complete = false;
  // The ordinary OpenRouter list excludes speech. Fetch its separate catalog on
  // the same credential-owned endpoint, using the caller's timeout/byte limits.
  // Explicit filtered catalogs stay user-owned. A speech outage must not discard chat.
  if (isOpenRouterModelsUrl(endpoint) && !origin.search && !origin.username && !origin.password) {
    const speech = new URL(origin);
    speech.searchParams.set('output_modalities', 'speech');
    try {
      const parsed = parseModelsListResponse(await fetchPage(speech.toString()), speech.toString());
      append((parsed ?? []).filter(model => model.discoveredMetadata?.mode === 'audio_speech'));
    } catch { /* Keep the successfully fetched catalog, as for a failed pagination request. */ }
  }
  return { models: [...models.values()], complete };
}
