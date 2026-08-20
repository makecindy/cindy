import { collapseWorktreeDirForGrouping } from './worktreePaths.js';

export type SyncedProjectOrderMode = 'activity' | 'custom';

export interface SyncedProjectOrderOwnerStamp {
  dataOwnerId: string | null;
  ownerGeneration: number;
}

export interface SyncedProjectOrderSnapshot {
  authoritative: boolean;
  /** false = 被控端没有这个接口,控制端应回退到自己的混排。缺省视为 true。 */
  available: boolean;
  manualProjectOrder: string[];
  projectOrder: SyncedProjectOrderMode;
  /** 被控端当前 data owner。APPLY 必须原样带回;缺省表示旧主机/不可用快照。 */
  ownerStamp?: SyncedProjectOrderOwnerStamp;
}

export const UNAVAILABLE_PROJECT_ORDER_SNAPSHOT: SyncedProjectOrderSnapshot = {
  authoritative: false,
  available: false,
  manualProjectOrder: [],
  projectOrder: 'activity',
};

export const SIDEBAR_GET_PROJECT_ORDER_CHANNEL = 'sidebar-settings:get-project-order';
export const SIDEBAR_APPLY_PROJECT_ORDER_CHANNEL = 'sidebar-settings:apply-project-order';
export const SIDEBAR_PROJECT_ORDER_CHANGED_CHANNEL = 'sidebar-settings:project-order-changed';

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

export function parseSyncedProjectOrderOwnerStamp(
  value: unknown,
): SyncedProjectOrderOwnerStamp | undefined {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
  if (!record) return undefined;
  const dataOwnerId = record.dataOwnerId;
  const ownerGeneration = record.ownerGeneration;
  if (!(dataOwnerId === null || typeof dataOwnerId === 'string')) return undefined;
  if (
    typeof ownerGeneration !== 'number'
    || !Number.isInteger(ownerGeneration)
    || ownerGeneration < 0
  ) {
    return undefined;
  }
  return { dataOwnerId, ownerGeneration };
}

export function parseSyncedProjectOrderSnapshot(value: unknown): SyncedProjectOrderSnapshot {
  const record = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const ownerStamp = parseSyncedProjectOrderOwnerStamp(record.ownerStamp)
    ?? parseSyncedProjectOrderOwnerStamp(record);
  return {
    authoritative: record.authoritative === true,
    available: record.available !== false,
    manualProjectOrder: hostLocalProjectKeysOnly(record.manualProjectOrder),
    projectOrder: parseSyncedProjectOrderMode(record.projectOrder),
    ...(ownerStamp ? { ownerStamp } : {}),
  };
}

/**
 * 列表、拖拽、菜单勾选共用这一份结果。
 * 不要再用 hostCustom ? custom : viewer.projectOrder 这类捷径——
 * 查看端 custom + 单机 host activity 会把菜单勾成自定义、列表却按活动排。
 */
export function resolveDisplayedProjectOrder(
  scope: ProjectOrderWriteScope,
  hostSnapshot: SyncedProjectOrderSnapshot | undefined,
  viewer: { projectOrder: SyncedProjectOrderMode; manualProjectOrder: readonly string[] },
  hostManualProjectOrder: readonly string[],
): { projectOrder: SyncedProjectOrderMode; manualProjectOrder: readonly string[] } {
  if (projectOrderWriteLedger(scope, hostSnapshot) === 'viewer') {
    return {
      projectOrder: viewer.projectOrder,
      manualProjectOrder: [...viewer.manualProjectOrder],
    };
  }
  if (hostSnapshot?.authoritative && hostSnapshot.projectOrder === 'custom') {
    return {
      projectOrder: 'custom',
      manualProjectOrder: [...hostManualProjectOrder],
    };
  }
  return { projectOrder: 'activity', manualProjectOrder: [] };
}

/** GET 在途时若已收到更新推送 / APPLY 结果,丢弃过期 GET,避免旧快照盖住新顺序。 */
export function createProjectOrderFetchFence() {
  let seq = 0;
  const invalidatedAt = new Map<string, number>();
  return {
    begin(_key: string): number {
      seq += 1;
      return seq;
    },
    noteLiveUpdate(key: string): void {
      invalidatedAt.set(key, seq);
    },
    shouldApplyFetch(key: string, token: number): boolean {
      return (invalidatedAt.get(key) ?? 0) < token;
    },
  };
}

