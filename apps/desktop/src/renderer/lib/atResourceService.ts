import { createLogger } from '@/lib/logger';
import type { Session } from '@/lib/ccAgent.types';
import { buildSessionDeepLink } from '@/lib/deepLink';

const log = createLogger('AtResourceService');
/**
 * @-mention resource data layer — command-palette F2 / F5.
 *
 * Responsibilities:
 *   - Call maker → BaseAgent resource scanning and shape results into `AtResourceItem`.
 *   - Fuzzy-match + rank items against the user's query (what the user typed
 *     after the `@` trigger character).
 *   - Handle name conflicts (agent vs file with same name → agent wins).
 *
 * This module is pure TS, no React. The panel component consumes it.
 */

export type AtResourceType =
  | 'file'
  | 'dir'
  | 'agent'
  | 'browser-tab'
  | 'desktop-window'
  | 'session'
  | 'plugin-provider'
  | 'plugin-resource';

export interface AtResourceItem {
  type: AtResourceType;
  /** Display name:
   *  - file → basename with extension
   *  - dir  → basename (no trailing slash; UI adds it for visual hint)
   *  - agent → filename without `.md`
   */
  name: string;
  /** Workspace-relative path or stable Cindy context deep link. Used for:
   *  - display "apps/server/src/routes" (minus basename) in right column
   *  - serialization on submit: `@relPath` / `@relPath/` / `@.claude/agents/<name>.md`
   */
  relPath: string;
  /** Agent description from YAML frontmatter (agents only). */
  description?: string;
  /** Plugin display name for provider/resource rows and Agent projection. */
  sourceLabel?: string;
  /** Stable Plugin id. Present on provider/resource rows only. */
  pluginId?: string;
  /** @internal Pre-computed lowercase for filter performance. */
  _nameLower?: string;
  /** @internal Pre-computed lowercase for filter performance. */
  _relPathLower?: string;
}

export interface ScanResult {
  success: boolean;
  error?: string;
  items: AtResourceItem[];
  truncated: boolean;
}

export type PaletteAgentKind = 'claude-code' | 'codex' | 'pi';

export interface AtResourceScanContext {
  /** Current local task. Its built-in browser tabs are the only tabs exposed. */
  sessionId?: string;
  /** False for SSH/device-link so candidates never leak from the controller machine. */
  includeLocalContext?: boolean;
  /** Historical tasks are read from the execution device's local database. */
  includeTaskHistory?: boolean;
}

function browserTabReference(tabId: string, url: string): string {
  return `cindy://browser-tab/${encodeURIComponent(tabId)}?url=${encodeURIComponent(url)}`;
}

function desktopWindowReference(
  pid: number,
  windowId: number,
  appName: string,
): string {
  return `cindy://desktop-window/${pid}/${windowId}?app=${encodeURIComponent(appName)}`;
}

function oneLineText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

/**
 * Load candidate @-resources from independent workspace/context providers.
 * Partial provider failures keep the remaining candidates usable; the caller
 * receives `success:false` only when every applicable provider failed.
 *
 * De-dup rule (F5 spec): when an agent and a file share the same `name`,
 * the agent wins. This is extremely rare in practice but we log a warning
 * as the spec requires.
 */
