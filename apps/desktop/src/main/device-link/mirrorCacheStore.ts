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
import { withCrossProcessLock } from './crossProcessLock';
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
/**
 * 跨进程锁与作废计数器**不能放在缓存根里面** —— `clearAll()` 会递归删掉整棵缓存根,
 * 连带把自己正持着的锁和计数器一起删掉:此时另一个实例既能立刻抢到"不存在"的锁,又会把
 * 缺失的计数器读成初始值 0(与它发起时读到的一样)→ 于是它把上一个账号的正文重建出来,
 * 而 clearAll 照报成功(review: codex P1)。所以它们放在缓存根的**兄弟**目录里,
 * 仍在 owner 命名空间内(切账号照样隔离),但不在被删的子树中。
 */
const CACHE_CONTROL_SUFFIX = '.control';
const CACHE_LOCK_FILE = 'lock';
/** clearAll 的账号级作废计数器(与逐设备计数器同机制,只是全局一份)。 */
const CLEARED_ACCOUNT = '_account';
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
 * 先 **trim 归一** 再消毒成可见片段(只留 `[A-Za-z0-9_-]`、截断),最后拼 sha256 前 16 位保证唯一。
 * 消毒后的片段只为人肉排查可读,唯一性完全靠哈希。
 *
 * trim 是**正确性**要求,不只是整洁:IPC 层的 `requireString` 不 trim,于是 `"dev "` 与 `"dev"`
 * 会落到两个不同文件,而 `clearDevice` / 读路径都按 trim 后的值算前缀 —— 带空白的那份就永远
 * 清不掉也读不到。写、读、清三条路径必须共用同一套归一化(review: copilot)。
 */
export function messageFileName(deviceId: string, sessionId: string): string {
  const device = deviceId.trim();
  const session = sessionId.trim();
  return `${safeSegment(device)}-${shortHash(device)}-${safeSegment(session)}-${shortHash(session)}.json`;
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

function digestOf(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
    byKey.set(id || clientId, { ...item, content: stripInlineMedia(item.content, 0) });
  }
  return [...byKey.values()]
    .sort((a, b) => messageOrderKey(a) - messageOrderKey(b))
    .slice(-MAX_CACHED_MESSAGES);
}

/**
 * 剥掉 content 里的内联媒体字节(`base64` 字段、`data:…;base64,…` URI),其余**原样保留**。
 *
 * 为什么必须剥:那些字节是 cindy-media 托管的内容,把它们复制进镜像缓存目录等于在
 * 账本(ledger)与回收器之外多出一份未受管的明文副本(docs/dev-rules/media-storage-and-protocols.md);
 * 而渲染本来就优先用 url / 托管引用,剥掉不影响可见结果(手机端 mobileSessionMessageCache
 * 同款处理)(review: codex P1)。
 *
 * 无内联媒体的常规 content 逐字节不变 —— 这点很重要:缓存行与 fresh 行越接近,renderer 的
 * 逐字段比较越容易短路,冷开时不会出现 cached→fresh 的可见重渲染。
 */
const HEAVY_BLOB_KEYS = new Set(['base64']);
/** content 里疑似内联 base64 的 JSON 字符串:超过这个长度才值得解析 → 剥 → 回写。 */
const CONTENT_PARSE_THRESHOLD = 16_000;
const MAX_CONTENT_DEPTH = 12;

export function stripInlineMedia(value: unknown, depth: number): unknown {
  if (depth > MAX_CONTENT_DEPTH) return undefined;
  if (typeof value === 'string') return stripInlineMediaString(value, depth);
  if (Array.isArray(value)) return value.map((item) => stripInlineMedia(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (HEAVY_BLOB_KEYS.has(key)) continue;
      out[key] = stripInlineMedia(raw, depth + 1);
    }
    return out;
  }
  return value;
}

function stripInlineMediaString(value: string, depth: number): string {
  // data:...;base64,... 内联大块 → 丢弃(留空串占位),渲染走 url。
  if (value.startsWith('data:') && value.includes(';base64,')) return '';
  // 用户消息的 content 常是 JSON 字符串;只有"够大且疑似内联了 base64"时才解析,
  // 否则原样返回以保逐字节一致。
  if (value.length > CONTENT_PARSE_THRESHOLD && value.includes('base64')) {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return JSON.stringify(stripInlineMedia(JSON.parse(value), depth + 1)) ?? '';
      } catch {
        return value;
      }
    }
  }
  return value;
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

/**
 * 隐私清理没能把内容全部删掉。带上仍存在的文件清单,调用方据此**持久化一次重试**
 * (见 mirrorCachePurgeQueue):只记日志不够 —— 账号边界照常推进,而上一个账号的明文
 * 聊天缓存会无限期留在盘上(review: codex P1)。
 */
export class MirrorCachePurgeError extends Error {
  constructor(
    readonly root: string,
    readonly remaining: string[],
    readonly cause: unknown,
  ) {
    super(`device-link mirror cache purge incomplete: ${remaining.length} file(s) remain`);
    this.name = 'MirrorCachePurgeError';
  }
}

/**
 * 尽力删掉缓存目录里的内容,返回仍然存在(或**无法确认已消失**)的路径。
 * 逐个删而不是整棵 rm:一个删不掉的文件不该让其它文件也留下来。
 *
 * 关键区分:`readdir` 失败时只有 `ENOENT` 能推出「这里已经没有内容了」。权限不足
 * (EACCES / EPERM)、EBUSY 之类是**枚举失败** —— 目录里可能仍有明文缓存,却什么都数不出来。
 * 把它当成「没有残留」会让 clearAll 误报成功、不入重试队列(review: codex P1),
 * 所以这类目录本身要计入返回清单。
 */
async function purgeContents(root: string): Promise<string[]> {
  const remaining: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: Array<{ name: string; isDirectory(): boolean }>;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (errnoCode(err) !== 'ENOENT') remaining.push(dir); // 数不出来 ≠ 已经空了
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        await fsp.rmdir(full).catch(() => undefined); // 空壳目录删不掉无所谓
        continue;
      }
      try {
        await fsp.rm(full, { force: true });
      } catch {
        remaining.push(full);
      }
    }
  };
  await walk(root);
  return remaining;
}

