import type { TabRegistry } from '../rsb-browser-bridge/registry.js';

export interface AtBrowserTabCandidate {
  tabId: string;
  title: string;
  url: string;
}

export interface AtDesktopWindowCandidate {
  windowId: number;
  pid: number;
  appName: string;
  title: string;
}

function oneLine(value: unknown, maxLength: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function searchable(values: string[], query: string): boolean {
  const needle = query.trim().toLowerCase();
  return !needle || values.some((value) => value.toLowerCase().includes(needle));
}

function publicReferenceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // A tab id is sufficient for browser automation. Keep the readable page
    // location but never persist credentials, query tokens or fragments into
    // Composer drafts/messages.
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

export function listAtBrowserTabs(
  registry: TabRegistry,
  sessionId: string | undefined,
  query: string,
  limit: number,
): AtBrowserTabCandidate[] {
  if (!sessionId) return [];
  const items: AtBrowserTabCandidate[] = [];
  for (const record of registry.listBySession(sessionId)) {
    const contents = registry.getWebContentsByTabId(record.tabId);
    if (!contents) continue;
    let rawUrl = '';
    let rawTitle = '';
    try {
      rawUrl = contents.getURL?.() ?? '';
    } catch {
      // Guest disappeared between registry lookup and metadata read.
    }
    try {
      rawTitle = contents.getTitle?.() ?? '';
    } catch {
      // Same race as URL above; an empty title has a safe URL fallback.
    }
    const url = publicReferenceUrl(oneLine(rawUrl, 4_096));
    if (!url) continue;
    const title = oneLine(rawTitle, 200) || url;
    const tabId = oneLine(record.tabId, 256);
    if (!tabId || !searchable([title, url], query)) continue;
    items.push({ tabId, title, url });
    if (items.length >= limit) break;
  }
  return items;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function readAtDesktopWindows(
  value: unknown,
  query: string,
  limit: number,
  ownPid = process.pid,
): AtDesktopWindowCandidate[] {
  const root = objectValue(value);
  const rows = root && Array.isArray(root.windows) ? root.windows : [];
  const items: AtDesktopWindowCandidate[] = [];
  for (const row of rows) {
    const candidate = objectValue(row);
    if (!candidate || candidate.is_visible === false) continue;
    const windowId = Number(candidate.window_id ?? candidate.hwnd);
    const pid = Number(candidate.pid);
    if (
      !Number.isSafeInteger(windowId)
      || windowId < 0
      || !Number.isSafeInteger(pid)
      || pid <= 0
      || pid === ownPid
    ) continue;
    const appName = oneLine(candidate.app_name, 200) || `PID ${pid}`;
    const title = oneLine(candidate.title, 200);
    if (!title || !searchable([title, appName], query)) continue;
    items.push({ windowId, pid, appName, title });
    if (items.length >= limit) break;
  }
  return items;
}

export function parseAtContextCatalogRequest(value: unknown): {
  sessionId?: string;
  workingDir?: string;
  query: string;
  limit: number;
} | null {
  const candidate = objectValue(value);
  if (!candidate) return null;
  const sessionId = oneLine(candidate.sessionId, 256);
  const workingDir = typeof candidate.workingDir === 'string'
    ? candidate.workingDir.trim().slice(0, 32_768)
    : '';
  const query = oneLine(candidate.query, 200);
  const requestedLimit = Number(candidate.limit ?? 40);
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
    return null;
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(workingDir ? { workingDir } : {}),
    query,
    limit: requestedLimit,
  };
}
