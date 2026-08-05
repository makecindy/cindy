import type { RemoteMessage, RemoteSession } from '@/session/types';

export const MESSAGE_PAGE_SIZE = 80;
export const MESSAGE_PAGE_RETRY_LIMITS = [80, 40, 20, 10, 5, 1] as const;

export function oldestMessageCursor(messages: readonly RemoteMessage[]): string | null {
  let oldest: RemoteMessage | null = null;
  for (const message of messages) {
    // Skip locally-appended system cards (synthetic `mobile-system-…` id, see
    // remoteSessionStore.appendLocalSystemCard): they aren't real host rows, so handing one to
    // the host as a `before` cursor matches nothing and re-fetches the latest page (no progress).
    if (!message.id || message.id.startsWith('mobile-system-')) continue;
    if (!oldest || compareMessageOrder(message, oldest) < 0) {
      oldest = message;
    }
  }
  return oldest?.id ?? null;
}

export function hasMoreOlderMessages(page: readonly RemoteMessage[], pageSize = MESSAGE_PAGE_SIZE): boolean {
  if (page.length >= pageSize) return true;
  // 被控端结果帧超限时会静默裁行,并在保留行打 agentMeta.remoteRowsTrimmed 标记
  // (device-link dispatch 的 compactInvokeResultForDeviceLink):此时短页不代表
  // 历史到头,「加载更早」入口必须保留,否则被裁掉的老历史永远不可达。
  return page.some((m) => m.agentMeta?.remoteRowsTrimmed === true);
}

export interface MessagePageRetryResult {
  messages: RemoteMessage[];
  limit: number;
  reducedByPayloadTooLarge: boolean;
}

export async function listMessagesWithPayloadRetry(
  listMessages: (limit: number) => Promise<RemoteMessage[]>,
  limits: readonly number[] = MESSAGE_PAGE_RETRY_LIMITS,
): Promise<MessagePageRetryResult> {
  let lastPayloadError: unknown = null;
  for (let index = 0; index < limits.length; index += 1) {
    const limit = limits[index];
    try {
      const messages = await listMessages(limit);
      return {
        messages: Array.isArray(messages) ? messages : [],
        limit,
        reducedByPayloadTooLarge: index > 0,
      };
    } catch (err) {
      if (!isPayloadTooLargeError(err)) throw err;
      lastPayloadError = err;
    }
  }
  if (lastPayloadError instanceof Error) throw lastPayloadError;
  throw new Error(String(lastPayloadError ?? 'message page payload too large'));
}

export function shouldKeepOlderMessagesAffordance(page: MessagePageRetryResult): boolean {
  if (page.messages.length === 0) return false;
  return page.reducedByPayloadTooLarge || hasMoreOlderMessages(page.messages, page.limit);
}

type SessionMessageVersion = Pick<RemoteSession, '_count' | 'updatedAt'>;

export function shouldRefreshLatestMessageWindowOnReopen(input: {
  freshSession: SessionMessageVersion;
  messageWindowSynced: boolean;
  storedSession: SessionMessageVersion | null | undefined;
}): boolean {
  const updatedAtChanged = (input.storedSession?.updatedAt ?? '') !== input.freshSession.updatedAt;
  const freshCount = input.freshSession._count?.messages;
  const storedCount = input.storedSession?._count?.messages;
  const countChanged = typeof freshCount === 'number'
    && typeof storedCount === 'number'
    && freshCount !== storedCount;
  return updatedAtChanged || countChanged || !input.messageWindowSynced;
}

/**
 * 重开会话且"无新内容、跳过整窗重拉"时,用现成信号推断是否还有更早消息(屏幕重开会把
 * `hasOlderMessages` state 重置为 false,不补设就会丢失「加载更早」入口 —— 这是回归)。
 * 优先用服务端总数 `_count.messages` 与 in-store 已加载真实消息数比较(总数 > 已加载 → 还有更早);
 * 服务端没给总数时退化为窗口启发式(已加载到整页边界 → 推断还有更早)。
 * 计数排除本地合成的 system 卡(`mobile-system-` 前缀,非真实 host 行)。
 */
export function hasOlderMessagesAfterReopen(
  totalCount: number | undefined,
  loadedMessages: readonly RemoteMessage[],
  pageSize = MESSAGE_PAGE_SIZE,
): boolean {
  const loadedReal = countRealMessages(loadedMessages);
  if (loadedReal === 0) return false;
  if (typeof totalCount === 'number' && Number.isFinite(totalCount)) {
    return totalCount > loadedReal;
  }
  return loadedReal >= pageSize;
}

/**
 * 严格的"还有更早消息"判定:仅当服务端总数 `_count.messages` 已知且 > in-store 已加载真实条数时
 * 返回 true;**总数未知一律返回 false**(不退化为窗口启发式)。用于首开缓存 hydrate 后乐观点亮
 * 「加载更早」入口 —— 入口可见即意味着点了能拉出东西,所以宁缺毋滥,_count 未知时不凭空点亮。
 */
export function hasOlderMessagesByServerCount(
  totalCount: number | undefined,
  loadedMessages: readonly RemoteMessage[],
): boolean {
  if (typeof totalCount !== 'number' || !Number.isFinite(totalCount)) return false;
  return totalCount > countRealMessages(loadedMessages);
}

function countRealMessages(messages: readonly RemoteMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (!message.id || message.id.startsWith('mobile-system-')) continue;
    count += 1;
  }
  return count;
}

export function isPayloadTooLargeError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code ?? '')
    : '';
  const message = error instanceof Error ? error.message : String(error);
  return code === 'PAYLOAD_TOO_LARGE' || message.includes('PAYLOAD_TOO_LARGE') || /frame exceeds \d+ bytes/i.test(message);
}

function compareMessageOrder(a: RemoteMessage, b: RemoteMessage): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  return (a.id || a.clientId).localeCompare(b.id || b.clientId);
}
