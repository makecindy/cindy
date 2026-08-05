import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RemoteSession } from '@/session/types';

// 「首页设备 + 会话列表」冷启动持久缓存:冷启动时先用上次 loadHome 成功后的 last-known 快照
// 乐观画出列表(消除首屏强制 spinner),fresh loadHome 回来后由 store 正常对账覆盖并回写缓存。
// 后端与 mobileSessionMessageCache 保持一致(AsyncStorage),遵守 docs/design-rules/DESIGN.md:
// 先画缓存、拿到新数据再刷新、绝不闪空白。
// 瘦身原则:只存列表渲染 / 分组 / 跳转需要的字段白名单(coerceCachedSession),不 dump 整个 store;
// 长文本字段截断、live-only 状态(attached / 运行态)一律不缓存——缓存的设备不是 live 设备,
// 新建对话的 disabled 判定仍以 live 数据为准(见 devices/index.tsx)。
// v2 起 key 按 userId 隔离:auth 失效路径不止显式登出——401 掉线时 AuthContext.refresh()
// 只清 token 不清缓存,换账号登录会短暂闪出上一账号的设备/会话列表。按账号键控后旧账号
// 的 key 天然读不到,且同账号重登仍享受缓存;显式登出照旧全量清(隐私口径,见 clear)。
const STORAGE_KEY_PREFIX = 'xdt.mobileHomeListCache.v2.';
// v1 全局 key(未按账号隔离)彻底废弃:内容无法归属账号、不可信,读/清路径只做删除。
const LEGACY_STORAGE_KEY = 'xdt.mobileHomeListCache.v1';
// 条数上限:首页首屏只需要一两屏内容,设备与每设备会话都设硬上限防缓存膨胀。
export const MAX_CACHED_HOME_DEVICES = 8;
export const MAX_CACHED_HOME_SESSIONS_PER_DEVICE = 100;
// 长文本字段(title / preview / workingDir 等)统一截断:预览行只显示一行,240 字符绰绰有余。
export const MAX_CACHED_HOME_TEXT_CHARS = 240;
// 序列化总体积兜底:超限时按 SHRINK_STEPS 逐级缩小每设备会话数;仍超则放弃写入(宁缺毋滥)。
export const MAX_CACHED_HOME_LIST_BYTES = 512 * 1024;
const SHRINK_STEPS = [MAX_CACHED_HOME_SESSIONS_PER_DEVICE, 40, 15] as const;
// 回写去抖:loadHome / hydrate 成功后可能连续多次触发(多设备并发 hydrate),静默一小段后只落盘一次。
const HOME_LIST_PERSIST_DEBOUNCE_MS = 1200;

/** 缓存快照里的单台设备:deviceId / deviceName 用于 store shard 种入时重新 stamp。 */
export interface CachedHomeDeviceSnapshot {
  deviceId: string;
  deviceName: string;
  sessions: RemoteSession[];
}

type StoredHomeListCache = {
  version: 1;
  updatedAt: number;
  devices: CachedHomeDeviceSnapshot[];
};

function storageKeyForUser(userId: string): string {
  return `${STORAGE_KEY_PREFIX}${userId}`;
}

// 读取快照;无缓存 / JSON 损坏 / 形状不对 / userId 缺失一律静默返回空数组(乐观 hydrate 不应抛错)。
export async function getCachedHomeListSnapshot(userId: string): Promise<CachedHomeDeviceSnapshot[]> {
  // 废弃的 v1 全局 key 顺带清掉(fire-and-forget,不阻塞冷启动首帧)。
  void AsyncStorage.removeItem(LEGACY_STORAGE_KEY).catch(() => undefined);
  if (!userId.trim()) return [];
  const raw = await AsyncStorage.getItem(storageKeyForUser(userId)).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const devices = isRecord(parsed) && Array.isArray((parsed as StoredHomeListCache).devices)
      ? (parsed as StoredHomeListCache).devices
      : [];
    return normalizeSnapshotDevices(devices, MAX_CACHED_HOME_SESSIONS_PER_DEVICE);
  } catch {
    return [];
  }
}

