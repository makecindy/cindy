import AsyncStorage from '@react-native-async-storage/async-storage';
import { MESSAGE_PAGE_SIZE } from '@/session/messagePaging';
import type { RemoteMessage } from '@/session/types';

// 「每会话最近消息」本地缓存:冷开会话时先用上次看到的消息乐观渲染,fresh listMessages 回来后
// 对账替换。后端用 AsyncStorage(消息体放得下);key 按 (hostDeviceId, sessionId) 多设备隔离。
// 关键保真度目标:缓存的消息要和 fresh 尽量逐字段一致,让 store 的 remoteMessageListsEqual 能短路、
// 不触发可见的 cached→fresh 重渲染(开会话不再"闪一下")。因此:
//  - 保留消息的全部原始字段(不只 typed 子集),否则 store 的逐 key 比较永远不等;
//  - content 原样保留(含 images/files 的 url 等元数据),只剥真正撑爆体积的二进制大块(base64);
//  - 不把结构化 content 降级成截断字符串(那正是渲染差异 / 闪动的来源)。
const STORAGE_KEY_PREFIX = 'xdt.mobileSessionMessageCache.v1';
// 每会话缓存条数对齐 listMessages 的最新窗口(MESSAGE_PAGE_SIZE),
// 这样冷开 hydrate 的条数与 fresh 一致,不会出现"先 N 条、fresh 回来又长出几条"的列表重排。
export const MAX_CACHED_SESSION_MESSAGES = MESSAGE_PAGE_SIZE;
// 极端兜底:单个裸字符串超此长度才保守截断(远高于正常文本,正常消息绝不触发);
// 主要体积来自 base64 图片数据,已按字段单独剥除,文本一律原样保留以保短路判等。
export const MAX_CACHED_MESSAGE_CONTENT_CHARS = 200000;
// content 里按字段名直接剥掉的二进制大块(base64 图片数据等)。保留 url/name/mimeType,
// 渲染时 normalizer 优先用 url,所以剥掉 base64 不改变可见结果(走 resolveRemoteMedia 懒解析)。
const HEAVY_BLOB_KEYS = new Set(['base64']);
const MAX_CONTENT_DEPTH = 12;

type StoredSessionMessageCache = {
  version: 1;
  updatedAt: number;
  messages: RemoteMessage[];
};

// 同一缓存 key 的写/删严格串行。schedule 分类晚到时会在旧写之后排一个删除，
// 不允许较早开始、较晚结束的 setItem 把已经清掉的完整正文复活。
const pendingOperations = new Map<string, Promise<void>>();
const keyWriteEpochs = new Map<string, number>();
let globalWriteEpoch = 0;
let globalClearInProgress = false;
let activeGlobalClear: Promise<void> | null = null;

export interface SessionMessageCacheWriteAuthority {
  readonly key: string;
  readonly globalEpoch: number;
  readonly keyEpoch: number;
}

function enqueueCacheOperation(key: string, operation: () => Promise<void>): Promise<void> {
  const previous = pendingOperations.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(operation).catch(() => undefined);
  pendingOperations.set(key, next);
  void next.finally(() => {
    if (pendingOperations.get(key) === next) pendingOperations.delete(key);
  });
  return next;
}

export function isSessionMessageCacheWriteAuthorityCurrent(
  authority: SessionMessageCacheWriteAuthority | null | undefined,
): authority is SessionMessageCacheWriteAuthority {
  if (!authority) return false;
  return authority.globalEpoch === globalWriteEpoch
    && authority.keyEpoch === (keyWriteEpochs.get(authority.key) ?? 0);
}

export function captureSessionMessageCacheWriteAuthority(
  deviceId: string,
  sessionId: string,
): SessionMessageCacheWriteAuthority | null {
  // 登出全清从推进 global epoch 到 multiRemove 完成之间禁止铸造新写权。
  // 否则卸载 flush 可在 getAllKeys 已取完快照后创建新 key，并晚于删除落盘。
  if (globalClearInProgress) return null;
  const key = safeStorageKey(deviceId, sessionId);
  if (!key) return null;
  return {
    key,
    globalEpoch: globalWriteEpoch,
    keyEpoch: keyWriteEpochs.get(key) ?? 0,
  };
}

