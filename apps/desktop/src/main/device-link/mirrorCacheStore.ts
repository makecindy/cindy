/**
 * mirrorCacheStore —— 控制端「远程会话镜像」的本地冷缓存(落盘)。
 * ---------------------------------------------------------------------------
 * 解决的问题:控制端对远程(device-link)会话刻意零持久化,于是每次重启后
 *   - 打开远程会话必须等隧道往返(RemoteSessionLoading spinner),
 *   - 被控端离线时干脆看不到任何历史,
 *   - 侧边栏的远程项目要等 bootstrap 拉回列表才出现。
 * 手机端早已有等价冷缓存(apps/mobile/src/session/mobileSessionMessageCache.ts 与
 * mobileHomeListCache.ts,后端 AsyncStorage)。本模块是桌面端等价物。
 *
 * 边界(与 remoteProjectsStore 的「控制端零权威状态」不冲突):
 *  - 缓存是**可重建的首屏镜像**,不是真相。被控端仍是唯一真相源;fresh 数据一到即整体接管。
 *  - 只读路径消费缓存,写路径(发消息 / 改会话)永不读它。
 *  - **不缓存 live 态**(attached / 运行态 / 连接状态):冷启动时设备还没连上,
 *    缓存它会画出假在线。会话列表种入时一律标 disconnected(见 renderer 侧 hydrateFromCache)。
 *
 * 为什么落在 main 而不是 renderer 的 localStorage:
 * docs/dev-rules/electron-security-and-process-boundaries.md §2 —— Renderer 不直接读写磁盘,
 * 持久状态由 Main 管理,Renderer 只持有视图状态与可重建缓存。localStorage 每 origin 硬限
 * 5MB 且已被大量偏好共享,同步写还会阻塞 UI 线程。
 *
 * 存储位置与生命周期(docs/dev-rules/credentials-and-local-storage.md):
 *   ownerScopedUserDataPath('device-link-mirror-cache')/
 *     messages/<deviceHash>-<sessionHash>.json   每 (设备, 会话) 最近一页消息
 *     session-list.json                          全部被控设备的会话列表快照
 * owner 命名空间由 appSessionState 提供 —— 换账号 / 登出后天然读不到旧数据,无需手工按
 * userId 键控(手机端 mobileHomeListCache 的 v2 正是为此改成按账号键控)。clearAll 仍保留,
 * 作为显式登出时的隐私兜底。
 *
 * 纯逻辑(瘦身 / 裁剪 / key 生成 / 校验)与 IO 分离,root 可注入 → node 环境可单测。
 */

import path from 'node:path';
import fsp from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';

import { ownerScopedUserDataPath } from '../appSessionState';
import { createLogger } from '../logger';

const log = createLogger('device-link:mirror-cache');

/** 每会话缓存的消息条数:对齐 local-db messages:list 的 DEFAULT_LIMIT(50)。 */
export const MAX_CACHED_MESSAGES = 50;
/** 单个会话消息文件的字节上限;超限放弃写入并保留旧文件(缓存只是加速,宁缺毋滥)。 */
export const MAX_MESSAGE_FILE_BYTES = 512 * 1024;
/** messages/ 目录的文件数与总字节上限,超限按 mtime LRU 逐出最旧。 */
export const MAX_MESSAGE_FILES = 200;
export const MAX_MESSAGE_DIR_BYTES = 64 * 1024 * 1024;
/** 会话列表快照的上限:首屏只需要一两屏内容。 */
export const MAX_CACHED_DEVICES = 8;
export const MAX_CACHED_SESSIONS_PER_DEVICE = 100;
export const MAX_SESSION_LIST_BYTES = 512 * 1024;
/** 体积超限时逐级缩小每设备会话数(仿手机端 SHRINK_STEPS);最小档仍超则放弃写入。 */
const SESSION_LIST_SHRINK_STEPS = [MAX_CACHED_SESSIONS_PER_DEVICE, 40, 15] as const;
/** 长文本字段(标题 / 预览 / 路径)统一截断:列表行只显示一行。 */
export const MAX_CACHED_TEXT_CHARS = 240;

const MESSAGES_DIR = 'messages';
const SESSION_LIST_FILE = 'session-list.json';

/** 缓存快照里的单台设备(deviceName 供种入时重新 stamp)。 */
export interface CachedDeviceSessions {
  deviceId: string;
  deviceName: string;
  sessions: Record<string, unknown>[];
}

interface StoredMessages {
  version: 1;
  updatedAt: number;
  messages: Record<string, unknown>[];
}