export function localHostSeedOwnerKey(stamp: SyncedProjectOrderOwnerStamp): string {
  return `${stamp.dataOwnerId ?? ''}:${stamp.ownerGeneration}`;
}

/** 只在该 owner 还没成功写入过、且查看端确实有本机自定义序时播种。失败不得记成功。 */
export function shouldSeedLocalHostProjectOrder(
  snapshot: SyncedProjectOrderSnapshot,
  seed: { custom: boolean; keys: readonly string[] } | undefined,
  seededOwners: ReadonlySet<string>,
): boolean {
  if (!snapshot.ownerStamp || snapshot.authoritative || !seed?.custom) return false;
  if (hostLocalProjectKeysOnly(seed.keys).length === 0) return false;
  return !seededOwners.has(localHostSeedOwnerKey(snapshot.ownerStamp));
}

/**
 * 按折叠键对齐手动序:prev 里对得上的项保留相对顺序,拼写改用 active 侧原样。
 * Windows 首次写入的小写键因此能对上主机 `C:/Work/App`。
 */
export function reconcileManualProjectOrder(
  prev: readonly string[],
  activeKeys: readonly string[],
): string[] {
  const active: string[] = [];
  const activeByFold = new Map<string, string>();
  for (const value of activeKeys) {
    const key = value.trim();
    if (!key) continue;
    const folded = foldProjectOrderKey(key);
    if (activeByFold.has(folded)) continue;
    activeByFold.set(folded, key);
    active.push(key);
  }
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of prev) {
    const key = value.trim();
    if (!key) continue;
    const match = activeByFold.get(foldProjectOrderKey(key));
    if (!match || seen.has(match)) continue;
    seen.add(match);
    next.push(match);
  }
  for (const key of active) {
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(key);
  }
  return next;
}

export function isHostProjectOrderReachable(
  snapshot: SyncedProjectOrderSnapshot | undefined,
): boolean {
  return snapshot?.available !== false;
}

/**
 * 项目顺序推送的代际门禁。控制端只收当前账号、且不比该设备已见过的更新更旧的帧。
 * 旧主机没带 stamp 时,在该设备证明自己会打 stamp 之前仍放行。
 */
export function shouldAcceptHostProjectOrderPush(input: {
  controllerDataOwnerId: string | null;
  incoming: SyncedProjectOrderOwnerStamp | undefined;
  incomingPresent: boolean;
  previous: SyncedProjectOrderOwnerStamp | undefined;
  seenStampFromDevice: boolean;
}): boolean {
  if (input.controllerDataOwnerId === null) return false;
  if (!input.incomingPresent) return !input.seenStampFromDevice;
  if (!input.incoming) return false;
  if (input.incoming.dataOwnerId !== input.controllerDataOwnerId) return false;
  if (
    input.previous
    && input.previous.dataOwnerId === input.incoming.dataOwnerId
    && input.incoming.ownerGeneration < input.previous.ownerGeneration
  ) {
    return false;
  }
  return true;
}

const HOST_PROJECT_ORDER_MISSING_CHANNEL_CODES = new Set([
  'CHANNEL_NOT_ALLOWED',
  'REMOTE_DISABLED',
  'DEVICE_LINK_CHANNEL_NOT_ALLOWED',
  'DEVICE_LINK_REMOTE_DISABLED',
]);

function ipcCodeFromUnknown(error: unknown): string | undefined {
  if (typeof error === 'string') {
    return error.match(/\[([A-Z0-9_]+)\]/)?.[1];
  }
  if (!error || typeof error !== 'object') return undefined;
  const code = 'code' in error ? (error as { code?: unknown }).code : undefined;
  if (typeof code === 'string') return code;
  const message = 'message' in error ? (error as { message?: unknown }).message : undefined;
  if (typeof message === 'string') return message.match(/\[([A-Z0-9_]+)\]/)?.[1];
  return undefined;
}

