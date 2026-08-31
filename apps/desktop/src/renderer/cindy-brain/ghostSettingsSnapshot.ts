/**
 * 意识「自定义设置区」的快照缓存(视觉连续性,设计规范规则 7):
 * webview 是独立渲染进程,从创建到画出首帧天然要几百毫秒,追不平宿主——
 * 于是在设置区渲染稳定后把 guest 的最终画面截成位图存下来(内存 + localStorage,
 * 跨 app 重启可用);下次进入详情页首帧直接贴这张图(像素与真内容一致),
 * webview 在图底下装载,就绪后无缝撤图换真身。用户看不到空白帧与高度跳变。
 *
 * 快照只是"上一次的画面",不承载任何真实状态:失配(插件版本 / 宿主布局版本 /
 * 主题 / 宽度 / DPR 任一变化)或过期(TTL)就整张作废走老的淡入路径。
 * 位图来自宿主对 guest 的 capturePage(嵌入方主动读,零桥模型不破),
 * 内容不受信也无所谓——它只被当成 <img> 的像素,不进任何执行上下文。
 *
 * 存储纪律:localStorage 是整个 renderer 30+ 个功能共享的 ~10MB 配额,
 * 本模块自设总预算(单条超限只留内存、总量超限按拍摄时间淘汰最旧),
 * 并提供按已装清单清孤儿的 prune(意识卸载后快照没有存在的理由)。
 */

/** 一张已存的设置区快照:位图 + 拍摄时的匹配上下文。 */
export interface GhostSettingsSnapshot {
  /** capturePage 产物的 data URL(image/png)。 */
  dataUrl: string;
  /** 拍摄时设置区容器的 CSS 宽度(px);宽度变了内容会重排,快照作废。 */
  width: number;
  /** 拍摄时设置区容器的 CSS 高度(px);兼作冷启动的高度留位初值。 */
  height: number;
  /** 拍摄时的 devicePixelRatio(跨屏拖动后位图清晰度对不上,作废重拍)。 */
  dpr: number;
  /** 拍摄时注入 guest 的主题 CSS 全文(主题换肤后旧配色快照作废)。 */
  themeCss: string;
  /** 拍摄时的意识版本(原位更新后界面可能全变,作废)。 */
  version: string;
  /** 拍摄时的宿主设置布局版本(注入规则变化后旧位图作废)。 */
  layoutRevision: number;
  /** 拍摄时刻(epoch ms):TTL 过期判定 + 总量超预算时的 LRU 淘汰序。 */
  capturedAt: number;
}

/** 快照匹配上下文(进入详情页时的现场值,与存量快照逐项比对)。 */
export interface GhostSettingsSnapshotContext {
  version: string;
  themeCss: string;
  dpr: number;
}

// v1 只有 ghostId，无法证明快照属于哪个 owner；保留但永不读取/迁移。
const STORAGE_PREFIX = 'ghostSettings.snapshot.v2.';

/** 宿主设置 guest 的布局契约版本;布局注入改变时递增以主动淘汰旧快照。 */
export const GHOST_SETTINGS_LAYOUT_REVISION = 3;

/**
 * 单条持久化体积上限(字符数,localStorage 按 UTF-16 计):设置区是纯色底 +
 * 文字控件,PNG data URL 正常远小于此;超限说明画面异常复杂,只留内存缓存。
 */
const MAX_PERSIST_CHARS = 400_000;

/** 全部快照的持久化总预算(字符数):写入前超预算就按 capturedAt 淘汰最旧。 */
const TOTAL_PERSIST_BUDGET_CHARS = 2_000_000;

/** 快照有效期:太久没进过的设置页,画面参考价值低,过期作废顺手清盘。 */
const SNAPSHOT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** 宽度容差(px):亚像素/滚动条级别的差异不重排内容,视同命中。 */
export const SNAPSHOT_WIDTH_TOLERANCE = 2;