// 写入快照:入参是 store 里已 stamp 的合并会话列表(带 deviceLinkDeviceId/Name),内部按设备分组
// + 白名单瘦身 + 条数/体积裁剪。归一化后为空(没有可缓存内容)等于清掉缓存,避免残留陈旧快照。
export async function cacheHomeListSnapshot(userId: string, sessions: readonly RemoteSession[]): Promise<void> {
  if (!userId.trim()) return;
  const storageKey = storageKeyForUser(userId);
  // 捕获发起时代际:clearCachedHomeListSnapshot(登出)会自增代际,作废 in-flight 写入
  // ——只取消未触发的定时器防不住"debounce 已触发、异步写还在天上"的窗口,那会把上一
  // 账号的快照写回。写前写后各核对一次,写后发现被作废则删掉刚落盘的产物。
  const epoch = writeEpoch;
  const grouped = groupSessionsByDevice(sessions);
  for (const perDeviceLimit of SHRINK_STEPS) {
    const devices = normalizeSnapshotDevices(grouped, perDeviceLimit);
    if (devices.length === 0) {
      await AsyncStorage.removeItem(storageKey).catch(() => undefined);
      return;
    }
    const payload: StoredHomeListCache = { version: 1, updatedAt: Date.now(), devices };
    const serialized = JSON.stringify(payload);
    if (utf8ByteLength(serialized) > MAX_CACHED_HOME_LIST_BYTES) continue;
    if (epoch !== writeEpoch) return;
    await AsyncStorage.setItem(storageKey, serialized).catch(() => undefined);
    if (epoch !== writeEpoch) {
      await AsyncStorage.removeItem(storageKey).catch(() => undefined);
    }
    return;
  }
  // 缩到最小档仍超体积上限:放弃本次写入,保留旧快照(缓存只是首屏加速,不追求完整)。
}

// 去抖回写:collect 在定时器触发时才执行,拿的是届时最新的 store 快照(不闭包旧数据)。
// 模块级单定时器——首页是单例屏,多设备 hydrate 连续调度只保留最后一次。
let persistTimer: ReturnType<typeof setTimeout> | null = null;
// 写入代际:clear(登出)自增以作废 in-flight 写入。
let writeEpoch = 0;
let pendingCollect: (() => readonly RemoteSession[]) | null = null;

export function scheduleHomeListSnapshotPersist(
  userId: string,
  collect: () => readonly RemoteSession[],
  debounceMs: number = HOME_LIST_PERSIST_DEBOUNCE_MS,
): void {
  pendingCollect = collect;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const fn = pendingCollect;
    pendingCollect = null;
    if (!fn) return;
    try {
      void cacheHomeListSnapshot(userId, fn()).catch(() => undefined);
    } catch {
      // collect 本身抛错也静默:回写失败最多损失一次快照更新,不能影响首页交互。
    }
  }, debounceMs);
}

// 登出清空:必须先取消 pending 回写定时器——否则登出清掉缓存后,残留定时器会把上一账号的
// 快照重新写回(跨账号数据泄漏)。隐私口径:显式登出后设备上不留任何账号的列表快照,
// 因此清的是全部 v2 前缀 key(不只当前账号)+ 废弃的 v1 全局 key。
export async function clearCachedHomeListSnapshot(): Promise<void> {
  // 自增代际,作废所有 in-flight 的 cacheHomeListSnapshot 写入(见其代际核对)。
  writeEpoch += 1;
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  pendingCollect = null;
  const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
  const targets = keys.filter((key) => key.startsWith(STORAGE_KEY_PREFIX));
  await AsyncStorage.multiRemove([...targets, LEGACY_STORAGE_KEY]).catch(() => undefined);
}

// 按物理设备 id(deviceLinkDeviceId)分组:store 种入时按 shard 维度回放,与 setDeviceSessions 对齐。
function groupSessionsByDevice(sessions: readonly RemoteSession[]): CachedHomeDeviceSnapshot[] {
  const byDevice = new Map<string, CachedHomeDeviceSnapshot>();
  for (const session of sessions) {
    const deviceId = session.deviceLinkDeviceId?.trim();
    if (!deviceId) continue;
    const shard = byDevice.get(deviceId) ?? {
      deviceId,
      deviceName: session.deviceLinkDeviceName?.trim() || deviceId,
      sessions: [],
    };
    shard.sessions.push(session);
    byDevice.set(deviceId, shard);
  }
  return [...byDevice.values()];
}

// 归一化 + 裁剪:逐设备 coerce 白名单字段、按 id 去重、按最近活动排序取前 N;设备按最新活动
// 排序取前 MAX_CACHED_HOME_DEVICES。读 / 写共用同一套归一化,损坏条目直接丢弃。
function normalizeSnapshotDevices(
  input: readonly unknown[],
  perDeviceLimit: number,
): CachedHomeDeviceSnapshot[] {
  const devices: CachedHomeDeviceSnapshot[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const deviceId = typeof item.deviceId === 'string' ? item.deviceId.trim() : '';
    if (!deviceId) continue;
    const rawSessions = Array.isArray(item.sessions) ? item.sessions : [];
    const byId = new Map<string, RemoteSession>();
    for (const raw of rawSessions) {
      const session = coerceCachedSession(raw);
      if (session) byId.set(session.id, session);
    }
    const sessions = [...byId.values()]
      .sort((a, b) => lastActivityTime(b).localeCompare(lastActivityTime(a)))
      .slice(0, perDeviceLimit);
    if (sessions.length === 0) continue;
    const deviceName = typeof item.deviceName === 'string' && item.deviceName.trim()
      ? item.deviceName.trim()
      : deviceId;
    devices.push({ deviceId, deviceName, sessions });
  }
  return devices
    .sort((a, b) => lastActivityTime(b.sessions[0]).localeCompare(lastActivityTime(a.sessions[0])))
    .slice(0, MAX_CACHED_HOME_DEVICES);
}