export async function scanAtResources(
  workingDir: string,
  agentKind: PaletteAgentKind,
  cap = 2000,
  query?: string,
  /**
   * device-link 远程会话:传被控设备 deviceId → 经隧道在**被控端**扫描其文件
   * (workingDir 是被控端路径)。不传 = 本机扫描。channel 与本地完全一致,被控端跑同一 handler。
   */
  deviceId?: string,
  context?: AtResourceScanContext,
): Promise<ScanResult> {
  const includeLocalContext = context?.includeLocalContext === true;
  const includeTaskHistory = context?.includeTaskHistory === true;
  if (!workingDir && !includeLocalContext && !includeTaskHistory) {
    return { success: false, error: 'workingDir not bound', items: [], truncated: false };
  }
  type RawScan = Awaited<ReturnType<typeof window.electronAPI.maker.scanAtResources>>;
  const workspacePromise: Promise<RawScan | null> = workingDir
    ? deviceId
      ? (window.electronAPI.deviceLink.invoke(deviceId, 'maker:scan-at-resources', [
          agentKind,
          { workingDir, cap, query },
        ]) as Promise<RawScan>)
      : window.electronAPI.maker.scanAtResources(agentKind, { workingDir, cap, query })
    : Promise.resolve(null);
  const contextPromise = includeLocalContext
    ? window.electronAPI.maker.listAtContext({
        sessionId: context?.sessionId,
        workingDir: workingDir || undefined,
        query,
        limit: 40,
      })
    : Promise.resolve(null);
  const taskHistoryPromise: Promise<Session[] | null> = includeTaskHistory
    ? deviceId
      ? (window.electronAPI.deviceLink.invoke(
          deviceId,
          'local-db:sessions:list',
          [100, 'all'],
        ) as Promise<Session[]>)
      : window.electronAPI.localDb.sessions.list(100, 'all')
    : Promise.resolve(null);
  const pluginProvidersPromise = !deviceId
    ? window.electronAPI.ghosts.listAtResourceProviders({
        ...(context?.sessionId ? { sessionId: context.sessionId } : {}),
        ...(workingDir ? { workingDir } : {}),
      })
    : Promise.resolve(null);
  const [workspaceSettled, contextSettled, taskHistorySettled, pluginProvidersSettled] = await Promise.allSettled([
    workspacePromise,
    contextPromise,
    taskHistoryPromise,
    pluginProvidersPromise,
  ]);
  const res = workspaceSettled.status === 'fulfilled' ? workspaceSettled.value : null;
  const contextResult = contextSettled.status === 'fulfilled' ? contextSettled.value : null;
  const workspaceFailed = !!workingDir && (
    workspaceSettled.status === 'rejected' || !res?.success || !res.items
  );
  const contextFailed = includeLocalContext && contextSettled.status === 'rejected';
  const taskHistoryFailed = includeTaskHistory && taskHistorySettled.status === 'rejected';
  const pluginProvidersFailed = !deviceId && pluginProvidersSettled.status === 'rejected';
  if (workspaceFailed) {
    log.warn(
      'Workspace @ resource scan failed; keeping other providers available.',
      workspaceSettled.status === 'rejected' ? workspaceSettled.reason : res?.error,
    );
  }
  if (contextFailed) {
    log.warn(
      'Local @ context scan failed; keeping other providers available.',
      contextSettled.status === 'rejected' ? contextSettled.reason : undefined,
    );
  }
  if (taskHistoryFailed) {
    log.warn(
      'Historical @ task scan failed; keeping other providers available.',
      taskHistorySettled.status === 'rejected' ? taskHistorySettled.reason : undefined,
    );
  }
  if (pluginProvidersFailed) {
    log.warn(
      'Plugin @ provider listing failed; keeping other providers available.',
      pluginProvidersSettled.status === 'rejected' ? pluginProvidersSettled.reason : undefined,
    );
  }
  if (
    (!workingDir || workspaceFailed)
    && (!includeLocalContext || contextFailed)
    && (!includeTaskHistory || taskHistoryFailed)
    && (deviceId !== undefined || pluginProvidersFailed)
  ) {
    return {
      success: false,
      error: res?.error ?? 'scan failed',
      items: [],
      truncated: !!res?.truncated,
    };
  }

  // Split into buckets so we can apply the agent-wins rule, then
  // reassemble in a deterministic order (agents first in the raw list —
  // the UI will re-rank during filtering anyway).
  const agents: AtResourceItem[] = [];
  const files: AtResourceItem[] = [];
  const dirs: AtResourceItem[] = [];
  const agentNames = new Set<string>();

  for (const item of res?.items ?? []) {
    if (item.type === 'agent') {
      agentNames.add(item.name);
      agents.push({
        type: 'agent', name: item.name, relPath: item.relPath,
        description: item.description,
        _nameLower: item.name.toLowerCase(),
        _relPathLower: item.relPath.toLowerCase(),
      });
    }
  }
  for (const item of res?.items ?? []) {
    if (item.type === 'file') {
      const bare = item.name.replace(/\.md$/, '');
      if (agentNames.has(bare)) {
        log.warn(
          `File "${item.relPath}" conflicts with agent "${bare}"; agent wins.`,
        );
        continue;
      }
      files.push({
        type: 'file', name: item.name, relPath: item.relPath,
        _nameLower: item.name.toLowerCase(),
        _relPathLower: item.relPath.toLowerCase(),
      });
    } else if (item.type === 'dir') {
      dirs.push({
        type: 'dir', name: item.name, relPath: item.relPath,
        _nameLower: item.name.toLowerCase(),
        _relPathLower: item.relPath.toLowerCase(),
      });
    }
  }

  const contextual: AtResourceItem[] = [];
  for (const tab of contextResult?.browserTabs ?? []) {
    const relPath = browserTabReference(tab.tabId, tab.url);
    contextual.push({
      type: 'browser-tab',
      name: tab.title,
      relPath,
      description: tab.url,
      _nameLower: tab.title.toLowerCase(),
      _relPathLower: `${tab.url} ${tab.tabId}`.toLowerCase(),
    });
  }
  for (const appWindow of contextResult?.desktopWindows ?? []) {
    const relPath = desktopWindowReference(
      appWindow.pid,
      appWindow.windowId,
      appWindow.appName,
    );
    contextual.push({
      type: 'desktop-window',
      name: appWindow.title,
      relPath,
      description: appWindow.appName,
      _nameLower: appWindow.title.toLowerCase(),
      _relPathLower: `${appWindow.appName} ${appWindow.pid} ${appWindow.windowId}`.toLowerCase(),
    });
  }
  const historicalTasks: AtResourceItem[] = [];
  const taskRows = taskHistorySettled.status === 'fulfilled'
    && Array.isArray(taskHistorySettled.value)
    ? taskHistorySettled.value
    : [];
  for (const session of taskRows) {
    const taskId = oneLineText(session.id, 256);
    if (
      !taskId
      || taskId === context?.sessionId
      || session.status === 'deleted'
      || (!session.userSendAt && (session._count?.messages ?? 0) === 0)
    ) continue;
    const title = oneLineText(session.title, 240);
    if (!title) continue;
    const description = oneLineText(session.summary || session.preview, 300);
    const relPath = buildSessionDeepLink(taskId, { deviceId });
    historicalTasks.push({
      type: 'session',
      name: title,
      relPath,
      ...(description ? { description } : {}),
      _nameLower: title.toLowerCase(),
      _relPathLower: `${title} ${description} ${oneLineText(session.workingDir, 2_000)}`
        .toLowerCase(),
    });
  }

  const pluginProviders: AtResourceItem[] = [];
  const providerRows = pluginProvidersSettled.status === 'fulfilled'
    ? pluginProvidersSettled.value?.items ?? []
    : [];
  for (const provider of providerRows) {
    const ghostId = oneLineText(provider.ghostId, 32);
    const name = oneLineText(provider.name, 128);
    if (!ghostId || !name) continue;
    const description = oneLineText(provider.description, 256);
    pluginProviders.push({
      type: 'plugin-provider',
      name,
      relPath: ghostId,
      pluginId: ghostId,
      sourceLabel: name,
      ...(description ? { description } : {}),
      _nameLower: name.toLowerCase(),
      _relPathLower: `${ghostId} ${name} ${description}`.toLowerCase(),
    });
  }

  return {
    success: true,
    items: [...contextual, ...historicalTasks, ...pluginProviders, ...agents, ...dirs, ...files],
    truncated: !!res?.truncated,
  };
}

