/**
 * Pages of an agent-driven browser where the owner just typed a secret through
 * 代输入. Until that tab leaves the page, the agent's page-reading browser tools
 * (script evaluation, network requests and bodies, console) are refused there:
 * the submitted form, or a script, could otherwise hand the secret to the model.
 *
 * Kept in memory only; it holds page addresses, never values.
 */

const TAINT_TTL_MS = 15 * 60_000;
const MAX_PAGES = 32;
const tainted = new Map<string, number>();

/** Same document for this purpose: scheme, host, port and path (query and fragment ignored). */
function pageKey(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return null;
  }
}

function prune(now: number): void {
  for (const [key, until] of tainted) if (until <= now) tainted.delete(key);
}

export function markSecretEntered(url: string | undefined, now = Date.now()): void {
  const key = url ? pageKey(url) : null;
  if (!key) return;
  prune(now);
  tainted.delete(key);
  tainted.set(key, now + TAINT_TTL_MS);
  while (tainted.size > MAX_PAGES) tainted.delete(tainted.keys().next().value as string);
}

export function hasSecretPages(now = Date.now()): boolean {
  prune(now);
  return tainted.size > 0;
}

export function isSecretPage(url: string | undefined, now = Date.now()): boolean {
  const key = url ? pageKey(url) : null;
  if (!key) return false;
  prune(now);
  return tainted.has(key);
}

/** Tests only. */
export function clearSecretPages(): void {
  tainted.clear();
}