interface StoredSessionList {
  version: 1;
  updatedAt: number;
  devices: CachedDeviceSessions[];
}

// ─── 纯逻辑 ──────────────────────────────────────────────────────────────────

/**
 * 缓存文件名。deviceId / sessionId 来自 renderer,一律当不可信输入:
 * 先消毒成可见片段(只留 [A-Za-z0-9._-]、截断),再拼 sha256 前 16 位保证唯一。
 * 消毒后的片段只为人肉排查可读,唯一性完全靠哈希。
 */
export function messageFileName(deviceId: string, sessionId: string): string {
  return `${safeSegment(deviceId)}-${shortHash(deviceId)}-${safeSegment(sessionId)}-${shortHash(sessionId)}.json`;
}

/**
 * 消毒成可见片段。**点号也替换掉** —— 拼进文件名的 `..` 即使配上哈希后缀也穿不出目录,
 * 但让缓存目录里出现 `.._..-<hash>.json` 这种名字纯属自找麻烦(review 要重新论证一遍
 * 安全性,某些工具链也会对它另眼相看)。可读性由字母数字片段负责,唯一性全靠哈希。
 */
function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 24) || 'x';
}

function shortHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

/**
 * 消息条目归一化:按 messageKey(id → clientId)去重、按 createdAt 升序、取最新 N 条。
 * **字段原样保留**——缓存的 row 与 fresh 的 row 越接近,renderer 的逐字段比较越容易短路,
 * 冷开会话不会出现 cached→fresh 的可见重渲染(手机端同一取舍)。
 */
export function normalizeMessages(input: readonly unknown[]): Record<string, unknown>[] {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const item of input) {
    if (!isRecord(item)) continue;
    const id = typeof item.id === 'string' ? item.id : '';
    const clientId = typeof item.clientId === 'string' ? item.clientId : '';
    if (!id && !clientId) continue;
    byKey.set(id || clientId, item);
  }
  return [...byKey.values()]
    .sort((a, b) => messageOrderKey(a) - messageOrderKey(b))
    .slice(-MAX_CACHED_MESSAGES);
}