/** 内存读写穿透缓存(null = 已确认 localStorage 里没有,避免反复 parse)。 */
const memoryCache = new Map<string, GhostSettingsSnapshot | null>();

/** 结构校验:localStorage 内容可能被外部改坏,逐字段验形,不合格当没有。 */
function isValidSnapshot(value: unknown): value is GhostSettingsSnapshot {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.dataUrl === 'string' &&
    v.dataUrl.startsWith('data:image/') &&
    typeof v.width === 'number' &&
    Number.isFinite(v.width) &&
    typeof v.height === 'number' &&
    Number.isFinite(v.height) &&
    typeof v.dpr === 'number' &&
    Number.isFinite(v.dpr) &&
    typeof v.themeCss === 'string' &&
    typeof v.version === 'string' &&
    v.layoutRevision === GHOST_SETTINGS_LAYOUT_REVISION &&
    typeof v.capturedAt === 'number' &&
    Number.isFinite(v.capturedAt)
  );
}

function snapshotKey(dataOwnerId: string, ghostId: string): string {
  return `${encodeURIComponent(dataOwnerId)}:${ghostId}`;
}

function parseSnapshotKey(key: string): { dataOwnerId: string; ghostId: string } | null {
  const separator = key.lastIndexOf(':');
  if (separator <= 0 || separator === key.length - 1) return null;
  try {
    const dataOwnerId = decodeURIComponent(key.slice(0, separator));
    const ghostId = key.slice(separator + 1);
    if (!dataOwnerId || !ghostId) return null;
    return { dataOwnerId, ghostId };
  } catch {
    return null;
  }
}

/** 静默删一条持久化快照(localStorage 不可用时忽略)。 */
function removePersisted(dataOwnerId: string, ghostId: string): void {
  const key = snapshotKey(dataOwnerId, ghostId);
  try {
    localStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    // ignore
  }
}

/** 读取某意识的存量快照(内存 → localStorage;损坏/缺失/过期返回 null)。 */
export function loadGhostSettingsSnapshot(
  dataOwnerId: string | null,
  ghostId: string,
): GhostSettingsSnapshot | null {
  if (!dataOwnerId) return null;
  const key = snapshotKey(dataOwnerId, ghostId);
  const cached = memoryCache.get(key);
  if (cached !== undefined) return cached;
  let snapshot: GhostSettingsSnapshot | null = null;
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + key);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isValidSnapshot(parsed)) {
        if (Date.now() - parsed.capturedAt > SNAPSHOT_TTL_MS) {
          removePersisted(dataOwnerId, ghostId);
        } else {
          snapshot = parsed;
        }
      }
    }
  } catch {
    // localStorage 不可用或 JSON 损坏:视同没有快照,走老的淡入路径。
  }
  memoryCache.set(key, snapshot);
  return snapshot;
}

/** 遍历所有新版持久快照键；旧的无 owner 快照不会进入回调。 */
function forEachPersisted(
  fn: (identity: { key: string; dataOwnerId: string; ghostId: string }, raw: string) => void,
): void {
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && key.startsWith(STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const raw = localStorage.getItem(key);
      const scopedKey = key.slice(STORAGE_PREFIX.length);
      const identity = parseSnapshotKey(scopedKey);
      if (raw !== null && identity) fn({ key: scopedKey, ...identity }, raw);
    }
  } catch {
    // localStorage 不可用:静默(持久化本就是 best-effort)。
  }
}

/**
 * 存快照(内存必存;持久化 best-effort):单条超限只留内存;写入前按
 * capturedAt 淘汰最旧的其它快照直到总量回到预算内;写失败静默降级仅内存。
 */