function errnoCode(err: unknown): string | undefined {
  return typeof err === 'object' && err !== null && 'code' in err
    ? String((err as { code?: unknown }).code)
    : undefined;
}

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
   * 上次**成功落盘**内容的指纹(文件路径 → sha256)。写路径被调得很勤:列表快照跟着 10 秒
   * 一轮的 anti-entropy 走,消息缓存跟着每次对账(focus / 重连 / turn 结束)走,而绝大多数
   * 轮次内容一个字节都没变。没有这层去重就是每 10 秒一次无意义的落盘。
   * 只在进程内有效(重启后第一次写照写)。
   *
   * ⚠️ 指纹必须严格对应「盘上此刻真有这份内容」,任何让文件消失的路径都要同步删掉指纹,
   * 否则同内容的下一次写入会被跳过,该文件在本进程余生里再也回不来(review: greptile)。
   * 已覆盖:写入失败(只在成功后才记)、LRU 逐出、空写删除、clearDevice、clearAll。
   */
  const lastWritten = new Map<string, string>();

  /** 内容与上次成功落盘一致 → 可跳过。**不写入指纹**,记录留给写成功之后。 */
  function unchanged(file: string, content: string): boolean {
    return lastWritten.get(file) === digestOf(content);
  }

  /** 写成功后登记指纹(与 unchanged 配对使用)。 */
  function rememberWritten(file: string, content: string): void {
    lastWritten.set(file, digestOf(content));
  }

  /**
   * 写入代际。**任何清理路径**(clearAll 登出 / 切账号、clearDevice 撤销 / 关闭控制)都自增,
   * 作废所有在途写入 —— 隐私清理与 renderer 的 fire-and-forget 写盘是并发的,只删一次
   * 文件挡不住「清完之后才落地」的那一笔(它的原子 rename 会把刚被清掉的正文重建出来)。
   * 与手机端 mobileHomeListCache 的 writeEpoch 同款。
   *
   * clearDevice 用的是同一个全局代际、而不是 per-device 的:代价只是把并发的其它设备写入
   * 也一起作废(缓存少一次更新,下一轮对账就补回来),换来的是不必推理「消息文件按设备、
   * 列表快照跨设备」这两种粒度如何各自失效 —— 隐私路径上,保守比精巧值钱(review: codex P1)。
   */
  let generation = 0;

  /**
   * 仅 `clearAll` 自增的代际。`clearDevice` 的列表重写要能被**登出清理**作废(否则它可能在
   * 整棵目录被删之后把 session-list.json 重建出来),但**不能**被另一个并发的 `clearDevice`
   * 作废 —— 后者也是清理动作,两者应当依次落地而不是互相顶掉(否则先清的那台设备会被
   * 后清的那次写回列表)。所以清理之间用这个更粗的闸,与 `generation` 分开。
   */
  let purgeAllEpoch = 0;

  /**
   * 正在进行中的 `clearAll` 数量。光靠 `purgeAllEpoch` 快照不够:登出清理已经自增代际、
   * 但还在 `await` 递归删除时,**晚到的** `clearDevice` 会快照到新代际(于是不被作废),
   * 它读旧列表、在删除完成之后原子写回,就把上一个 owner 的会话元数据重建出来了
   * (review: codex P1 —— clear IPC 刻意在 capability 掉下去之后仍可调用,这个时序真实可达)。
   * 屏障期间 clearDevice 一律不写列表:整份缓存反正马上就没了。
   */
  let purgeAllInFlight = 0;

  /**
   * 同一文件的写入串行化(文件路径 → 尾部 promise)。
   *
   * 不串行化会让指纹失真:两次并发写入在 `await` 处交错时,最后落盘的内容与最后登记的
   * 指纹可能来自不同的那一次,于是真正较新的快照之后会被 `unchanged` 跳过,冷启动一直
   * 显示旧消息(review: greptile P1)。串成链后「落盘 → 登记指纹」始终成对且有序。
   */
  const writeChains = new Map<string, Promise<unknown>>();

  /**
   * 列表快照的实际写入体。**不自己加锁** —— 由调用方在 `serializeWrite(sessionListPath(), …)`
   * 内调用,这样 `clearDevice` 能把「读快照 → 去掉自己 → 写回」整段放进同一条链里(否则两台
   * 设备同时被收掉时,两次 read-modify-write 各自读到同一份旧快照、各自写「除我之外的全部」,
   * 后写的那次把另一台已删设备恢复回来,review: codex P1)。
   *
   * 返回值让调用方能**核实**结果:隐私清理必须知道自己到底写成没写成。
   *
   * `guard` 决定「什么能作废这笔写入」,两种语义不可混:
   *  - `write`:普通镜像回写,任何清理(`generation`)都作废它 —— 它携带的是清理前的数据。
   *  - `purge`:清理自己的列表重写,只有 **clearAll** 能作废(`purgeAllEpoch` + 进行中屏障)。
   *    用 `generation` 守它是错的:另一个并发 `clearDevice` 自增 generation 后,这笔写会在
   *    `ensureDir` / 原子写前后被判成 stale(甚至写完又删掉),而那台设备的元数据就此留下
   *    —— 而且那个 outcome 既没被计入待重试也没人重试(review: codex P1)。
   */
  /**
   * 正在被 clearDevice 清理的设备(可重入计数)。与 `purgeAllInFlight` 同理:一笔在
   * 「generation 已自增、枚举已跑完、清理还没结束」之间发起的写入会捕获到新代际、两道
   * 检查都放行,于是它的 rename 会把刚被扫掉的正文重建出来 —— 多窗口下这是真实可达的
   * (一个窗口在清被撤销设备,另一个窗口提交它已经拉到的页)(review: codex P1)。
   */
  const clearingDevices = new Map<string, number>();

  function isClearingDevice(deviceId: string): boolean {
    return (clearingDevices.get(deviceId.trim()) ?? 0) > 0;
  }

  type WriteGuard =
    | { kind: 'write'; epoch: number; deviceId?: string }
    | { kind: 'purge'; allEpoch: number };

  /**
   * 列表快照写入结果。`purge-failed` 带上具体卡住的路径(可能是 session-list.json 本身,
   * 也可能是落位失败后删不掉的 `.tmp` —— 后者里同样是完整快照明文)。
   */
  type SessionListWriteResult =
    | {
        outcome: 'written' | 'removed' | 'skipped' | 'stale' | 'failed' | 'invalidated';
        stuck?: undefined;
      }
    | { outcome: 'purge-failed'; stuck: string };

  /** 这笔写入此刻是否已被作废。 */
  function isStale(guard: WriteGuard): boolean {
    // 普通写入除了比代际,还必须在**整个** clearAll 期间一律作废:一笔在
    // 「generation 已自增、递归删除尚未完成」之间发起的写入会捕获到新代际、两道 epoch 检查
    // 都放行,于是它的原子 rename 会在 clearAll 返回之后把旧账号的目录重建出来 —— 而 owner
    // 要等 teardown 完成才切换,那份明文就这样越过了账号边界(review: codex P1)。
    if (guard.kind === 'purge') {
      return guard.allEpoch !== purgeAllEpoch || purgeAllInFlight > 0;
    }
    if (guard.epoch !== generation || purgeAllInFlight > 0) return true;
    // 逐设备清理进行中:该设备自己的写入作废;列表快照(不带 deviceId)在**任何**
    // clearDevice 进行中都作废 —— 它是整份快照,可能把正在被清掉的设备又写回去。
    return guard.deviceId === undefined
      ? clearingDevices.size > 0
      : isClearingDevice(guard.deviceId);
  }

  /** 作废盘上的列表快照(写不了新内容时用):删掉即可,删不掉则登记重试。 */
  async function invalidateSessionList(file: string): Promise<SessionListWriteResult> {
    lastWritten.delete(file);
    try {
      await fsp.rm(file, { recursive: true, force: true });
    } catch {
      if (await pathMaybeExists(file)) return { outcome: 'purge-failed', stuck: file };
    }
    return { outcome: 'invalidated' };
  }

  async function writeSessionListLocked(
    devices: readonly unknown[],
    guard: WriteGuard,
    // 调用方在发起时快照的路径:owner 可能在写入期间换掉,内部再 resolve 会写 / 报到
    // 另一个账号的目录去(review: codex P1)。
    fileOverride?: string,
  ): Promise<SessionListWriteResult> {
    const file = fileOverride ?? sessionListPath();
    // 跨进程互斥由调用方的 withCacheLock 负责;这里只管本进程的代际 / 清理屏障。
    if (isStale(guard)) return { outcome: 'stale' };
    for (const perDeviceLimit of SESSION_LIST_SHRINK_STEPS) {
      const normalized = normalizeDeviceSessions(devices, perDeviceLimit);
      if (normalized.length === 0) {
        lastWritten.delete(file);
        try {
          await fsp.rm(file, { force: true });
          return { outcome: 'removed' };
        } catch {
          // 删除类失败与写入类失败要分开:前者意味着「本该消失的元数据还在盘上」,得进
          // purge 队列;后者只是缓存没更新,重试删除反而会删掉正常数据。
          return { outcome: 'purge-failed', stuck: file };
        }
      }
      const payload: StoredSessionList = { version: 1, updatedAt: Date.now(), devices: normalized };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_LIST_BYTES) continue;
      // 指纹只算 devices,不含 updatedAt。10 秒一轮的 anti-entropy 绝大多数时候内容没变,
      // 这里直接跳过落盘。
      const body = JSON.stringify(normalized);
      if (unchanged(file, body)) return { outcome: 'skipped' };
      await ensureDir(path.dirname(file));
      if (isStale(guard)) return { outcome: 'stale' };
      const written = await writeFileAtomic(file, serialized);
      if (!written.ok) {
        // 同 writeMessages:内容已变而新快照没落位,旧快照就是过期的(可能还带着刚被
        // 归档 / 删除的会话)。保留它会在下次离线冷启动把那条会话画回侧边栏,而"内容没变"
        // 的后续对账不会再通知订阅者、也就不会再试一次 —— 所以**作废**旧快照
        // (review: codex P1)。作废失败才登记重试。
        lastWritten.delete(file);
        try {
          await fsp.rm(file, { recursive: true, force: true });
        } catch {
          if (await pathMaybeExists(file)) return { outcome: 'purge-failed', stuck: file };
        }
        return written.leftoverTmp
          ? { outcome: 'purge-failed', stuck: written.leftoverTmp }
          : { outcome: 'invalidated' };
      }
      if (isStale(guard)) {
        // 同 writeMessages:清理已经过去了,这笔补偿删除失败就等于「被撤销 / 上一个账号的
        // 设备元数据留在盘上,而且没人知道」。返回 purge-failed 让调用方登记重试。
        lastWritten.delete(file);
        try {
          await fsp.rm(file, { force: true });
        } catch {
          return { outcome: 'purge-failed', stuck: file };
        }
        return { outcome: 'stale' };
      }
      rememberWritten(file, body);
      return { outcome: 'written' };
    }
    // 缩到最小档仍超上限:新快照写不下。旧快照此刻可能还带着刚被归档 / 删除的会话,而同一份
    // 超限状态每次对账都会走到这里 —— 永远不会有第二次机会更新它。所以**作废**旧快照,
    // 除非它的内容与最小档快照一致(那就是同一份,没什么可作废的)(review: codex P1)。
    const smallestBody = JSON.stringify(
      normalizeDeviceSessions(devices, SESSION_LIST_SHRINK_STEPS[SESSION_LIST_SHRINK_STEPS.length - 1]),
    );
    if (unchanged(file, smallestBody)) return { outcome: 'skipped' };
    lastWritten.delete(file);
    try {
      await fsp.rm(file, { recursive: true, force: true });
    } catch {
      if (await pathMaybeExists(file)) return { outcome: 'purge-failed', stuck: file };
    }
    return { outcome: 'invalidated' };
  }

  function serializeWrite<T>(file: string, task: () => Promise<T>): Promise<T> {
    const prev = writeChains.get(file) ?? Promise.resolve();
    // 前一笔失败不应阻断后一笔:两个分支都接到 task 上。
    const next = prev.then(task, task);
    writeChains.set(file, next);
    void next
      .catch(() => undefined)
      .finally(() => {
        if (writeChains.get(file) === next) writeChains.delete(file);
      });
    return next;
  }


  /**
   * 缓存根下的跨进程锁。`clearingDevices` 与 `serializeWrite` 都只在**本进程**内有效,而 dev
   * 实例与打包实例可以共用同一个 userData —— 那时:
   *  - B 的写入看不到 A 正在清某台被撤销设备,它的 rename 落在 A 的扫描之后就把明文重建了;
   *  - 两个进程各自清不同设备时,会各读同一份旧 session-list、各写"除我之外的全部",
   *    后写的那次把对方刚移除的设备恢复回来 —— 两边都报成功(review: codex P1)。
   *
   * 所以落盘写入与清理统一在这把锁里做(实现见 crossProcessLock:pid + 心跳 + 存活判定,
   * 只接管确实死掉的持有者)。拿不到锁时:
   *  - **写入**直接跳过(缓存是纯优化,少写一次远好过在别人清理途中写回明文);
   *  - **清理**照常进行(删除是安全方向),并保留清理收尾的二次扫描兜底。
   */
  /**
   * 「这台设备被清过几次」——跨进程可见的**作废计数器**。
   *
   * 跨进程锁只保证清理与提交不重叠,挡不住这一种:B 的写入**在清理之前**就取到了内容,却在
   * 清理结束、锁释放之后才提交 —— 那份内容是被撤销设备的旧正文,照写就等于把它重建出来
   * (review: codex P1)。
   *
   * 写入侧在**发起时**读一次计数,提交前(锁内)再读一次:变了就说明"我手里的内容属于清理
   * 之前",丢弃这次写。用计数而不是时间戳:毫秒精度下"清理在同一毫秒内跑完"时时间戳挡不住,
   * 计数没有精度问题。读不出来时保守跳过写(缓存是纯优化,少写一次无所谓)。
   */
  const CLEARED_DIR = 'cleared';
  /** 列表快照是整份写,任何设备被清都可能让它变陈旧 → 用一个共享计数器。 */
  const CLEARED_ANY = '_any';

  function clearedMarkPath(root: string, key: string): string {
    return path.join(controlDir(root), CLEARED_DIR, key);
  }

  function deviceClearKey(id: string): string {
    const trimmed = id.trim();
    return `${safeSegment(trimmed)}-${shortHash(trimmed)}`;
  }

  /** 读作废计数:缺文件 = 0(从未清过);读不出来 / 不是数字 = null(调用方保守处理)。 */
  async function readClearCounter(root: string, key: string): Promise<number | null> {
    try {
      const raw = await fsp.readFile(clearedMarkPath(root, key), 'utf8');
      const value = Number.parseInt(raw, 10);
      return Number.isFinite(value) ? value : null;
    } catch (err) {
      const code = errnoCode(err);
      if (code === 'ENOENT' || code === 'ENOTDIR') return 0;
      return null;
    }
  }

  /**
   * 自增作废计数。**失败会抛** —— 这是跨进程唯一的持久屏障:另一个实例可能已经读到旧计数
   * 并在锁上等着,自增落不下去却报"清干净了"的话,它会在清理之后把被撤销设备 / 上一个账号的
   * 正文重建出来(review: codex P1)。落不下去就让调用方把这次清理当成"没清完",登记重试。
   */
  async function bumpClearedCounter(root: string, key: string): Promise<void> {
    const file = clearedMarkPath(root, key);
    const current = (await readClearCounter(root, key)) ?? 0;
    await ensureDir(path.dirname(file));
    await fsp.writeFile(file, String(current + 1), 'utf8');
  }

  async function bumpClearCounters(root: string, id: string): Promise<void> {
    for (const key of [deviceClearKey(id), CLEARED_ANY]) await bumpClearedCounter(root, key);
  }

  /** 自 `before` 之后计数是否变过(含读不出来:保守判"变过")。 */
  async function clearedSince(root: string, key: string, before: number | null): Promise<boolean> {
    const now = await readClearCounter(root, key);
    return before === null || now === null || now !== before;
  }

  /** 控制面目录:`<cache-root>.control/`(与缓存根同级,clearAll 不会删它)。 */
  function controlDir(root: string): string {
    return `${root}${CACHE_CONTROL_SUFFIX}`;
  }

  function cacheLockPath(root: string): string {
    return path.join(controlDir(root), CACHE_LOCK_FILE);
  }

  async function withCacheLock<T>(
    root: string,
    task: (held: boolean) => Promise<T>,
  ): Promise<T> {
    await ensureDir(controlDir(root)).catch(() => undefined);
    return withCrossProcessLock(cacheLockPath(root), { label: 'mirror-cache' }, task);
  }

  /** clearDevice 的实际清理体(登记 in-flight 与代际自增由调用方负责)。 */
  async function clearDeviceLocked(id: string): Promise<void> {
    const rootAtStart = resolveRoot();
    // 整段清理拿着跨进程锁跑:别的实例的写入会在锁上等(等不到就跳过写),不会把刚扫掉的
    // 明文重建出来;两个实例并发清不同设备时,session-list 的「读 → 去掉我 → 写回」也因此
    // 串行化,不再互相恢复(review: codex P1)。拿不到锁也照常清(删除是安全方向),
    // 收尾的二次扫描兜住"扫完才冒出来"的文件。
    return withCacheLock(rootAtStart, async (lockHeld) => {
      if (!lockHeld) {
        log.warn(`mirror cache: clearing ${id.slice(0, 8)} without cross-process lock`);
      }
      const epochAll = purgeAllEpoch;
      const dir = path.join(rootAtStart, MESSAGES_DIR);
      const prefix = `${safeSegment(id)}-${shortHash(id)}-`;

      const stuck: string[] = [];

      /** 扫一轮该设备的消息文件(含 .tmp 残留)。返回删不掉的路径。 */
      const sweepMessages = async (): Promise<string[]> => {
        const left: string[] = [];
        const listed = await listMessageFileNames(dir);
        if (listed.unreadable) {
          // 数不出来 ≠ 里面没有。把目录本身计入待重试,删除留给下一次。
          left.push(dir);
          return left;
        }
        await Promise.all(
          listed.names
            .filter((name) => name.startsWith(prefix))
            .map(async (name) => {
              const file = path.join(dir, name);
              // 指纹一起清:文件删了却留着指纹,下次写同样内容会被去重跳过 → 文件回不来。
              lastWritten.delete(file);
              try {
                await fsp.rm(file, { force: true });
              } catch {
                left.push(file);
              }
            }),
        );
        return left;
      };

      // 枚举必须 fail-closed(见 listMessageFileNames):messages/ 因 EACCES / EPERM / 锁而
      // 枚举失败时不能报成"清干净了",否则 IPC 也不会登记重试。
      stuck.push(...(await sweepMessages()));

      // 「读快照 → 去掉这台设备 → 写回」整段进同一条串行化链:两台设备同时被收掉时,
      // 各自读同一份旧快照再各写「除我之外的全部」,后写的那次会把另一台恢复回来
      // (review: codex P1)。链内不能再调公开的 writeSessionList(同链嵌套会自锁),
      // 因此直接用 writeSessionListLocked。
      const listFile = path.join(rootAtStart, SESSION_LIST_FILE);
      // 没拿到跨进程锁时**不做**「读 → 去掉我 → 写回」:另一个实例可能同时在删 / 改这份快照,
      // 我们的写回会把它刚清掉的设备恢复回来。降级只做安全方向 —— 直接删掉整份快照
      // (它是纯缓存,下一次成功的对账会重建)(review: codex P1)。
      const outcome = await serializeWrite(listFile, async () => {
        if (!lockHeld) return invalidateSessionList(listFile);
        // 只有 clearAll 能作废这段(它会把整棵目录删掉,这里不该再把列表写回来);
        // 另一个并发的 clearDevice 不作废它 —— 两者依次落地才对。屏障还挡住「clearAll 已开始、
        // 尚未删完」的窗口:那时晚到的 clearDevice 会快照到新代际,若只比代际就拦不住它在
        // 删除完成之后把列表写回去(review: codex P1)。
        const guard = { kind: 'purge', allEpoch: epochAll } as const;
        if (isStale(guard)) return { outcome: 'stale' } as SessionListWriteResult;
        const parsed = await readJson(listFile);
        const devices = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : [];
        const others = normalizeDeviceSessions(devices).filter((device) => device.deviceId !== id);
        return writeSessionListLocked(others, guard, listFile);
      });
      // 根目录下的 `session-list.json.<hex>.tmp`:进程死在 writeFile 与 rename 之间时,
      // 那里是**全部设备**的会话元数据。逐设备清理原先只扫 messages/ 下的 tmp,于是这份
      // 崩溃残留要等到整账号清理才消失(review: codex P1)。它是过期快照、对谁都没用,
      // 直接删掉;枚举失败则把根目录计入待重试(fail-closed)。
      const rootTmp = await listRootTmpFiles(rootAtStart);
      if (rootTmp.unreadable) stuck.push(rootAtStart);
      for (const file of rootTmp.files) {
        try {
          await fsp.rm(file, { force: true });
        } catch {
          stuck.push(file);
        }
      }

      // 二次扫描:降级(没拿到锁)时另一个实例的写入仍可能在首轮扫描之后落位;
      // 再扫一遍把这种"扫完才冒出来"的文件收掉(review: codex P1)。
      stuck.push(...(await sweepMessages()));

      // 自增作废计数:发起时读到旧值的写入(可能握着清理前的内容)提交时会被挡掉。
      // 落不下去就不能报"清干净了" —— 把**整个缓存根**计入待重试:purge 队列随后会把它整棵
      // 删掉(超集、纯缓存,安全),这比"以为清完了、别人却把明文写回来"好得多。
      try {
        await bumpClearCounters(rootAtStart, id);
      } catch (err) {
        log.error(`mirror cache: failed to persist clear barrier for ${id.slice(0, 8)}`, err);
        stuck.push(rootAtStart);
      }
      // 本进程内再自增一次代际:清理**结束**时作废所有更早发起的写入。时间戳标记是跨进程
      // 手段,毫秒精度下"清理在同一毫秒内跑完"时它挡不住(测试与小目录下常见);代际比对
      // 没有精度问题,两者互补(review: codex P1)。
      generation += 1;

      // 列表快照重写失败(Windows 上被占用 / owner 目录只读)同样要能被重试 —— 否则消息文件
      // 删掉了、会话元数据还在盘上,下次冷启动照样把这台被撤销的设备画回侧边栏(review: codex P1)。
      if (outcome.outcome === 'failed') stuck.push(listFile);
      else if (outcome.outcome === 'purge-failed') stuck.push(outcome.stuck);

      // 删不掉 / 数不出来的东西都是隐私问题:被撤销的对端正文会留在盘上直到本账号生命周期
      // 结束。抛出来让调用方登记重试,而不是把失败咽下去。
      // 去重:两轮扫描会把同一个删不掉的文件报两次。
      const remaining = [...new Set(stuck)];
      if (remaining.length > 0) throw new MirrorCachePurgeError(rootAtStart, remaining, null);
    });
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
      // root 在**发起时**快照,不能在出错时再 resolve:owner 会在进程生命周期内变(登出 /
      // 切账号),那时 resolveRoot() 指向新账号,而 `file` 还在旧账号目录里 —— 用新 root 去
      // 登记重试会被 purge 队列当成「路径不在 root 之内」直接拒掉,旧账号的明文就此没有任何
      // 持久重试记录(review: codex P1)。
      const rootAtStart = resolveRoot();
      // 发起时的作废计数:提交前再读一次比对,挡住"内容取自清理之前、提交发生在清理之后"。
      const clearCounterAtStart = await readClearCounter(rootAtStart, deviceClearKey(deviceId));
      const accountCounterAtStart = await readClearCounter(rootAtStart, CLEARED_ACCOUNT);
      const dir = path.join(rootAtStart, MESSAGES_DIR);
      const file = path.join(dir, messageFileName(deviceId, sessionId));
      const normalized = normalizeMessages(messages);
      // 空列表 = 清掉这条缓存(被控端 /clear、rewind 或删完最后一条时,残留会在
      // 下次冷开 hydrate 出已经不存在的正文)。
      if (normalized.length === 0) {
        return serializeWrite(file, async () => {
          lastWritten.delete(file);
          // 同名 `.tmp` 兄弟一起删:上一次落位崩在 writeFile 与 rename 之间时,那里是
          // 完整明文,而 /clear、rewind 正是"这些消息必须消失"的场合(review: copilot)。
          const tmpStuck = await removeTmpSiblings(dir, path.basename(file));
          try {
            // recursive:目标位置若因异常变成目录,非递归 rm 会永远失败。
            await fsp.rm(file, { recursive: true, force: true });
            if (tmpStuck.length > 0) {
              throw new MirrorCachePurgeError(rootAtStart, tmpStuck, null);
            }
          } catch (err) {
            if (err instanceof MirrorCachePurgeError) throw err;
            // 这条路径服务的是被控端 /clear、rewind、会话删除 —— 权威侧已经确认"这个会话没有
            // 可见消息了",本机却还留着旧正文,下次离线冷启动照样 hydrate 出来。删不掉要能被
            // 重试,不能咽下去(review: codex P1)。
            throw new MirrorCachePurgeError(rootAtStart, [file, ...tmpStuck], err);
          }
        });
      }
      const body = JSON.stringify(normalized);
      const payload: StoredMessages = { version: 1, updatedAt: Date.now(), messages: normalized };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MESSAGE_FILE_BYTES) {
        // 单会话超限:新页写不下 —— 但旧正本此刻可能是 rewind / 删消息**之前**的窗口,
        // 而同一个超限页每次对账都会走到这里,永远不会有第二次机会更新它。所以**作废**
        // 旧缓存,而不是留一份会骗人的旧页(review: codex P1)。
        return serializeWrite(file, async () => {
          if (unchanged(file, body)) return; // 内容没变(旧页就是它)→ 无需作废
          lastWritten.delete(file);
          try {
            await fsp.rm(file, { recursive: true, force: true });
          } catch {
            if (await pathMaybeExists(file)) {
              throw new MirrorCachePurgeError(rootAtStart, [file], null);
            }
          }
        });
      }
      // 代际必须在**请求发起时**(排队之前)捕获,不能等任务开始执行才读:
      // 「发起 → 排队 → 清理自增 → 任务开始」这个序列里,任务读到的是清理后的新代际,
      // 于是携带着清理前旧数据的这笔写入会被当成新写入放行(review: codex P1)。
      const epoch = generation;
      // 落盘与指纹登记必须成对且有序 → 同一文件的写入串成链(见 serializeWrite)。
      const writeGuard: WriteGuard = { kind: 'write', epoch, deviceId };
      return serializeWrite(file, async () =>
        withCacheLock(rootAtStart, async (held) => {
        // 拿不到跨进程锁 → 跳过这次写(别在另一个实例清理途中把明文写回去)。
        if (!held) return;
        if (isStale(writeGuard)) return;
        // 清理在我取到内容之后完成过 → 我手里的是被清掉的旧正文,丢弃。
        if (await clearedSince(rootAtStart, deviceClearKey(deviceId), clearCounterAtStart)) return;
        // 账号级清理(登出 / 切账号)同理:它删的是整棵缓存根,而计数器在根之外。
        if (await clearedSince(rootAtStart, CLEARED_ACCOUNT, accountCounterAtStart)) return;
        // 指纹只算消息体,不含 payload 的 updatedAt —— 否则每次都"变了",去重永不命中。
        // 在链内判等:排队期间前一笔可能刚写下同样内容。
        if (unchanged(file, body)) return;
        await ensureDir(dir);
        if (isStale(writeGuard)) return;
        const written = await writeFileAtomic(file, serialized);
        if (!written.ok) {
          // 走到这里说明权威内容**已经变了**(上面 unchanged 已挡掉没变的情况),而新内容
          // 没能落位。旧正本此刻是过期窗口:rewind / 删消息之前的正文。留着它,下次离线冷
          // 启动就会把已经不存在的消息 hydrate 出来 —— 所以宁可**作废**这条缓存,而不是保留
          // 一份会骗人的旧页(缓存是纯优化,缺一条只是少一次首屏加速)(review: codex P1)。
          lastWritten.delete(file);
          const stuck: string[] = [];
          try {
            // recursive:落位失败的成因也可能让目标位置变成一个目录(枚举 / 清理都按
            // 「这是本缓存自己的路径」处理,递归不会越界)。
            await fsp.rm(file, { recursive: true, force: true });
          } catch {
            // 只有旧正本**确实还在**才算残留:messages/ 位置被占成普通文件这类情况下
            // rm 也会失败,但盘上本来就没有那份缓存(同 writeFileAtomic 的 tmp 判定)。
            if (await pathMaybeExists(file)) stuck.push(file);
          }
          if (written.leftoverTmp) stuck.push(written.leftoverTmp);
          // 作废也失败 → 登记重试(明文留在盘上是隐私问题,不能咽下去)。
          if (stuck.length > 0) throw new MirrorCachePurgeError(rootAtStart, stuck, null);
          return;
        }
        if (isStale(writeGuard)) {
          // 隐私清理期间落的盘:立刻收回,否则刚被清空的目录里会留下本该消失的聊天内容。
          // 这笔补偿删除失败(Windows 文件锁 / 权限)时不能咽下去:清理侧已经枚举并删完了,
          // 它不知道这个文件又冒出来,于是既没人重试、明文也留在了隐私边界之后
          // (review: codex P1)。抛出去让 IPC 登记进 purge 队列。
          lastWritten.delete(file);
          try {
            await fsp.rm(file, { recursive: true, force: true });
          } catch (err) {
            throw new MirrorCachePurgeError(rootAtStart, [file], err);
          }
          return;
        }
        // 指纹只在真正落盘之后登记(写失败留指纹 → 同内容重试被跳过 → 缓存永久缺失)。
        rememberWritten(file, body);
        await evictMessagesIfNeeded(dir, lastWritten);
        }),
      );
    },

    async readSessionList() {
      const parsed = await readJson(sessionListPath());
      const devices = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : [];
      return normalizeDeviceSessions(devices);
    },

    async writeSessionList(devices) {
      // 同 writeMessages:代际在请求发起时捕获(排队期间的清理必须能作废这笔)。
      const epoch = generation;
      // 同 writeMessages:root 与发起时刻都在发起时快照。
      const rootAtStart = resolveRoot();
      const clearCounterAtStart = await readClearCounter(rootAtStart, CLEARED_ANY);
      const accountCounterAtStart = await readClearCounter(rootAtStart, CLEARED_ACCOUNT);
      // 与 writeMessages 同款:同一文件的写入串成链,保证「落盘 → 登记指纹」成对有序。
      const listFile = path.join(rootAtStart, SESSION_LIST_FILE);
      const outcome = await serializeWrite(listFile, () =>
        withCacheLock(rootAtStart, async (held) =>
          // 拿不到跨进程锁 → 跳过(整份快照写在别人清理途中落地会把被清设备写回来)。
          // 空快照 = **删除**,删除是安全方向:即使拿不到锁 / 期间发生过清理也照做。
          normalizeDeviceSessions(devices).length === 0 ||
          (held &&
            !(await clearedSince(rootAtStart, CLEARED_ANY, clearCounterAtStart)) &&
            !(await clearedSince(rootAtStart, CLEARED_ACCOUNT, accountCounterAtStart)))
            ? writeSessionListLocked(devices, { kind: 'write', epoch }, listFile)
            : // 写不了内容时不能"什么都不做":盘上那份可能已经陈旧(它可能还带着刚被清掉的
              // 设备)。按与"落位失败"同一口径**作废**它;作废失败才登记重试。
              invalidateSessionList(listFile),
        ),
      );
      // 只有「删除失败」才抛(见 purge-failed):写入失败保留旧快照即可,不该让上层去
      // 重试删除一份仍然有效的缓存。
      if (outcome.outcome === 'purge-failed') {
        throw new MirrorCachePurgeError(rootAtStart, [outcome.stuck], null);
      }
    },

    /**
     * 某设备离场(撤销访问 / 关闭被控 / 本机禁用控制)。同样是隐私路径:
     * 先自增代际作废在途写入 —— 不然那笔写入的原子 rename 会在删除之后完成,把刚被清掉的
     * 设备正文或列表条目重建出来,直到下一次清理才消失(review: codex P1)。
     */
    async clearDevice(deviceId) {
      const id = deviceId.trim();
      if (!id) return;
      generation += 1;
      clearingDevices.set(id, (clearingDevices.get(id) ?? 0) + 1);
      try {
        return await clearDeviceLocked(id);
      } finally {
        const left = (clearingDevices.get(id) ?? 1) - 1;
        if (left > 0) clearingDevices.set(id, left);
        else clearingDevices.delete(id);
      }
    },

    /**
     * 隐私路径(登出 / 切账号 / 会话失效)。与其它方法不同:**失败会抛**。
     *
     * 吞掉失败等于骗调用方「盘上已经干净了」——`teardownAuthAccountBoundary` 会照常推进
     * 账号边界,而上一个账号的明文聊天缓存无声地留在盘上,既没日志也没重试机会
     * (review: codex P1)。Windows 文件锁、权限问题、并发写都可能让 rm 失败,必须让它冒泡。
     *
     * 自增代际同时作废所有在途写入(见 writeMessages / writeSessionList 的 epoch 比对):
     * 清理与 renderer 的 fire-and-forget 写盘是并发的,不设这道闸就可能「先清后写」,
     * 把刚删掉的内容又写回来。
     */
    async clearAll() {
      generation += 1;
      purgeAllEpoch += 1;
      // 屏障在整个删除期间都举着:期间任何 clearDevice 都不许写列表(见 purgeAllInFlight)。
      purgeAllInFlight += 1;
      lastWritten.clear();
      const root = resolveRoot();
      // 同 clearDevice:整段拿着跨进程锁跑,别的实例的写入会在锁上等(等不到就跳过写),
      // 不会在删除途中把明文写回来。拿不到锁也照删(删除是安全方向)。
      return withCacheLock(root, async (lockHeld) => {
      if (!lockHeld) log.warn('mirror cache: clearAll without cross-process lock');
      // 账号级作废计数器住在缓存根之外,先自增:发起时读到旧值的写入提交时会被挡掉,
      // 即使它们排在整棵目录删除之后(review: codex P1)。落不下去同样不能当成清理成功 ——
      // 抛出去让账号边界登记整根重试(见 teardownAuthAccountBoundary)。
      try {
        await bumpClearedCounter(root, CLEARED_ACCOUNT);
      } catch (err) {
        purgeAllInFlight -= 1; // 下面的 finally 不会执行(还没进 try)
        throw new MirrorCachePurgeError(root, [root], err);
      }
      try {
        await fsp.rm(root, { recursive: true, force: true });
        return;
      } catch (err) {
        // 整棵删不掉(Windows 文件锁 / 权限 / 并发写)时**不要就此放弃**:先逐个删内容,
        // 把「还剩什么」查清楚 —— 目录空壳留着无所谓,聊天正文留着才是隐私问题。
        const remaining = await purgeContents(root);
        if (remaining.length === 0) {
          log.debug(`mirror cache purged but root dir remains: ${root}`, err);
          return;
        }
        throw new MirrorCachePurgeError(root, remaining, err);
      } finally {
        purgeAllInFlight -= 1;
      }
      });
    },
  };
}

