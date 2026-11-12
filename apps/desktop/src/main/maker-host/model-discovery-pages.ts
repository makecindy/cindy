import { isOpenRouterModelsUrl, mergeModelMetadata, parseModelsListResponse, type DiscoveredModel } from '@cindy/model-providers';

function isBusinessError(page: unknown): boolean {
  if (!page || typeof page !== 'object' || Array.isArray(page)) return false;
  const data = page as { error?: unknown; error_code?: unknown };
  return (data.error != null && data.error !== '')
    || (data.error_code !== undefined && data.error_code !== 0);
}

/** Follow catalog cursors only on the original endpoint. Never forward credentials to a next-link host. */
export async function collectModelDiscoveryPages(
  first: unknown,
  endpoint: string,
  fetchPage: (url: string) => Promise<unknown>,
  options: { requireComplete?: boolean } = {},
): Promise<DiscoveredModel[] | null> {
  const origin = new URL(endpoint);
  const visited = new Set([origin.toString()]);
  const models = new Map<string, DiscoveredModel>();
  const append = (parsed: DiscoveredModel[]) => {
    for (const model of parsed) {
      if (models.size >= 10_000) break;
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
  let complete = false;
  for (let count = 0; count < 100; count++) {
    // A successful HTTP status does not prove a complete, authoritative catalog.
    if (options.requireComplete && isBusinessError(page)) return null;
    const parsed = parseModelsListResponse(page, endpoint, { requireValidEntries: options.requireComplete });
    if (!parsed) return !options.requireComplete && models.size ? [...models.values()] : null;
    append(parsed);
    if (models.size >= 10_000) return options.requireComplete ? null : [...models.values()];
    if (!page || typeof page !== 'object' || Array.isArray(page)) { complete = true; break; }
    const data = page as Record<string, unknown>;
    // Non-boolean continuation flags cannot establish an authoritative end.
    if (options.requireComplete && data.has_more != null && typeof data.has_more !== 'boolean') return null;
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
    } else {
      complete = data.has_more !== true && !token && !cursor && !link;
      break;
    }
    if (visited.has(next.toString())) break;
    visited.add(next.toString());
    try { page = await fetchPage(next.toString()); } catch { break; }
    current = next;
  }
  // Failure, malformed continuation, cycle, unsafe link or budget exhaustion
  // is useful for best-effort import, but cannot prove a saved ID was removed.
  if (options.requireComplete && !complete) return null;
  // The ordinary OpenRouter list excludes speech. Fetch its separate catalog on
  // the same credential-owned endpoint, using the caller's timeout/byte limits.
  // Explicit filtered catalogs stay user-owned. A speech outage must not discard chat.
  if (isOpenRouterModelsUrl(endpoint) && !origin.search && !origin.username && !origin.password) {
    const speech = new URL(origin);
    speech.searchParams.set('output_modalities', 'speech');
    try {
      const page = await fetchPage(speech.toString());
      if (options.requireComplete && isBusinessError(page)) return null;
      const parsed = parseModelsListResponse(page, speech.toString(), { requireValidEntries: options.requireComplete });
      if (!parsed && options.requireComplete) return null;
      append((parsed ?? []).filter(model => model.discoveredMetadata?.mode === 'audio_speech'));
    } catch {
      if (options.requireComplete) return null;
      /* Best-effort imports retain the successfully fetched chat catalog. */
    }
  }
  return [...models.values()];
}