/**
 * 去抖/卸载 flush 使用的条件写：显式删除、rewind 或 schedule 改判会推进 epoch，
 * 此后才触发的旧 timer 即使携带旧快照也不能覆盖新语义。
 */
export async function cacheSessionMessagesIfCurrent(
  authority: SessionMessageCacheWriteAuthority | null,
  messages: readonly RemoteMessage[],
): Promise<void> {
  if (!isSessionMessageCacheWriteAuthorityCurrent(authority)) return;
  const normalized = normalizeCachedMessages(messages);
  await enqueueCacheOperation(authority.key, async () => {
    if (!isSessionMessageCacheWriteAuthorityCurrent(authority)) return;
    if (normalized.length === 0) {
      await AsyncStorage.removeItem(authority.key);
      return;
    }
    const payload: StoredSessionMessageCache = {
      version: 1,
      updatedAt: Date.now(),
      messages: normalized,
    };
    await AsyncStorage.setItem(authority.key, JSON.stringify(payload));
  });
}

/** 显式替换/删除会推进 key epoch，使已排队但尚未提交的旧 render 快照失效。 */
export async function replaceCachedSessionMessages(
  deviceId: string,
  sessionId: string,
  messages: readonly RemoteMessage[],
): Promise<void> {
  const key = safeStorageKey(deviceId, sessionId);
  if (!key) return;
  keyWriteEpochs.set(key, (keyWriteEpochs.get(key) ?? 0) + 1);
  const authority = captureSessionMessageCacheWriteAuthority(deviceId, sessionId);
  await cacheSessionMessagesIfCurrent(authority, messages);
}

// 读取某 (host, session) 的缓存消息;无缓存 / 解析失败一律返回空数组(乐观 hydrate 不应抛错)。
export async function getCachedSessionMessages(
  deviceId: string,
  sessionId: string,
): Promise<RemoteMessage[]> {
  const key = safeStorageKey(deviceId, sessionId);
  if (!key) return [];
  await pendingOperations.get(key)?.catch(() => undefined);
  const raw = await AsyncStorage.getItem(key).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    const list = isRecord(parsed) && Array.isArray((parsed as StoredSessionMessageCache).messages)
      ? (parsed as StoredSessionMessageCache).messages
      : Array.isArray(parsed)
        ? parsed
        : [];
    return normalizeCachedMessages(list);
  } catch {
    return [];
  }
}

// 写入某 (host, session) 的缓存消息;保留最新 MAX 条、剥除 content 二进制大块。
// 传空数组等于清掉这条缓存(避免残留陈旧预览)。
export async function cacheSessionMessages(
  deviceId: string,
  sessionId: string,
  messages: readonly RemoteMessage[],
): Promise<void> {
  const authority = captureSessionMessageCacheWriteAuthority(deviceId, sessionId);
  await cacheSessionMessagesIfCurrent(authority, messages);
}

// 登出清空:遍历所有本前缀的 key 一次性删除(AsyncStorage 支持枚举,无需手动维护 host 索引)。
export function clearCachedSessionMessages(): Promise<void> {
  if (activeGlobalClear) return activeGlobalClear;
  // 先让所有旧条件写失效，再等已经进入 AsyncStorage 的旧操作结束；删除必须排在
  // 它们之后，否则较慢的 setItem 会在登出清理完成后复活缓存。清理完成前保持
  // globalClearInProgress=true，禁止卸载 flush 等路径在 getAllKeys 后铸造新写权。
  globalWriteEpoch += 1;
  globalClearInProgress = true;
  activeGlobalClear = (async () => {
    await Promise.all([...pendingOperations.values()].map((operation) =>
      operation.catch(() => undefined)));
    const keys = await AsyncStorage.getAllKeys().catch(() => [] as readonly string[]);
    const owned = keys.filter((key) => key.startsWith(`${STORAGE_KEY_PREFIX}.`));
    if (owned.length > 0) await AsyncStorage.multiRemove(owned).catch(() => undefined);
    keyWriteEpochs.clear();
  })().finally(() => {
    globalClearInProgress = false;
    activeGlobalClear = null;
  });
  return activeGlobalClear;
}