/**
 * messages/ 超文件数或总字节上限时按 mtime 逐出最旧(缓存越旧越不值钱)。
 * 被逐出的文件必须同步删掉写入指纹(`lastWritten`),否则同内容的下一次写入会被去重跳过,
 * 该会话的缓存在本进程余生里再也建不回来(review: greptile)。
 */
async function evictMessagesIfNeeded(
  dir: string,
  lastWritten: Map<string, string>,
): Promise<void> {
  // 先扫掉陈旧的 `.tmp`:进程在 writeFile 与 rename 之间被杀会留下完整明文,而它既不进
  // 体积预算也不会被下面的 LRU 逐出(review: codex P1)。只删够老的,免得动到正在写的那笔。
  await sweepStaleTmpFiles(dir);
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
    const file = path.join(dir, entry.name);
    lastWritten.delete(file);
    await fsp.rm(file, { force: true }).catch(() => undefined);
    count -= 1;
    totalBytes -= entry.size;
  }
}

/**
 * 缓存根目录下的 `.tmp` 残留(只有 session-list 的原子写会产生)。**fail-closed**:
 * 枚举失败要让调用方知道(和 listMessageFileNames 同口径),不能当成"里面没有"。
 */
async function listRootTmpFiles(root: string): Promise<{ files: string[]; unreadable: boolean }> {
  try {
    const entries = await fsp.readdir(root, { withFileTypes: true });
    return {
      files: entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
        .map((entry) => path.join(root, entry.name)),
      unreadable: false,
    };
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { files: [], unreadable: false };
    return { files: [], unreadable: true };
  }
}

