/** Normalize the Base URL exactly once before DSH's string-appending adapter consumes it. */
export function normalizeDshProviderBaseUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  // URL.search/hash are empty for a trailing bare separator (`...?` / `...#`) even though href
  // preserves it. Reject from the raw value so the adapter and diagnostics cannot normalize the
  // same input to different string-appended request paths.
  if (trimmed.includes('?') || trimmed.includes('#')) return null;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password || url.search || url.hash) return null;
    // The published adapter appends `/chat/completions` as a string. Strip every trailing slash
    // so diagnostics, model discovery, and real sessions address the same path.
    return url.toString().replace(/\/+$/, '');
  } catch {
    return null;
  }
}
