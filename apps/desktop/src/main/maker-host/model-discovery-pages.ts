import { isOpenRouterModelsUrl, mergeModelMetadata, parseModelsListResponse, type DiscoveredModel } from '@cindy/model-providers';

/** Follow catalog cursors only on the original endpoint. Never forward credentials to a next-link host. */
export async function collectModelDiscoveryPages(
  first: unknown,
  endpoint: string,
  fetchPage: (url: string) => Promise<unknown>,
  requireComplete = false,
): Promise<DiscoveredModel[] | null> {
  const origin = new URL(endpoint);
  const visited = new Set([origin.toString()]);
  const models = new Map<string, DiscoveredModel>();
  // Additive discovery may keep partial pages. A saved refresh replaces members,
  // so neither an error envelope nor a truncated response is a usable snapshot.
  const parsePage = (page: unknown, sourceUrl = endpoint) => {
    const parsed = parseModelsListResponse(page, sourceUrl);
    if (!requireComplete || !parsed) return parsed;
    const body = page && typeof page === 'object' && !Array.isArray(page)
      ? page as Record<string, unknown> : null;
    if (body && ((body.error != null && body.error !== '') || body.success === false
      || (body.error_code !== undefined && body.error_code !== 0))) return null;
    const rows = Array.isArray(page) ? page : Array.isArray(body?.data) ? body.data : body?.models;
    // Validate identity with the same parser, without endpoint-specific filtering
    // (for example Vercel's non-language models). Google lists also contain
    // well-formed entries whose generation methods intentionally exclude chat.
    if (Array.isArray(rows) && rows.some(row => {
      const single = parseModelsListResponse([row]);
      if (single?.length) return !single[0].id.trim();
      return !(row && typeof row === 'object' && typeof row.name === 'string'
        && row.name.startsWith('models/') && row.name.length > 'models/'.length
        && Array.isArray(row.supportedGenerationMethods)
        && !row.supportedGenerationMethods.includes('generateContent'));
    })) return null;
    return parsed;
  };
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
    const parsed = parsePage(page);
    if (!parsed) return !requireComplete && models.size ? [...models.values()] : null;
    append(parsed);
    if (models.size >= 10_000) return requireComplete ? null : [...models.values()];
    if (!page || typeof page !== 'object' || Array.isArray(page)) { complete = true; break; }
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
      try { resolved = new URL(link, current); } catch { if (requireComplete) return null; break; }
      if (resolved.origin !== origin.origin || resolved.pathname !== origin.pathname || resolved.username || resolved.password) {
        if (requireComplete) return null;
        break;
      }
      next.href = resolved.href;
    } else {
      if (requireComplete && data.has_more === true) return null;
      complete = true;
      break;
    }
    if (visited.has(next.toString())) { if (requireComplete) return null; break; }
    visited.add(next.toString());
    try { page = await fetchPage(next.toString()); } catch { if (requireComplete) return null; break; }
    current = next;
  }
  if (requireComplete && !complete) return null;
  // The ordinary OpenRouter list excludes speech. Fetch its separate catalog on
  // the same credential-owned endpoint, using the caller's timeout/byte limits.
  // Explicit filtered catalogs stay user-owned. A speech outage must not discard chat.
  if (isOpenRouterModelsUrl(endpoint) && !origin.search && !origin.username && !origin.password) {
    const speech = new URL(origin);
    speech.searchParams.set('output_modalities', 'speech');
    try {
      const parsed = parsePage(await fetchPage(speech.toString()), speech.toString());
      if (requireComplete && !parsed) return null;
      append((parsed ?? []).filter(model => model.discoveredMetadata?.mode === 'audio_speech'));
    } catch { if (requireComplete) return null; /* Additive discovery keeps its completed pages. */ }
  }
  return [...models.values()];
}
