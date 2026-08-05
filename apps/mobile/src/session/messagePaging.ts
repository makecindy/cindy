import type { RemoteMessage, RemoteSession } from '@/session/types';

export const MESSAGE_PAGE_SIZE = 80;
export const MESSAGE_PAGE_RETRY_LIMITS = [80, 40, 20, 10, 5, 1] as const;

export function latestMessageCursor(messages: readonly RemoteMessage[]): string | null {
  let latest: RemoteMessage | null = null;
  for (const message of messages) {
    if (!message.id || message.id.startsWith('mobile-system-')) continue;
    if (!latest || compareMessageOrder(message, latest) > 0) latest = message;
  }
  return latest?.id ?? null;
}

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

export function incrementalMessagePageNeedsFallback(input: {
  page: MessagePageRetryResult;
  totalCount?: number;
  previousTotalCount?: number;
  afterMessage?: RemoteMessage | null;
}): boolean {
  const { page, totalCount, previousTotalCount, afterMessage } = input;
  if (page.reducedByPayloadTooLarge) return true;
  if (
    afterMessage
    && page.messages.some((message) => compareMessageOrder(message, afterMessage) <= 0)
  ) {
    // An old host may ignore `after` and return the latest page. A row at or before
    // the client cursor proves this is not a contiguous incremental page.
    return true;
  }
  if (page.messages.length >= page.limit) return true;
  if (
    typeof totalCount === 'number'
    && Number.isFinite(totalCount)
    && typeof previousTotalCount === 'number'
    && Number.isFinite(previousTotalCount)
  ) {
    const expectedNewRows = totalCount - previousTotalCount;
    return expectedNewRows < 0 || page.messages.length !== expectedNewRows;
  }
  return false;
}

export interface CompleteIncrementalMessageCollectionInput {
  initialPage: MessagePageRetryResult;
  afterMessage: RemoteMessage;
  fetchAfter: (after: string) => Promise<MessagePageRetryResult>;
  fetchLatest: () => Promise<MessagePageRetryResult>;
  fetchBefore: (before: string) => Promise<MessagePageRetryResult>;
  maxPages?: number;
}

/**
 * Collect every row after a reopen cursor before marking the cached window synced.
 * The first `after` page is intentionally capped, so a large offline delta needs
 * cursor pagination; an old host that ignores `after` is handled by walking back
 * from the latest window until the original cursor is reached.
 */
export async function collectCompleteIncrementalMessages(
  input: CompleteIncrementalMessageCollectionInput,
): Promise<RemoteMessage[] | null> {
  const maxPages = input.maxPages ?? 256;
  const anchor = input.afterMessage;
  const collected = new Map<string, RemoteMessage>();
  const addRowsAfterAnchor = (rows: readonly RemoteMessage[]): boolean => {
    let valid = true;
    for (const message of rows) {
      if (compareMessageOrder(message, anchor) <= 0) {
        valid = false;
        continue;
      }
      const key = message.id || message.clientId;
      if (key) collected.set(key, message);
    }
    return valid;
  };
  const anchorKey = anchor.id || anchor.clientId;
  const containsAnchor = (rows: readonly RemoteMessage[]): boolean =>
    Boolean(anchorKey) && rows.some((message) =>
      (message.id || message.clientId) === anchorKey);
  const ordered = (): RemoteMessage[] => [...collected.values()].sort(compareMessageOrder);
  const hasTrimmedRows = (page: MessagePageRetryResult): boolean =>
    page.messages.some((message) => message.agentMeta?.remoteRowsTrimmed === true);
  // New hosts support cursor pagination. Every subsequent page must be strictly
  // after the last cursor; otherwise the host is treated as legacy and we switch
  // to the authoritative tail walk below.
  let page = input.initialPage;
  let forwardValid = addRowsAfterAnchor(page.messages);
  let cursor = latestMessageCursor(page.messages);
  let forwardComplete = false;
  for (let pageIndex = 0; forwardValid && pageIndex < maxPages; pageIndex += 1) {
    if (!cursor) break;
    if (
      page.messages.length < page.limit
      && !page.reducedByPayloadTooLarge
      && !hasTrimmedRows(page)
    ) {
      forwardComplete = true;
      break;
    }

    const next = await input.fetchAfter(cursor);
    if (next.messages.length === 0) {
      // Empty continuation after more than one page proves a progressing forward
      // walk reached the tail. After only the initial full/reduced page it can also
      // mean the host ignored an unknown cursor and returned the latest window.
      if (pageIndex > 0) forwardComplete = true;
      else forwardValid = false;
      break;
    }
    const nextCursor = latestMessageCursor(next.messages);
    if (!nextCursor || nextCursor === cursor) {
      forwardValid = false;
      break;
    }
    forwardValid = addRowsAfterAnchor(next.messages);
    page = next;
    cursor = nextCursor;
  }
  if (forwardValid && forwardComplete) return ordered();
  if (forwardValid) return null;

  // A latest-window fallback must be paged backwards; using only its tail can
  // silently omit the middle of a delta larger than the window size.
  collected.clear();
  page = await input.fetchLatest();
  for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
    const reachedAnchor = containsAnchor(page.messages);
    const crossedAnchor = !addRowsAfterAnchor(page.messages);
    if (reachedAnchor) return ordered();
    if (crossedAnchor) return null;
    if (
      page.messages.length < page.limit
      && !page.reducedByPayloadTooLarge
      && !hasTrimmedRows(page)
    ) return null;
    const before = oldestMessageCursor(page.messages);
    if (!before) return null;
    page = await input.fetchBefore(before);
    if (page.messages.length === 0) return null;
  }
  return null;
}

export function compareMessageOrder(a: RemoteMessage, b: RemoteMessage): number {
  const byTime = a.createdAt.localeCompare(b.createdAt);
  if (byTime !== 0) return byTime;
  if (
    typeof a.rowid === 'number'
    && Number.isFinite(a.rowid)
    && typeof b.rowid === 'number'
    && Number.isFinite(b.rowid)
    && a.rowid !== b.rowid
  ) return a.rowid - b.rowid;
  // Older hosts and live push frames may not carry rowid. Their same-timestamp
  // arrival order is meaningful; message ids are not insertion ordered.
  return 0;
}