/** 只有被控端明确没有这个通道才降级到查看端账本。超时 / 掉线要重试。 */
export function isHostProjectOrderChannelMissing(error: unknown): boolean {
  const code = ipcCodeFromUnknown(error);
  return code !== undefined && HOST_PROJECT_ORDER_MISSING_CHANNEL_CODES.has(code);
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

function isWindowsStyleProjectPath(value: string): boolean {
  // 只按明确形态识别 Windows:盘符(`C:/` 或 `C:\`)或 UNC 前缀(`\\` / `//`)。
  // 不能用 `includes('\\')`——POSIX 路径里的反斜杠是合法文件名,会被误判成分隔符而错误合并项目键。
  return /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\') || value.startsWith('//');
}

function stripTrailingProjectSlashes(path: string): string {
  let end = path.length;
  while (end > 1 && path[end - 1] === '/') {
    if (/^[A-Za-z]:\/$/.test(path.slice(0, end))) break;
    end -= 1;
  }
  return path.slice(0, end);
}

/**
 * 与两端项目分组同一套折径:Windows 正斜杠+小写,worktree 折到 base repo。
 * POSIX 路径里的反斜杠是文件名,不得先改写成分隔符。
 */
export function normalizeProjectOrderPath(path: string): string {
  const trimmed = path.trim();
  const windows = isWindowsStyleProjectPath(trimmed);
  const slashNormalized = windows ? trimmed.replaceAll('\\', '/') : trimmed;
  const collapsed = collapseWorktreeDirForGrouping(stripTrailingProjectSlashes(slashNormalized));
  return windows || isWindowsStyleProjectPath(collapsed) ? collapsed.toLowerCase() : collapsed;
}

export function foldProjectOrderKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.startsWith(LOCAL_PREFIX)) {
    return `${LOCAL_PREFIX}${normalizeProjectOrderPath(trimmed.slice(LOCAL_PREFIX.length))}`;
  }
  if (trimmed.startsWith(DEVICE_PREFIX)) {
    const rest = trimmed.slice(DEVICE_PREFIX.length);
    const sep = rest.indexOf(':');
    if (sep < 0) return trimmed;
    return `${DEVICE_PREFIX}${rest.slice(0, sep + 1)}${normalizeProjectOrderPath(rest.slice(sep + 1))}`;
  }
  return trimmed;
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

/** 被控端 `local:/path` → 控制端 `device:<id>:/path`。Windows 路径按首页同一规则折叠。 */
export function remapHostProjectKeyToController(deviceId: string, hostKey: string): string | null {
  const trimmed = hostKey.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith(LOCAL_PREFIX)) {
    return `${deviceProjectKeyPrefix(deviceId)}${normalizeProjectOrderPath(trimmed.slice(LOCAL_PREFIX.length))}`;
  }
  const prefix = deviceProjectKeyPrefix(deviceId);
  if (trimmed.startsWith(prefix)) {
    return `${prefix}${normalizeProjectOrderPath(trimmed.slice(prefix.length))}`;
  }
  return null;
}

/** 控制端 `device:<id>:/path` → 被控端 `local:/path`。已知主机键按折叠值还原大小写。 */
export function remapControllerProjectKeyToHost(
  deviceId: string,
  controllerKey: string,
  knownHostKeys: readonly string[] = [],
): string | null {
  const trimmed = controllerKey.trim();
  if (!trimmed) return null;
  const prefix = deviceProjectKeyPrefix(deviceId);
  let hostKey: string | null = null;
  if (trimmed.startsWith(prefix)) hostKey = `${LOCAL_PREFIX}${trimmed.slice(prefix.length)}`;
  else if (trimmed.startsWith(LOCAL_PREFIX)) hostKey = trimmed;
  if (!hostKey) return null;
  const folded = foldProjectOrderKey(hostKey);
  const restored = knownHostKeys.find((key) => foldProjectOrderKey(key) === folded);
  return restored ?? folded;
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

export function remapControllerOrderToHost(
  deviceId: string,
  keys: readonly string[],
  knownHostKeys: readonly string[] = [],
): string[] {
  const next: string[] = [];
  const seen = new Set<string>();
  for (const key of keys) {
    const mapped = remapControllerProjectKeyToHost(deviceId, key, knownHostKeys);
    if (!mapped || seen.has(mapped)) continue;
    seen.add(mapped);
    next.push(mapped);
  }
  return next;
}