/**
 * 删掉某个缓存文件的 `.tmp` 兄弟(`<file>.<hex>.tmp`)。返回仍然删不掉的路径。
 * 那些 tmp 里是完整明文,`/clear` / rewind / 逐设备清理都必须把它们一起带走。
 */
async function removeTmpSiblings(dir: string, baseName: string): Promise<string[]> {
  const stuck: string[] = [];
  let names: string[];
  try {
    names = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter(
        (entry) =>
          entry.isFile() && entry.name.startsWith(`${baseName}.`) && entry.name.endsWith('.tmp'),
      )
      .map((entry) => entry.name);
  } catch (err) {
    // 数不出来 ≠ 里面没有:只有 ENOENT 能推出"真的没有"。
    if (errnoCode(err) !== 'ENOENT') stuck.push(dir);
    return stuck;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      await fsp.rm(file, { force: true });
    } catch {
      stuck.push(file);
    }
  }
  return stuck;
}

/**
 * 「这个路径可能还在盘上」——**fail-closed**:只有 ENOENT 能推出"真的没了"。
 * EACCES / EPERM 下 stat 也会失败,当成"不存在"就会让作废失败的那份明文既不进 purge 队列
 * 也没人重试(review: codex P1)。
 */
async function pathMaybeExists(file: string): Promise<boolean> {
  try {
    await fsp.stat(file);
    return true;
  } catch (err) {
    const code = errnoCode(err);
    // ENOENT / ENOTDIR 都能证明"这个路径上没有文件"(后者:路径里某一段根本不是目录,
    // 比如 messages/ 位置被占成普通文件 —— 那时 tmp 也从未被创建)。其余(EACCES /
    // EPERM / EIO…)读不出来,一律按"可能还在"处理。
    return code !== 'ENOENT' && code !== 'ENOTDIR';
  }
}