export function saveGhostSettingsSnapshot(
  dataOwnerId: string | null,
  ghostId: string,
  snapshot: GhostSettingsSnapshot,
): void {
  if (!dataOwnerId) return;
  const key = snapshotKey(dataOwnerId, ghostId);
  memoryCache.set(key, snapshot);
  if (snapshot.dataUrl.length > MAX_PERSIST_CHARS) {
    // 单条超限只留内存;同 id 更早的持久快照顺手清掉——它已确认过时,
    // 重启后贴一张旧画面不如诚实走淡入。
    removePersisted(dataOwnerId, ghostId);
    return;
  }
  const serialized = JSON.stringify(snapshot);
  // 总量预算:收集其它快照的体积与拍摄时间,超预算从最旧开始腾位。
  const others: Array<{ id: string; size: number; capturedAt: number }> = [];
  forEachPersisted((identity, raw) => {
    if (identity.key === key) return;
    let capturedAt = 0;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (isValidSnapshot(parsed)) capturedAt = parsed.capturedAt;
    } catch {
      // 坏数据当最旧(capturedAt 0),优先被淘汰。
    }
    others.push({ id: identity.key, size: raw.length, capturedAt });
  });
  let total = serialized.length + others.reduce((sum, o) => sum + o.size, 0);
  if (total > TOTAL_PERSIST_BUDGET_CHARS) {
    others.sort((a, b) => a.capturedAt - b.capturedAt);
    for (const victim of others) {
      if (total <= TOTAL_PERSIST_BUDGET_CHARS) break;
      const identity = parseSnapshotKey(victim.id);
      if (identity) removePersisted(identity.dataOwnerId, identity.ghostId);
      memoryCache.delete(victim.id);
      total -= victim.size;
    }
  }
  try {
    localStorage.setItem(STORAGE_PREFIX + key, serialized);
  } catch {
    // 配额满等写失败:内存缓存仍生效(本会话内复用),不影响功能。
  }
}

/**
 * 按"当前已装意识清单"清理孤儿快照(卸载后的快照没有存在理由)。
 * 由意识清单同步点(启动 + ghosts:changed)顺手调用,幂等。
 */
export function pruneGhostSettingsSnapshots(
  dataOwnerId: string | null,
  installedGhostIds: Iterable<string>,
): void {
  if (!dataOwnerId) return;
  const keep = new Set(installedGhostIds);
  const orphanIds: string[] = [];
  forEachPersisted((identity) => {
    if (identity.dataOwnerId === dataOwnerId && !keep.has(identity.ghostId)) {
      orphanIds.push(identity.ghostId);
    }
  });
  for (const id of orphanIds) {
    removePersisted(dataOwnerId, id);
    const key = snapshotKey(dataOwnerId, id);
    memoryCache.delete(key);
  }
  for (const key of [...memoryCache.keys()]) {
    const identity = parseSnapshotKey(key);
    if (identity?.dataOwnerId === dataOwnerId && !keep.has(identity.ghostId)) {
      memoryCache.delete(key);
    }
  }
}

/** 上下文匹配:插件版本 / 宿主布局版本 / 主题 CSS / DPR 全等才允许贴图。 */
export function snapshotMatchesContext(
  snapshot: GhostSettingsSnapshot,
  ctx: GhostSettingsSnapshotContext,
): boolean {
  return (
    snapshot.version === ctx.version &&
    snapshot.layoutRevision === GHOST_SETTINGS_LAYOUT_REVISION &&
    snapshot.themeCss === ctx.themeCss &&
    snapshot.dpr === ctx.dpr
  );
}

/** 宽度匹配(容器实际宽度要等首帧布局后才知道,单独一步校验)。 */
export function snapshotMatchesWidth(snapshot: GhostSettingsSnapshot, hostWidth: number): boolean {
  return Math.abs(snapshot.width - hostWidth) <= SNAPSHOT_WIDTH_TOLERANCE;
}

/** 仅测试用:清空内存缓存,让用例重新走 localStorage 读取路径。 */
export function __resetGhostSettingsSnapshotCacheForTest(): void {
  memoryCache.clear();
}