function messageOrderKey(message: Record<string, unknown>): number {
  const createdAt = message.createdAt;
  if (typeof createdAt === 'number' && Number.isFinite(createdAt)) return createdAt;
  if (typeof createdAt === 'string') {
    const parsed = Date.parse(createdAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/**
 * 会话列表瘦身:只留列表渲染(标题 / 预览 / 时间 / 图标)、分组(workingDir / workspaceKind)
 * 与跳转(id)需要的字段白名单,长文本截断。
 * 刻意丢弃 live-only 字段(deviceLinkConnectionStatus / attached / 运行态)与大字段
 * (_count / extraDirs / token 统计):前者会画出假在线,后者列表行不消费。
 */
const SESSION_FIELD_WHITELIST = [
  'id',
  'userId',
  'title',
  'workingDir',
  'workspaceKind',
  'worktreePath',
  'model',
  'effort',
  'permissionMode',
  'fastMode',
  'status',
  'agentKind',
  'source',
  'orcaRole',
  'parentSessionId',
  'pinnedAt',
  'preview',
  'userSendAt',
  'createdAt',
  'updatedAt',
] as const;

const TRUNCATED_TEXT_FIELDS = new Set<string>([
  'title',
  'preview',
  'workingDir',
  'worktreePath',
  'model',
]);

export function coerceCachedSession(input: unknown): Record<string, unknown> | null {
  if (!isRecord(input)) return null;
  if (typeof input.id !== 'string' || !input.id) return null;
  const status = input.status;
  if (status !== 'active' && status !== 'archived') return null;
  const out: Record<string, unknown> = {};
  for (const key of SESSION_FIELD_WHITELIST) {
    const value = input[key];
    if (value === undefined) continue;
    out[key] = typeof value === 'string' && TRUNCATED_TEXT_FIELDS.has(key)
      ? truncateText(value)
      : value;
  }
  return out;
}

export function normalizeDeviceSessions(
  input: readonly unknown[],
  perDeviceLimit = MAX_CACHED_SESSIONS_PER_DEVICE,
): CachedDeviceSessions[] {
  const devices: CachedDeviceSessions[] = [];
  for (const item of input) {
    if (!isRecord(item)) continue;
    const deviceId = typeof item.deviceId === 'string' ? item.deviceId.trim() : '';
    if (!deviceId) continue;
    const rawSessions = Array.isArray(item.sessions) ? item.sessions : [];
    const byId = new Map<string, Record<string, unknown>>();
    for (const raw of rawSessions) {
      const session = coerceCachedSession(raw);
      if (session) byId.set(session.id as string, session);
    }
    const sessions = [...byId.values()]
      .sort((a, b) => lastActivityTime(b) - lastActivityTime(a))
      .slice(0, perDeviceLimit);
    if (sessions.length === 0) continue;
    const deviceName = typeof item.deviceName === 'string' && item.deviceName.trim()
      ? truncateText(item.deviceName.trim())
      : deviceId;
    devices.push({ deviceId, deviceName, sessions });
  }
  return devices
    .sort((a, b) => lastActivityTime(b.sessions[0]) - lastActivityTime(a.sessions[0]))
    .slice(0, MAX_CACHED_DEVICES);
}

function lastActivityTime(session: Record<string, unknown> | undefined): number {
  if (!session) return 0;
  return (
    parseTime(session.userSendAt) || parseTime(session.updatedAt) || parseTime(session.createdAt)
  );
}

function parseTime(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function truncateText(value: string): string {
  return value.length > MAX_CACHED_TEXT_CHARS ? value.slice(0, MAX_CACHED_TEXT_CHARS) : value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// ─── 带 IO 的缓存实例 ────────────────────────────────────────────────────────

export interface MirrorCache {
  readMessages(deviceId: string, sessionId: string): Promise<Record<string, unknown>[]>;
  writeMessages(deviceId: string, sessionId: string, messages: readonly unknown[]): Promise<void>;
  readSessionList(): Promise<CachedDeviceSessions[]>;
  writeSessionList(devices: readonly unknown[]): Promise<void>;
  /** 某设备离场(移除 / 撤销控制):清掉它的消息文件与列表快照条目。 */
  clearDevice(deviceId: string): Promise<void>;
  /** 显式登出等隐私路径:整棵缓存目录删掉。 */
  clearAll(): Promise<void>;
}

/** 创建一个以 `root` 为根的缓存实例(测试注入临时目录)。 */
export function createMirrorCache(resolveRoot: () => string): MirrorCache {
  const messagesDir = (): string => path.join(resolveRoot(), MESSAGES_DIR);
  const sessionListPath = (): string => path.join(resolveRoot(), SESSION_LIST_FILE);
  /**
   * 上次写入内容的指纹(文件路径 → sha256)。写路径被调得很勤:列表快照跟着 10 秒一轮的
   * anti-entropy 走,消息缓存跟着每次对账(focus / 重连 / turn 结束)走,而绝大多数轮次
   * 内容一个字节都没变。没有这层去重就是每 10 秒一次无意义的落盘。
   * 只在进程内有效(重启后第一次写照写),清理路径会把它一起清掉。
   */
  const lastWritten = new Map<string, string>();

  /** 内容与上次写入一致 → 跳过。返回 true 表示可以跳过本次写入。 */
  function unchanged(file: string, content: string): boolean {
    const digest = createHash('sha256').update(content).digest('hex');
    if (lastWritten.get(file) === digest) return true;
    lastWritten.set(file, digest);
    return false;
  }

  return {
    async readMessages(deviceId, sessionId) {
      if (!deviceId.trim() || !sessionId.trim()) return [];
      const parsed = await readJson(path.join(messagesDir(), messageFileName(deviceId, sessionId)));
      const messages = isRecord(parsed) && Array.isArray(parsed.messages) ? parsed.messages : [];
      return normalizeMessages(messages);
    },

    async writeMessages(deviceId, sessionId, messages) {
      if (!deviceId.trim() || !sessionId.trim()) return;
      const dir = messagesDir();
      const file = path.join(dir, messageFileName(deviceId, sessionId));
      const normalized = normalizeMessages(messages);
      // 空列表 = 清掉这条缓存(被控端 /clear、rewind 或删完最后一条时,残留会在
      // 下次冷开 hydrate 出已经不存在的正文)。
      if (normalized.length === 0) {
        lastWritten.delete(file);
        await fsp.rm(file, { force: true }).catch(() => undefined);
        return;
      }
      const payload: StoredMessages = { version: 1, updatedAt: Date.now(), messages: normalized };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MESSAGE_FILE_BYTES) {
        // 单会话超限:放弃本次写入,保留旧文件(缓存只是首屏加速)。
        return;
      }
      // 指纹只算消息体,不含 payload 的 updatedAt —— 否则每次都"变了",去重永不命中。
      if (unchanged(file, JSON.stringify(normalized))) return;
      await ensureDir(dir);
      if (!(await writeFileAtomic(file, serialized))) return;
      await evictMessagesIfNeeded(dir);
    },

    async readSessionList() {
      const parsed = await readJson(sessionListPath());
      const devices = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : [];
      return normalizeDeviceSessions(devices);
    },

    async writeSessionList(devices) {
      const file = sessionListPath();
      for (const perDeviceLimit of SESSION_LIST_SHRINK_STEPS) {
        const normalized = normalizeDeviceSessions(devices, perDeviceLimit);
        if (normalized.length === 0) {
          lastWritten.delete(file);
          await fsp.rm(file, { force: true }).catch(() => undefined);
          return;
        }
        const payload: StoredSessionList = {
          version: 1,
          updatedAt: Date.now(),
          devices: normalized,
        };
        const serialized = JSON.stringify(payload);
        if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_LIST_BYTES) continue;
        // 同 writeMessages:指纹只算 devices,不含 updatedAt。10 秒一轮的 anti-entropy
        // 绝大多数时候内容没变,这里直接跳过落盘。
        if (unchanged(file, JSON.stringify(normalized))) return;
        await ensureDir(path.dirname(file));
        await writeFileAtomic(file, serialized);
        return;
      }
      // 缩到最小档仍超上限:保留旧快照,不写入。
    },

    async clearDevice(deviceId) {
      const id = deviceId.trim();
      if (!id) return;
      const dir = messagesDir();
      const prefix = `${safeSegment(id)}-${shortHash(id)}-`;
      const names = await listFiles(dir);
      await Promise.all(
        names
          .filter((name) => name.startsWith(prefix))
          .map((name) => {
            // 指纹一起清:文件删了却留着指纹,下次写同样内容会被去重跳过 → 文件回不来。
            lastWritten.delete(path.join(dir, name));
            return fsp.rm(path.join(dir, name), { force: true }).catch(() => undefined);
          }),
      );
      const remaining = (await this.readSessionList()).filter(
        (device) => device.deviceId !== id,
      );
      await this.writeSessionList(remaining);
    },

    async clearAll() {
      lastWritten.clear();
      await fsp.rm(resolveRoot(), { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/** messages/ 超文件数或总字节上限时按 mtime 逐出最旧(缓存越旧越不值钱)。 */
async function evictMessagesIfNeeded(dir: string): Promise<void> {
  const names = await listFiles(dir);
  if (names.length === 0) return;
  const stats: Array<{ name: string; size: number; mtimeMs: number }> = [];
  for (const name of names) {
    try {
      const stat = await fsp.stat(path.join(dir, name));
      stats.push({ name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // 并发删除等竞态:忽略这一条。
    }
  }
  let totalBytes = stats.reduce((sum, entry) => sum + entry.size, 0);
  if (stats.length <= MAX_MESSAGE_FILES && totalBytes <= MAX_MESSAGE_DIR_BYTES) return;
  stats.sort((a, b) => a.mtimeMs - b.mtimeMs);
  let count = stats.length;
  for (const entry of stats) {
    if (count <= MAX_MESSAGE_FILES && totalBytes <= MAX_MESSAGE_DIR_BYTES) break;
    await fsp.rm(path.join(dir, entry.name), { force: true }).catch(() => undefined);
    count -= 1;
    totalBytes -= entry.size;
  }
}

async function listFiles(dir: string): Promise<string[]> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8')) as unknown;
  } catch {
    // 缺文件 / 损坏 JSON 一律当未命中:缓存读路径不许抛错。
    return null;
  }
}

async function ensureDir(dir: string): Promise<void> {
  await fsp.mkdir(dir, { recursive: true }).catch(() => undefined);
}

/**
 * 原子落位:写临时文件再 rename。失败时删掉半成品并返回 false ——
 * 绝不能让被中断的写入留下一个能被解析成「更少消息」的文件。
 */
async function writeFileAtomic(file: string, content: string): Promise<boolean> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, file);
    return true;
  } catch (err) {
    log.debug(`mirror cache write failed: ${file}`, err);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
}

// ─── 默认单例(owner 作用域)─────────────────────────────────────────────────

let instance: MirrorCache | null = null;

export function getMirrorCache(): MirrorCache {
  // resolveRoot 每次调用都重新解析:owner(登录账号)在进程生命周期内会变,
  // 缓存住路径会让换账号后继续读写上一个账号的命名空间。
  instance ??= createMirrorCache(() => ownerScopedUserDataPath('device-link-mirror-cache'));
  return instance;
}

export const __testing = {
  messagesDirName: MESSAGES_DIR,
  sessionListFileName: SESSION_LIST_FILE,
  safeSegment,
  shortHash,
};
