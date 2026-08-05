import { createLogger } from '@/lib/logger';
import type { Session } from '@/lib/ccAgent.types';
import { buildSessionDeepLink, strictEncodeURIComponent } from '@/lib/deepLink';
import {
  conversationSearchTitle,
  type ConversationSearchResponse,
} from '../../shared/conversationSearch';

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
  | 'file-picker'
  | 'file'
  | 'dir'
  | 'agent'
  | 'browser-tab'
  | 'desktop-window'
  | 'session'
  | 'plugin-command'
  | 'plugin-resource';

export interface AtResourceItem {
  type: AtResourceType;
  /** Display name:
   *  - file → basename with extension
   *  - dir  → basename (no trailing slash; UI adds it for visual hint)
   *  - agent → filename without `.md`
   */
  name: string;
  /** Workspace-relative path, an explicitly picked absolute path, or a stable Cindy context deep link. Used for:
   *  - display "apps/server/src/routes" (minus basename) in right column
   *  - serialization on submit: `@relPath` / `@relPath/` / `@.claude/agents/<name>.md`
   */
  relPath: string;
  /** Agent description from YAML frontmatter (agents only). */
  description?: string;
  /** Plugin display name for plugin rows and Agent projection. */
  sourceLabel?: string;
  /** Stable Plugin id. Present on plugin rows only. */
  pluginId?: string;
  /** Installed plugin icon as a validated data URL. Present on plugin rows when declared. */
  iconDataUrl?: string;
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

export const AT_MENTION_SEARCH_RESULT_LIMIT = 8;
export const AT_MENTION_EMPTY_WORKSPACE_SCAN_CAP = 2000;
export const AT_FILE_PICKER_RESOURCE: AtResourceItem = {
  type: 'file-picker',
  name: '',
  relPath: 'cindy://file-picker',
};

const EMPTY_QUERY_SECTION_LIMIT = 3;
const EMPTY_QUERY_RESULT_LIMIT = 12;
const TASK_SEARCH_CANDIDATE_LIMIT = 20;
const EMPTY_QUERY_SECTIONS: ReadonlyArray<ReadonlySet<AtResourceType>> = [
  new Set(['file-picker']),
  new Set(['browser-tab']),
  new Set(['agent']),
  new Set(['plugin-command']),
];

export type PaletteAgentKind = 'claude-code' | 'codex' | 'pi';

export interface AtResourceScanContext {
  /** Current local task. Its built-in browser tabs are the only tabs exposed. */
  sessionId?: string;
  /** False for SSH/device-link so candidates never leak from the controller machine. */
  includeLocalContext?: boolean;
  /** Historical tasks are read from the execution device's local database. */
  includeTaskHistory?: boolean;
  /** Resolved i18n label used to match and display untitled tasks. */
  unnamedLabel?: string;
  /** Emit usable sources immediately while slower providers are still loading. */
  onPartial?: (result: ScanResult) => void;
}

function browserTabReference(tabId: string, url: string): string {
  return `cindy://browser-tab/${strictEncodeURIComponent(tabId)}?url=${strictEncodeURIComponent(url)}`;
}

function desktopWindowReference(
  pid: number,
  windowId: number,
  appName: string,
): string {
  return `cindy://desktop-window/${pid}/${windowId}?app=${strictEncodeURIComponent(appName)}`;
}

function oneLineText(value: unknown, maxLength: number): string {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim().slice(0, maxLength)
    : '';
}

const BROWSER_APP_STEMS = new Set([
  'arc',
  'brave',
  'chrome',
  'firefox',
  'msedge',
  'opera',
]);

function applicationStem(value: string): string {
  const basename = value.replace(/\\/g, '/').split('/').pop() ?? value;
  return basename.replace(/\.(?:exe|app)$/i, '').trim().toLowerCase();
}

function isBrowserApplication(value: string): boolean {
  return BROWSER_APP_STEMS.has(applicationStem(value));
}

function normalizedBrowserPageTitle(value: string): string {
  return oneLineText(value, 240)
    .replace(
      /\s+[-–—]\s+(?:google chrome|chrome|microsoft edge|mozilla firefox|firefox|brave|opera|arc)$/i,
      '',
    )
    .toLowerCase();
}

type RawWorkspaceScan = Awaited<ReturnType<typeof window.electronAPI.maker.scanAtResources>>;
type RawContextScan = Awaited<ReturnType<typeof window.electronAPI.maker.listAtContext>>;

function normalizeWorkspaceResources(res: RawWorkspaceScan | null): AtResourceItem[] {
  const agents: AtResourceItem[] = [];
  const files: AtResourceItem[] = [];
  const dirs: AtResourceItem[] = [];
  const agentNames = new Set<string>();

  for (const item of res?.items ?? []) {
    if (item.type !== 'agent') continue;
    agentNames.add(item.name);
    agents.push({
      type: 'agent', name: item.name, relPath: item.relPath,
      description: item.description,
      _nameLower: item.name.toLowerCase(),
      _relPathLower: item.relPath.toLowerCase(),
    });
  }
  for (const item of res?.items ?? []) {
    if (item.type === 'file') {
      const bare = item.name.replace(/\.md$/, '');
      if (agentNames.has(bare)) {
        log.warn(`File "${item.relPath}" conflicts with agent "${bare}"; agent wins.`);
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
  return [...agents, ...dirs, ...files];
}

function normalizeContextResources(contextResult: RawContextScan | null): AtResourceItem[] {
  const contextual: AtResourceItem[] = [];
  const browserTabTitleKeys = new Set<string>();
  for (const tab of contextResult?.browserTabs ?? []) {
    const relPath = browserTabReference(tab.tabId, tab.url);
    const titleKey = normalizedBrowserPageTitle(tab.title);
    if (titleKey) browserTabTitleKeys.add(titleKey);
    contextual.push({
      type: 'browser-tab',
      name: tab.title,
      relPath,
      description: tab.url,
      _nameLower: tab.title.toLowerCase(),
      _relPathLower: `${tab.url} ${tab.tabId}`.toLowerCase(),
    });
  }
  const seenDesktopWindows = new Set<string>();
  for (const appWindow of contextResult?.desktopWindows ?? []) {
    const windowKey = `${appWindow.pid}:${appWindow.windowId}`;
    if (seenDesktopWindows.has(windowKey)) continue;
    seenDesktopWindows.add(windowKey);
    if (
      isBrowserApplication(appWindow.appName)
      && browserTabTitleKeys.has(normalizedBrowserPageTitle(appWindow.title))
    ) continue;
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
  return contextual;
}

function normalizeHistoricalTaskResources(
  sessions: Session[] | null,
  currentSessionId: string | undefined,
  deviceId: string | undefined,
  unnamedLabel: string | undefined,
): AtResourceItem[] {
  const historicalTasks: AtResourceItem[] = [];
  for (const session of sessions ?? []) {
    const taskId = oneLineText(session.id, 256);
    if (
      !taskId
      || taskId === currentSessionId
      || session.status !== 'active'
      || (!session.userSendAt && (session._count?.messages ?? 0) === 0)
    ) continue;
    const title = oneLineText(conversationSearchTitle(session.title, unnamedLabel), 240);
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
  return historicalTasks;
}

function normalizeHistoricalTaskSearchResources(
  response: ConversationSearchResponse | null,
  currentSessionId: string | undefined,
  deviceId: string | undefined,
  unnamedLabel: string | undefined,
): AtResourceItem[] {
  const historicalTasks: AtResourceItem[] = [];
  for (const result of response?.results ?? []) {
    const session = result.session;
    const taskId = oneLineText(session.id, 256);
    if (!taskId || taskId === currentSessionId || session.status !== 'active') continue;
    const title = oneLineText(conversationSearchTitle(session.title, unnamedLabel), 240);
    if (!title) continue;
    const description = oneLineText(result.contentHit?.preview, 300);
    historicalTasks.push({
      type: 'session',
      name: title,
      relPath: buildSessionDeepLink(taskId, { deviceId }),
      ...(description ? { description } : {}),
      _nameLower: title.toLowerCase(),
      _relPathLower: `${title} ${description} ${oneLineText(session.workingDir, 2_000)}`
        .toLowerCase(),
    });
  }
  return historicalTasks;
}

async function searchRemoteHistoricalTasks(
  deviceId: string,
  query: string,
  currentSessionId: string | undefined,
  unnamedLabel: string | undefined,
): Promise<AtResourceItem[]> {
  try {
    const response = await window.electronAPI.deviceLink.invoke(
      deviceId,
      'local-db:conversations:search',
      [{
        query,
        limit: TASK_SEARCH_CANDIDATE_LIMIT,
        sortBy: 'relevance',
        semanticMode: 'keyword',
        filters: { status: 'active' },
        ...(unnamedLabel ? { unnamedLabel } : {}),
      }],
    ) as ConversationSearchResponse;
    return normalizeHistoricalTaskSearchResources(
      response,
      currentSessionId,
      deviceId,
      unnamedLabel,
    );
  } catch {
    // Older controlled clients do not allow the conversation-search channel.
    const sessions = await window.electronAPI.deviceLink.invoke(
      deviceId,
      'local-db:sessions:list',
      [100, 'active'],
    ) as Session[];
    return normalizeHistoricalTaskResources(sessions, currentSessionId, deviceId, unnamedLabel);
  }
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
  const workspacePromise: Promise<RawWorkspaceScan | null> = workingDir
    ? deviceId
      ? (window.electronAPI.deviceLink.invoke(deviceId, 'maker:scan-at-resources', [
          agentKind,
          { workingDir, cap, query },
        ]) as Promise<RawWorkspaceScan>)
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
  const normalizedTaskQuery = query?.trim() ?? '';
  const taskHistoryPromise: Promise<AtResourceItem[] | null> = includeTaskHistory
    ? normalizedTaskQuery
      ? deviceId
        ? searchRemoteHistoricalTasks(
            deviceId,
            normalizedTaskQuery,
            context?.sessionId,
            context?.unnamedLabel,
          )
        : window.electronAPI.localDb.conversations.search({
            query: normalizedTaskQuery,
            limit: TASK_SEARCH_CANDIDATE_LIMIT,
            sortBy: 'relevance',
            semanticMode: 'keyword',
            filters: { status: 'active' },
            ...(context?.unnamedLabel ? { unnamedLabel: context.unnamedLabel } : {}),
          }).then((response) => normalizeHistoricalTaskSearchResources(
            response,
            context?.sessionId,
            undefined,
            context?.unnamedLabel,
          ))
      : deviceId
        ? (window.electronAPI.deviceLink.invoke(
            deviceId,
            'local-db:sessions:list',
            [100, 'active'],
          ) as Promise<Session[]>).then((sessions) => normalizeHistoricalTaskResources(
            sessions,
            context?.sessionId,
            deviceId,
            context?.unnamedLabel,
          ))
        : window.electronAPI.localDb.sessions.list(100, 'active').then(
            (sessions) => normalizeHistoricalTaskResources(
              sessions,
              context?.sessionId,
              undefined,
              context?.unnamedLabel,
            ),
          )
    : Promise.resolve(null);
  const partial = {
    contextual: [] as AtResourceItem[],
    historicalTasks: [] as AtResourceItem[],
    workspace: [] as AtResourceItem[],
    truncated: false,
  };
  const emitPartial = () => {
    if (!context?.onPartial) return;
    try {
      context.onPartial({
        success: true,
        items: [
          ...partial.contextual,
          ...partial.historicalTasks,
          ...partial.workspace,
        ],
        truncated: partial.truncated,
      });
    } catch (err) {
      log.warn('@ resource partial callback failed; continuing scan.', err);
    }
  };
  void workspacePromise.then((value) => {
    if (!value?.success || !value.items) return;
    partial.workspace = normalizeWorkspaceResources(value);
    partial.truncated = !!value.truncated;
    emitPartial();
  }, () => undefined);
  void contextPromise.then((value) => {
    if (!value) return;
    partial.contextual = normalizeContextResources(value);
    emitPartial();
  }, () => undefined);
  void taskHistoryPromise.then((value) => {
    if (!value) return;
    partial.historicalTasks = value;
    emitPartial();
  }, () => undefined);
  const [workspaceSettled, contextSettled, taskHistorySettled] = await Promise.allSettled([
    workspacePromise,
    contextPromise,
    taskHistoryPromise,
  ]);
  const res = workspaceSettled.status === 'fulfilled' ? workspaceSettled.value : null;
  const contextResult = contextSettled.status === 'fulfilled' ? contextSettled.value : null;
  const workspaceFailed = !!workingDir && (
    workspaceSettled.status === 'rejected' || !res?.success || !res.items
  );
  const contextFailed = includeLocalContext && contextSettled.status === 'rejected';
  const taskHistoryFailed = includeTaskHistory && taskHistorySettled.status === 'rejected';
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
  if (
    (!workingDir || workspaceFailed)
    && (!includeLocalContext || contextFailed)
    && (!includeTaskHistory || taskHistoryFailed)
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
  const workspace = normalizeWorkspaceResources(res);

  const contextual = normalizeContextResources(contextResult);
  const historicalTasks = taskHistorySettled.status === 'fulfilled'
    && Array.isArray(taskHistorySettled.value)
    ? taskHistorySettled.value
    : [];
  return {
    success: true,
    items: [...contextual, ...historicalTasks, ...workspace],
    truncated: !!res?.truncated,
  };
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

function emptyQueryResources(items: AtResourceItem[], limit: number): AtResourceItem[] {
  const selected: AtResourceItem[] = [];
  for (const types of EMPTY_QUERY_SECTIONS) {
    let sectionCount = 0;
    for (const item of items) {
      if (!types.has(item.type)) continue;
      selected.push(item);
      sectionCount += 1;
      if (selected.length >= limit) return selected;
      if (sectionCount >= EMPTY_QUERY_SECTION_LIMIT) break;
    }
  }
  return selected;
}

/** Return a path prefix when a directory can remain inside the active @ query. */
export function getAtDirectoryCompletionQuery(
  item: AtResourceItem,
  allowWhitespace = false,
): string | null {
  if (item.type !== 'dir') return null;
  const relPath = item.relPath.replace(/\\/g, '/').replace(/\/+$/, '');
  if (!relPath || relPath.includes('@') || (!allowWhitespace && /\s/.test(relPath))) return null;
  return `${relPath}/`;
}

/** Build an item returned by the native picker without importing Node path APIs. */
export function createAtResourceFromNativePath(
  selectedPath: string,
  kind: 'file' | 'directory',
  workingDir?: string | null,
): AtResourceItem | null {
  const trimmedPath = selectedPath.trim();
  if (!trimmedPath) return null;

  const normalizedPath = trimmedPath.replace(/\\/g, '/');
  const normalizedWorkingDir = workingDir?.trim().replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
  const windowsPath = /^[A-Za-z]:\//.test(normalizedWorkingDir);
  const comparablePath = windowsPath ? normalizedPath.toLowerCase() : normalizedPath;
  const comparableWorkingDir = windowsPath
    ? normalizedWorkingDir.toLowerCase()
    : normalizedWorkingDir;
  const isInsideWorkingDir = !!comparableWorkingDir
    && comparablePath.startsWith(`${comparableWorkingDir}/`);
  const relPath = isInsideWorkingDir
    ? normalizedPath.slice(normalizedWorkingDir.length + 1)
    : trimmedPath;
  const name = normalizedPath.split('/').filter(Boolean).pop() ?? trimmedPath;

  return { type: kind === 'directory' ? 'dir' : 'file', name, relPath };
}

/** Keep usable candidates visible while a narrower async query is still loading. */
export function mergeAtResourceItems(
  previous: readonly AtResourceItem[],
  incoming: readonly AtResourceItem[],
): AtResourceItem[] {
  const merged: AtResourceItem[] = [];
  const seen = new Set<string>();
  for (const item of [...incoming, ...previous]) {
    const key = `${item.type}:${item.pluginId ?? ''}:${item.relPath}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(item);
  }
  return merged;
}

/**
 * Empty queries expose only a small curated set of contextual resources.
 * Once the user types, every source — including files and directories — is
 * ranked in the same pool and capped to a compact global result list.
 */
export function filterAtResources(
  items: AtResourceItem[],
  query: string,
  limit?: number,
): AtResourceItem[] {
  const q = query.trim().toLowerCase();
  const resultLimit = limit ?? (
    q ? AT_MENTION_SEARCH_RESULT_LIMIT : EMPTY_QUERY_RESULT_LIMIT
  );
  if (!q) return emptyQueryResources(items, resultLimit);
  const scored: Array<{ item: AtResourceItem; score: number }> = [];
  for (const item of items) {
    if (item.type === 'file-picker') continue;
    const s = scoreItem(item, q);
    if (s >= 0) scored.push({ item, score: s });
  }
  scored.sort((a, b) => (
    b.score - a.score
    || a.item.name.localeCompare(b.item.name)
    || a.item.relPath.localeCompare(b.item.relPath)
  ));
  // Cap rendered items — the panel is max ~9 visible rows; rendering
  // beyond `resultLimit` wastes DOM nodes and causes jank on large projects.
  if (scored.length > resultLimit) scored.length = resultLimit;
  return scored.map((s) => s.item);
}