// 会话字段白名单瘦身:只保留列表渲染(标题 / 预览 / 时间 / 图标)、分组(workingDir / workspaceKind)
// 与跳转(id)需要的字段。刻意丢弃:
//  - live-only 状态(attached / deviceLinkAttached 等):冷启动时设备尚未连上,缓存它会画出假的在线态;
//  - orcaRole === 'worker' 的会话:mobile 全局隐藏 worker 子会话,缓存它纯占体积;
//  - deleted / 未知 status:不该出现在列表里;
//  - 大字段(_count / extraDirs / token 统计等):列表行不消费。
// 草稿类标记(hasDraft / hasPausedQueue / composerDraft)保留——它们在被控端持久化,冷启动展示不失真。
function coerceCachedSession(item: unknown): RemoteSession | null {
  if (!isRecord(item)) return null;
  const id = typeof item.id === 'string' ? item.id : '';
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
  if (!id || !createdAt) return null;
  const status = item.status === 'active' ? 'active' : item.status === 'archived' ? 'archived' : null;
  if (!status) return null;
  const orcaRole = typeof item.orcaRole === 'string' ? item.orcaRole : null;
  if (orcaRole === 'worker') return null;

  const session: RemoteSession = {
    id,
    userId: typeof item.userId === 'string' ? item.userId : '',
    title: truncateText(typeof item.title === 'string' ? item.title : ''),
    workingDir: typeof item.workingDir === 'string' ? truncateText(item.workingDir) : null,
    workspaceKind: item.workspaceKind === 'dialogue' ? 'dialogue' : 'project',
    model: typeof item.model === 'string' ? truncateText(item.model) : '',
    effort: typeof item.effort === 'string' ? item.effort : '',
    permissionMode: typeof item.permissionMode === 'string' ? item.permissionMode : '',
    fastMode: item.fastMode === true,
    status,
    agentKind: item.agentKind === 'codex' ? 'codex' : 'cc',
    userSendAt: typeof item.userSendAt === 'string' ? item.userSendAt : null,
    createdAt,
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : createdAt,
  };
  if (typeof item.worktreePath === 'string') session.worktreePath = truncateText(item.worktreePath);
  if (typeof item.source === 'string') session.source = item.source;
  if (orcaRole) session.orcaRole = orcaRole;
  if (typeof item.pinnedAt === 'string') session.pinnedAt = item.pinnedAt;
  if (typeof item.preview === 'string') session.preview = truncateText(item.preview);

  // interface 之外的草稿类布尔标记(HomeSessionRow 用 readBooleanField 读取),只保留 true 值。
  const extras: Record<string, unknown> = {};
  for (const key of ['hasDraft', 'hasPausedQueue', 'composerDraft'] as const) {
    if (item[key] === true) extras[key] = true;
  }
  return Object.keys(extras).length > 0 ? ({ ...session, ...extras } as RemoteSession) : session;
}

function lastActivityTime(session: RemoteSession): string {
  return session.userSendAt ?? session.updatedAt ?? session.createdAt;
}

function truncateText(value: string): string {
  return value.length > MAX_CACHED_HOME_TEXT_CHARS ? value.slice(0, MAX_CACHED_HOME_TEXT_CHARS) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export const __testing = {
  storageKeyForUser,
  legacyStorageKey: LEGACY_STORAGE_KEY,
  coerceCachedSession,
  groupSessionsByDevice,
};

/**
 * UTF-8 字节数(体积上限的真实口径)。`string.length` 是 UTF-16 code unit 数,
 * 中文在 AsyncStorage 实际落盘的 UTF-8 里占 3 字节,直接比 length 会低估至 3 倍。
 * 不用 Blob/TextEncoder:两者在 RN/Hermes 与 node 测试环境的可用性不一致,
 * 手算编码宽度零依赖且可单测。
 */
export function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.codePointAt(i)!;
    if (code > 0xffff) i += 1; // surrogate pair 占两个 code unit
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}