/** Search exactly one provider after the user explicitly selected it. */
export async function scanPluginAtResources(
  provider: AtResourceItem,
  query: string,
  workingDir?: string,
  sessionId?: string,
): Promise<ScanResult> {
  if (provider.type !== 'plugin-provider' || !provider.pluginId) {
    return { success: false, error: 'Plugin resource provider unavailable', items: [], truncated: false };
  }
  const result = await window.electronAPI.ghosts.queryAtResources({
    ghostId: provider.pluginId,
    ...(sessionId ? { sessionId } : {}),
    ...(workingDir ? { workingDir } : {}),
    query: query.trim(),
    limit: 20,
  });
  if (!result.success) {
    return {
      success: false,
      error: result.error ?? 'Plugin resource search failed',
      items: [],
      truncated: false,
    };
  }
  const sourceLabel = oneLineText(result.pluginName || provider.sourceLabel || provider.name, 128);
  const items: AtResourceItem[] = [];
  for (const row of result.items) {
    const name = oneLineText(row.label, 128);
    const relPath = typeof row.href === 'string' && row.href.length <= 1_500
      ? oneLineText(row.href, 1_500)
      : '';
    if (!name || !relPath) continue;
    const description = oneLineText(row.description, 256);
    items.push({
      type: 'plugin-resource',
      name,
      relPath,
      pluginId: provider.pluginId,
      sourceLabel,
      ...(description ? { description } : {}),
      _nameLower: name.toLowerCase(),
      _relPathLower: `${name} ${description}`.toLowerCase(),
    });
  }
  return { success: true, items, truncated: result.truncated };
}

