/**
 * Favicon URLs share the tab's 16KB persisted-state budget with URL and title.
 * Keep ample headroom for those fields and reject schemes that cannot survive
 * a restart. The store still enforces the authoritative whole-state limit.
 */
const MAX_PERSISTED_FAVICON_URL_BYTES = 8 * 1024;

export function normalizePersistableFavicon(candidate: string): string | null {
  const trimmed = candidate.trim();
  if (!trimmed || /^(?:data|blob):/i.test(trimmed)) return null;
  if (new TextEncoder().encode(trimmed).byteLength > MAX_PERSISTED_FAVICON_URL_BYTES) return null;
  return trimmed;
}

export function selectPersistableFavicon(candidates: string[]): string {
  for (const candidate of candidates) {
    const normalized = normalizePersistableFavicon(candidate);
    if (normalized) return normalized;
  }
  return '';
}