// 排序(升序 createdAt)+ 按 messageKey 去重(对账:同 id 保留最后一次)+ 取最新 N 条。
// mobile-system-* 没有服务端副本，必须跨窗口保留；保护行可以让软上限略微超出。
function normalizeCachedMessages(input: readonly unknown[]): RemoteMessage[] {
  const byKey = new Map<string, RemoteMessage>();
  for (const item of input) {
    const message = coerceRemoteMessage(item);
    if (!message) continue;
    byKey.set(messageKey(message), message);
  }
  const sorted = [...byKey.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const protectedRows = sorted.filter((message) => messageKey(message).startsWith('mobile-system-'));
  const protectedKeys = new Set(protectedRows.map(messageKey));
  const latestRows = sorted
    .filter((message) => !protectedKeys.has(messageKey(message)))
    .slice(-MAX_CACHED_SESSION_MESSAGES);
  return [...protectedRows, ...latestRows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

// 与 remoteSessionStore.messageKey 对齐:id → clientId → role:createdAt,保证对账去重口径一致。
function messageKey(message: RemoteMessage): string {
  return message.id || message.clientId || `${message.role}:${message.createdAt}`;
}

// 保留消息的全部原始字段(含 typed interface 之外的字段),只对 content 做体积净化 ——
// 这样 cached 与 fresh 经 store 的逐 key 比较能判等、不触发可见重渲染。
function coerceRemoteMessage(item: unknown): RemoteMessage | null {
  if (!isRecord(item)) return null;
  const createdAt = typeof item.createdAt === 'string' ? item.createdAt : '';
  if (!createdAt) return null;
  const id = typeof item.id === 'string' ? item.id : '';
  const clientId = typeof item.clientId === 'string' ? item.clientId : '';
  if (!id && !clientId) return null;
  return { ...item, content: sanitizeContentForCache(item.content) } as unknown as RemoteMessage;
}

// 剥掉 content 里的二进制大块(base64 / data:base64 URI / 病态超大裸字符串),其余原样保留。
// 无大块的常规 content(文本、url 图片元数据)输出与输入逐字节一致,从而 cached==fresh、不闪。
function sanitizeContentForCache(content: unknown): unknown {
  return stripHeavyContent(content, 0);
}

function stripHeavyContent(value: unknown, depth: number): unknown {
  if (depth > MAX_CONTENT_DEPTH) return undefined;
  if (typeof value === 'string') return sanitizeContentString(value, depth);
  if (Array.isArray(value)) return value.map((item) => stripHeavyContent(item, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (HEAVY_BLOB_KEYS.has(key)) continue;
      out[key] = stripHeavyContent(raw, depth + 1);
    }
    return out;
  }
  return value;
}

function sanitizeContentString(value: string, depth: number): string {
  // data:...;base64,... 内联大块,丢弃(留空串占位);渲染走 url,不影响可见结果。
  if (value.startsWith('data:') && value.includes(';base64,')) return '';
  // 用户消息 content 常是 JSON 字符串;只有当它很大且疑似内联了 base64 时才解析→剥→回写,
  // 否则原样返回以保 byte 级一致(短路判等)。
  if (value.length > MAX_CACHED_MESSAGE_CONTENT_CHARS || (value.length > 16_000 && value.includes('base64'))) {
    const parsed = tryParseJson(value);
    if (parsed !== undefined) {
      try {
        return JSON.stringify(stripHeavyContent(parsed, depth + 1)) ?? '';
      } catch {
        return value.slice(0, MAX_CACHED_MESSAGE_CONTENT_CHARS);
      }
    }
    return value.slice(0, MAX_CACHED_MESSAGE_CONTENT_CHARS);
  }
  return value;
}

function tryParseJson(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function safeStorageKey(deviceId: string, sessionId: string): string | null {
  const host = deviceId.trim();
  const session = sessionId.trim();
  if (!host || !session) return null;
  return `${STORAGE_KEY_PREFIX}.${sanitizeSegment(host)}.${fnv1a(host)}.${sanitizeSegment(session)}.${fnv1a(session)}`;
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'x';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export const __testing = {
  storageKeyPrefix: STORAGE_KEY_PREFIX,
  safeStorageKey,
  normalizeCachedMessages,
  sanitizeContentForCache,
};