/** 超过这个年龄的 `.tmp` 一定不是在写的那笔(单次写盘是毫秒级),可以安全清掉。 */
const STALE_TMP_MS = 60_000;

async function sweepStaleTmpFiles(dir: string): Promise<void> {
  let entries: string[];
  try {
    entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.tmp'))
      .map((entry) => entry.name);
  } catch {
    return; // 纯优化路径:枚举不了就算了(隐私清理走 fail-closed 的 listMessageFileNames)
  }
  const now = Date.now();
  for (const name of entries) {
    const file = path.join(dir, name);
    try {
      const stat = await fsp.stat(file);
      if (now - stat.mtimeMs < STALE_TMP_MS) continue;
      await fsp.rm(file, { force: true });
    } catch {
      // 竞态 / 权限:留给下一次(逐设备清理与 clearAll 都会再看一遍)
    }
  }
}

/**
 * 枚举 messages/ 下的缓存文件,**区分「空」与「数不出来」**。
 *
 * `listFiles` 是 fail-open 的(读不了就当空),那对纯优化路径(LRU 逐出)没问题;但隐私清理
 * 不能用它 —— 目录因权限 / 锁枚举失败时会被当成「里面没东西」,于是一个文件都不删却报成功。
 * 只有 `ENOENT` 能推出「真的没有」。
 */
