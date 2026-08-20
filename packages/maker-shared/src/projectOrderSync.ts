export type SyncedProjectOrderMode = 'activity' | 'custom';

export interface SyncedProjectOrderSnapshot {
  authoritative: boolean;
  /** false = 被控端没有这个接口,控制端应回退到自己的混排。缺省视为 true。 */
  available: boolean;
  manualProjectOrder: string[];
  projectOrder: SyncedProjectOrderMode;
}

export const UNAVAILABLE_PROJECT_ORDER_SNAPSHOT: SyncedProjectOrderSnapshot = {
  authoritative: false,
  available: false,
  manualProjectOrder: [],
  projectOrder: 'activity',
};

export const SIDEBAR_GET_PROJECT_ORDER_CHANNEL = 'sidebar-settings:get-project-order';
export const SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL = 'sidebar-settings:apply-project-order';

const LOCAL_PREFIX = 'local:';
const DEVICE_PREFIX = 'device:';

export function parseSyncedProjectOrderMode(value: unknown): SyncedProjectOrderMode {
  return value === 'custom' ? 'custom' : 'activity';
}

export function normalizeSyncedProjectOrderList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const next: string[] = [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const key = entry.trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    next.push(key);
    if (next.length >= 10_000) break;
  }
  return next;
}

export function parseSyncedProjectOrderSnapshot(value: unknown): SyncedProjectOrderSnapshot {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  return {
    authoritative: record.authoritative === true,
    available: record.available !== false,
    manualProjectOrder: hostLocalProjectKeysOnly(record.manualProjectOrder),
    projectOrder: parseSyncedProjectOrderMode(record.projectOrder),
  };
}

export function isHostProjectOrderReachable(
  snapshot: SyncedProjectOrderSnapshot | undefined,
): boolean {
  return snapshot?.available !== false;
}

/** 被控端够不到时,读写都走控制端自己的混排。 */
export function projectOrderWriteLedger(
  scope: ProjectOrderWriteScope,
  snapshot: SyncedProjectOrderSnapshot | undefined,
): ProjectOrderLedger {
  if (scope.kind === 'viewer' || !isHostProjectOrderReachable(snapshot)) return 'viewer';
  return 'host';
}

export function isHostLocalProjectKey(key: string): boolean {
  return key.startsWith(LOCAL_PREFIX);
}

/** 被控端正本只收本机项目。混排里的 `device:` 键不得写进这份列表。 */
export function hostLocalProjectKeysOnly(keys: unknown): string[] {
  return normalizeSyncedProjectOrderList(keys).filter(isHostLocalProjectKey);
}

export type ProjectOrderWriteScope =
  | { kind: 'viewer' }
  | { kind: 'host'; deviceId: string | null };

/** `selection === 'all'` 或勾了多台 → 当前客户端自己的混排；只勾一台 → 那台被控端正本。 */
export function resolveProjectOrderWriteScope(
  selection: 'all' | readonly string[] | null | undefined,
  localSentinel: string,
): ProjectOrderWriteScope {
  if (selection == null || selection === 'all' || selection.length !== 1) {
    return { kind: 'viewer' };
  }
  const only = selection[0];
  return { kind: 'host', deviceId: only === localSentinel ? null : only };
}

export type ProjectOrderLedger = 'viewer' | 'host';

export function projectOrderLedgerForScope(scope: ProjectOrderWriteScope): ProjectOrderLedger {
  return scope.kind === 'viewer' ? 'viewer' : 'host';
}

/** 单机切回按时间/优先级时,不得把混排的手动模式一起关掉。 */
export function shouldPersistViewerSortAfterHostActivity(viewerIsManual: boolean): boolean {
  return !viewerIsManual;
}

export function deviceProjectKeyPrefix(deviceId: string): string {
  return `${DEVICE_PREFIX}${encodeURIComponent(deviceId)}:`;
}

/** 被控端 `local:/path` → 控制端 `device:<id>:/path`。 */
export function remapHostProjectKeyToController(deviceId: string, hostKey: string): string | null {
  const trimmed = hostKey.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(LOCAL_PREFIX)) {
    return `${deviceProjectKeyPrefix(deviceId)}${trimmed.slice(LOCAL_PREFIX.length)}`;
  }
  if (trimmed.startsWith(deviceProjectKeyPrefix(deviceId))) return trimmed;
  return null;
}

/** 控制端 `device:<id>:/path` → 被控端 `local:/path`。 */
export function remapControllerProjectKeyToHost(deviceId: string, controllerKey: string): string | null {
  const trimmed = controllerKey.trim();
  if (!trimmed) return null;
  const prefix = deviceProjectKeyPrefix(deviceId);
  if (trimmed.startsWith(prefix)) return `${LOCAL_PREFIX}${trimmed.slice(prefix.length)}`;
  if (trimmed.startsWith(LOCAL_PREFIX)) return trimmed;
  return null;
}

export function remapHostOrderToController(deviceId: string, keys: readonly string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const mapped = remapHostProjectKeyToController(deviceId, key);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}

export function remapControllerOrderToHost(deviceId: string, keys: readonly string[]): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const mapped = remapControllerProjectKeyToHost(deviceId, key);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}
