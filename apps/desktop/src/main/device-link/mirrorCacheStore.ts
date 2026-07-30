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
  type WriteGuard = { kind: 'write'; epoch: number } | { kind: 'purge'; allEpoch: number };

  /** 这笔写入此刻是否已被作废。 */
  function isStale(guard: WriteGuard): boolean {
    return guard.kind === 'write'
      ? guard.epoch !== generation
      : guard.allEpoch !== purgeAllEpoch || purgeAllInFlight > 0;
  }

  async function writeSessionListLocked(
    devices: readonly unknown[],
    guard: WriteGuard,
  ): Promise<'written' | 'removed' | 'skipped' | 'stale' | 'failed' | 'purge-failed'> {
    const file = sessionListPath();
    if (isStale(guard)) return 'stale';
    for (const perDeviceLimit of SESSION_LIST_SHRINK_STEPS) {
      const normalized = normalizeDeviceSessions(devices, perDeviceLimit);
      if (normalized.length === 0) {
        lastWritten.delete(file);
        try {
          await fsp.rm(file, { force: true });
          return 'removed';
        } catch {
          // 删除类失败与写入类失败要分开:前者意味着「本该消失的元数据还在盘上」,得进
          // purge 队列;后者只是缓存没更新,重试删除反而会删掉正常数据。
          return 'purge-failed';
        }
      }
      const payload: StoredSessionList = { version: 1, updatedAt: Date.now(), devices: normalized };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_SESSION_LIST_BYTES) continue;
      // 指纹只算 devices,不含 updatedAt。10 秒一轮的 anti-entropy 绝大多数时候内容没变,
      // 这里直接跳过落盘。
      const body = JSON.stringify(normalized);
      if (unchanged(file, body)) return 'skipped';
      await ensureDir(path.dirname(file));
      if (isStale(guard)) return 'stale';
      if (!(await writeFileAtomic(file, serialized))) return 'failed';
      if (isStale(guard)) {
        // 同 writeMessages:清理已经过去了,这笔补偿删除失败就等于「被撤销 / 上一个账号的
        // 设备元数据留在盘上,而且没人知道」。返回 purge-failed 让调用方登记重试。
        lastWritten.delete(file);
        try {
          await fsp.rm(file, { force: true });
        } catch {
          return 'purge-failed';
        }
        return 'stale';
      }
      rememberWritten(file, body);
      return 'written';
    }
    // 缩到最小档仍超上限:保留旧快照,不写入。
    return 'skipped';
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
        return serializeWrite(file, async () => {
          lastWritten.delete(file);
          try {
            await fsp.rm(file, { force: true });
          } catch (err) {
            // 这条路径服务的是被控端 /clear、rewind、会话删除 —— 权威侧已经确认"这个会话没有
            // 可见消息了",本机却还留着旧正文,下次离线冷启动照样 hydrate 出来。删不掉要能被
            // 重试,不能咽下去(review: codex P1)。
            throw new MirrorCachePurgeError(resolveRoot(), [file], err);
          }
        });
      }
      const body = JSON.stringify(normalized);
      const payload: StoredMessages = { version: 1, updatedAt: Date.now(), messages: normalized };
      const serialized = JSON.stringify(payload);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_MESSAGE_FILE_BYTES) {
        // 单会话超限:放弃本次写入,保留旧文件(缓存只是首屏加速)。
        return;
      }
      // 代际必须在**请求发起时**(排队之前)捕获,不能等任务开始执行才读:
      // 「发起 → 排队 → 清理自增 → 任务开始」这个序列里,任务读到的是清理后的新代际,
      // 于是携带着清理前旧数据的这笔写入会被当成新写入放行(review: codex P1)。
      const epoch = generation;
      // 落盘与指纹登记必须成对且有序 → 同一文件的写入串成链(见 serializeWrite)。
      return serializeWrite(file, async () => {
        if (epoch !== generation) return;
        // 指纹只算消息体,不含 payload 的 updatedAt —— 否则每次都"变了",去重永不命中。
        // 在链内判等:排队期间前一笔可能刚写下同样内容。
        if (unchanged(file, body)) return;
        await ensureDir(dir);
        if (epoch !== generation) return;
        if (!(await writeFileAtomic(file, serialized))) return;
        if (epoch !== generation) {
          // 隐私清理期间落的盘:立刻收回,否则刚被清空的目录里会留下本该消失的聊天内容。
          // 这笔补偿删除失败(Windows 文件锁 / 权限)时不能咽下去:清理侧已经枚举并删完了,
          // 它不知道这个文件又冒出来,于是既没人重试、明文也留在了隐私边界之后
          // (review: codex P1)。抛出去让 IPC 登记进 purge 队列。
          lastWritten.delete(file);
          try {
            await fsp.rm(file, { force: true });
          } catch (err) {
            throw new MirrorCachePurgeError(resolveRoot(), [file], err);
          }
          return;
        }
        // 指纹只在真正落盘之后登记(写失败留指纹 → 同内容重试被跳过 → 缓存永久缺失)。
        rememberWritten(file, body);
        await evictMessagesIfNeeded(dir, lastWritten);
      });
    },

    async readSessionList() {
      const parsed = await readJson(sessionListPath());
      const devices = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : [];
      return normalizeDeviceSessions(devices);
    },

    async writeSessionList(devices) {
      // 同 writeMessages:代际在请求发起时捕获(排队期间的清理必须能作废这笔)。
      const epoch = generation;
      // 与 writeMessages 同款:同一文件的写入串成链,保证「落盘 → 登记指纹」成对有序。
      const outcome = await serializeWrite(sessionListPath(), () =>
        writeSessionListLocked(devices, { kind: 'write', epoch }),
      );
      // 只有「删除失败」才抛(见 purge-failed):写入失败保留旧快照即可,不该让上层去
      // 重试删除一份仍然有效的缓存。
      if (outcome === 'purge-failed') {
        throw new MirrorCachePurgeError(resolveRoot(), [sessionListPath()], null);
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
      const epochAll = purgeAllEpoch;
      const dir = messagesDir();
      const prefix = `${safeSegment(id)}-${shortHash(id)}-`;
      const stuck: string[] = [];

      // 枚举必须 fail-closed:`listFiles` 是 fail-open 的(读不了就返回 []),用它的话
      // messages/ 因 EACCES / EPERM / 锁而枚举失败时,这里会「一个文件都没删」却报成功,
      // 于是 IPC 也不会登记重试,正文在权限恢复后照样能被读回(review: greptile + codex P1)。
      const listing = await listMessageFileNames(dir);
      if (listing.unreadable) {
        // 数不出来 ≠ 里面没有。把目录本身计入待重试,删除留给下一次。
        stuck.push(dir);
      } else {
        await Promise.all(
          listing.names
            .filter((name) => name.startsWith(prefix))
            .map(async (name) => {
              const file = path.join(dir, name);
              // 指纹一起清:文件删了却留着指纹,下次写同样内容会被去重跳过 → 文件回不来。
              lastWritten.delete(file);
              try {
                await fsp.rm(file, { force: true });
              } catch {
                stuck.push(file);
              }
            }),
        );
      }

      // 「读快照 → 去掉这台设备 → 写回」整段进同一条串行化链:两台设备同时被收掉时,
      // 各自读同一份旧快照再各写「除我之外的全部」,后写的那次会把另一台恢复回来
      // (review: codex P1)。链内不能再调公开的 writeSessionList(同链嵌套会自锁),
      // 因此直接用 writeSessionListLocked。
      const listFile = sessionListPath();
      const outcome = await serializeWrite(listFile, async () => {
        // 只有 clearAll 能作废这段(它会把整棵目录删掉,这里不该再把列表写回来);
        // 另一个并发的 clearDevice 不作废它 —— 两者依次落地才对。屏障还挡住「clearAll 已开始、
        // 尚未删完」的窗口:那时晚到的 clearDevice 会快照到新代际,若只比代际就拦不住它在
        // 删除完成之后把列表写回去(review: codex P1)。
        const guard = { kind: 'purge', allEpoch: epochAll } as const;
        if (isStale(guard)) return 'stale' as const;
        const parsed = await readJson(listFile);
        const devices = isRecord(parsed) && Array.isArray(parsed.devices) ? parsed.devices : [];
        const others = normalizeDeviceSessions(devices).filter((device) => device.deviceId !== id);
        return writeSessionListLocked(others, guard);
      });
      // 列表快照重写失败(Windows 上被占用 / owner 目录只读)同样要能被重试 —— 否则消息文件
      // 删掉了、会话元数据还在盘上,下次冷启动照样把这台被撤销的设备画回侧边栏(review: codex P1)。
      if (outcome === 'failed' || outcome === 'purge-failed') stuck.push(listFile);

      // 删不掉 / 数不出来的东西都是隐私问题:被撤销的对端正文会留在盘上直到本账号生命周期
      // 结束。抛出来让调用方登记重试,而不是把失败咽下去。
      if (stuck.length > 0) throw new MirrorCachePurgeError(resolveRoot(), stuck, null);
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
      names: entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
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
  purgeContents,
};
