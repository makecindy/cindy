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
/** Windows whose page could not be read (no address): the tab is told by its title. */
const taintedTitles = new Map<string, number>();

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
  for (const [key, until] of taintedTitles) if (until <= now) taintedTitles.delete(key);
}

/**
 * The owner types straight into a page the Host could not read, so its address is unknown: cover
 * the tab whose title the window shows. A window title is the tab title plus the browser's name.
 */
export function markSecretWindow(windowTitle: string | undefined, now = Date.now()): void {
  const title = windowTitle?.trim();
  if (!title) return;
  prune(now);
  taintedTitles.delete(title);
  taintedTitles.set(title, now + TAINT_TTL_MS);
  while (taintedTitles.size > MAX_PAGES)
    taintedTitles.delete(taintedTitles.keys().next().value as string);
}

/** A listed browser tab on a covered page, by address or, for an unreadable page, by title. */
export function isSecretTab(tab: { url?: unknown; title?: unknown }, now = Date.now()): boolean {
  if (typeof tab.url === 'string' && isSecretPage(tab.url, now)) return true;
  const title = typeof tab.title === 'string' ? tab.title.trim() : '';
  if (!title) return false;
  prune(now);
  for (const windowTitle of taintedTitles.keys()) if (windowTitle.includes(title)) return true;
  return false;
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
  return tainted.size > 0 || taintedTitles.size > 0;
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
  taintedTitles.clear();
}