async function listMessageFileNames(
  dir: string,
): Promise<{ names: string[]; unreadable: boolean }> {
  try {
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    return {
      // `.tmp` 也算:落位失败或进程在 writeFile 与 rename 之间被杀时,残留的
      // `<file>.<hex>.tmp` 里是完整明文。只认 `.json` 的话逐设备清理看不见它,
      // 被撤销对端的正文就无限期留在盘上(review: codex P1)。名字前缀不变,
      // 所以调用方的 prefix 过滤照样命中。
      names: entries
        .filter(
          (entry) => entry.isFile() && (entry.name.endsWith('.json') || entry.name.endsWith('.tmp')),
        )
        .map((entry) => entry.name),
      unreadable: false,
    };
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return { names: [], unreadable: false };
    return { names: [], unreadable: true };
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
/**
 * 原子落位。失败时返回 `leftoverTmp` —— 那个 `.tmp` 里是**完整的明文**(消息页或列表快照),
 * 清不掉就必须让调用方登记重试:它不以 `.json` 结尾,逐设备清理的枚举本来看不见它
 * (review: codex P1)。
 */
async function writeFileAtomic(
  file: string,
  content: string,
): Promise<{ ok: boolean; leftoverTmp?: string }> {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, content, 'utf8');
    await fsp.rename(tmp, file);
    return { ok: true };
  } catch (err) {
    log.debug(`mirror cache write failed: ${file}`, err);
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    // 只有「tmp 真的没了」才不算残留(ENOENT):tmp 根本没建出来时(比如 messages/ 位置被
    // 占成普通文件,writeFile 直接 ENOTDIR)确实没有明文;而 EACCES / EPERM 这类读不出来的
    // 情况一律按"可能还在"处理(fail-closed,见 pathMaybeExists)。
    const leftover = await pathMaybeExists(tmp);
    return leftover ? { ok: false, leftoverTmp: tmp } : { ok: false };
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
  purgeContents,
  sweepStaleTmpFiles,
  listRootTmpFiles,
  staleTmpMs: STALE_TMP_MS,
};