/**
 * Lightweight fuzzy scorer. Returns a positive number (higher = better) if
 * the query characters appear in order inside `name` or `relPath`. Returns
 * -1 for no match.
 *
 * Scoring priorities (per F2 spec "filename优先于路径"):
 *   +1000 — name starts with query (exact prefix)
 *   +500  — name contains query as a contiguous substring
 *   +100  — name matches fuzzy in-order
 *   +50   — path (not name) matches fuzzy in-order
 *
 * Length tiebreak: shorter names score slightly higher (closer to prefix).
 */
function scoreItem(item: AtResourceItem, q: string): number {
  if (!q) return 1; // empty query = everything matches with baseline score
  const name = item._nameLower ?? item.name.toLowerCase();
  const rel = item._relPathLower ?? item.relPath.toLowerCase();

  if (name.startsWith(q)) return 1000 - name.length;
  if (name.includes(q)) return 500 - name.length;

  // Fuzzy: all chars of q appear in order in name?
  if (fuzzyInOrder(name, q)) return 100 - name.length;
  if (fuzzyInOrder(rel, q)) return 50 - rel.length / 10;
  return -1;
}

function fuzzyInOrder(hay: string, needle: string): boolean {
  let i = 0;
  for (const ch of hay) {
    if (ch === needle[i]) i++;
    if (i === needle.length) return true;
  }
  return i === needle.length;
}

/**
 * Filter + rank against a query. Agents and files are ranked together in
 * the same pool (F5: "agent 项与文件项完全平铺"), no artificial boost for
 * one type over the other — the raw scorer already privileges name matches
 * and agents tend to have short memorable names so they naturally rise.
 */
export function filterAtResources(
  items: AtResourceItem[],
  query: string,
  limit = 25,
): AtResourceItem[] {
  const q = query.trim().toLowerCase();
  const scored: Array<{ item: AtResourceItem; score: number }> = [];
  for (const item of items) {
    const s = scoreItem(item, q);
    if (s >= 0) scored.push({ item, score: s });
  }
  scored.sort((a, b) => b.score - a.score);
  // Cap rendered items — the panel is max ~9 visible rows; rendering
  // beyond `limit` wastes DOM nodes and causes jank on large projects.
  if (scored.length > limit) scored.length = limit;
  return scored.map((s) => s.item);
}
