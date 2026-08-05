/**
 * agent-input-queue-snapshots —— 排队输入的崩溃恢复快照读写(issue #761)。
 *
 * 职责:AgentInputCoordinator 的 pendingQueue 内容变化时覆盖写单行快照,
 * 重启后打开会话时读回并恢复为「暂停中的队列」。写入是尽力而为的辅助信号:
 * 失败只落日志,绝不阻塞派发主流程;per-session 写链保序(参考
 * sessionActiveTurn 的 chainWrite),避免"后发先至"让旧快照覆盖新快照。
 *
 * 体量守卫:payload 超过 MAX_PAYLOAD_BYTES 时先剥离 files[].base64(剪贴板
 * 图片的内联兜底,路径型附件不受影响)重试;仍超限则放弃本次写入并保留旧
 * 快照(宁可恢复到稍旧的队列,不写入截断的坏数据)。
 */

import { eq } from 'drizzle-orm';

import { getDbClient } from './client/current';
import { agentInputQueueSnapshots } from './schema';
import { createLogger } from '../logger';
import {
  sanitizeQueuedMessageForPersistence,
  type AgentInputQueuedMessage,
} from '../../shared/agentInputQueue.js';

const log = createLogger('agent-input-queue-snapshots');

/** 单会话快照体量上限(16MB):正常队列远小于此,超限基本是多张大图的 base64。 */
const MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;

/** per-session 写链:只做覆盖写/删除排队保序,无读改写。 */
const _writeChains = new Map<string, Promise<void>>();

function chainWrite(sessionId: string, op: () => Promise<void>): Promise<void> {
  const prev = _writeChains.get(sessionId) ?? Promise.resolve();
  const opResult = prev.then(op);
  const chainNext = opResult.catch(() => undefined).finally(() => {
    if (_writeChains.get(sessionId) === chainNext) _writeChains.delete(sessionId);
  });
  _writeChains.set(sessionId, chainNext);
  return opResult;
}

function stripInlineBase64(items: AgentInputQueuedMessage[]): AgentInputQueuedMessage[] {
  return items.map((item) => {
    let changed = false;
    const files = item.files?.map((f) => {
      if (!f.base64) return f;
      changed = true;
      const { base64: _dropped, ...rest } = f;
      return rest;
    });
    const images = item.chatMessage.images?.filter((img) => !('base64' in img));
    const imagesChanged = images !== undefined && images.length !== (item.chatMessage.images?.length ?? 0);
    if (!changed && !imagesChanged) return item;
    return {
      ...item,
      ...(files ? { files } : {}),
      chatMessage: imagesChanged ? { ...item.chatMessage, images } : item.chatMessage,
    };
  });
}

/**
 * 覆盖写快照;items 为空时删行。fire-and-forget 语义由调用方决定
 * (coordinator 不 await),返回 promise 供测试与需要落库确认的调用方使用。
 */
export function saveAgentInputQueueSnapshot(
  sessionId: string,
  items: AgentInputQueuedMessage[],
): Promise<void> {
  return chainWrite(sessionId, async () => {
    try {
      const db = getDbClient().drizzle;
      if (items.length === 0) {
        await db
          .delete(agentInputQueueSnapshots)
          .where(eq(agentInputQueueSnapshots.sessionId, sessionId));
        return;
      }
      const persistableItems = items.map(sanitizeQueuedMessageForPersistence);
      let payload = JSON.stringify(persistableItems);
      if (payload.length > MAX_PAYLOAD_BYTES) {
        payload = JSON.stringify(stripInlineBase64(persistableItems));
        if (payload.length > MAX_PAYLOAD_BYTES) {
          log.warn('queue snapshot too large even after stripping inline base64; keeping previous snapshot', {
            sessionId,
            items: items.length,
            bytes: payload.length,
          });
          return;
        }
        log.warn('queue snapshot stripped inline base64 attachments to fit size cap', {
          sessionId,
          items: items.length,
        });
      }
      const now = Date.now();
      await db
        .insert(agentInputQueueSnapshots)
        .values({ sessionId, payload, updatedAt: now })
        .onConflictDoUpdate({
          target: agentInputQueueSnapshots.sessionId,
          set: { payload, updatedAt: now },
        });
    } catch (err) {
      log.warn('saveAgentInputQueueSnapshot failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });
}

/**
 * 媒体回收器活引用取证(recycler.ts 的崩溃恢复暂存区):全量快照 payload 原文。
 * 不解析形状——回收器只按文本正则抽取 cindy-media 指纹,坏 JSON 也能扫,
 * 比逐条恢复更保守(宁可多保护,不可漏保护)。
 */
export async function loadAllQueueSnapshotPayloads(): Promise<string[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ payload: agentInputQueueSnapshots.payload })
    .from(agentInputQueueSnapshots);
  return rows.map((r) => r.payload);
}

function isRestorableQueuedMessage(value: unknown): value is AgentInputQueuedMessage {
  if (!value || typeof value !== 'object') return false;
  const msg = value as AgentInputQueuedMessage;
  return (
    typeof msg.clientId === 'string' && msg.clientId.length > 0 &&
    typeof msg.text === 'string' &&
    typeof msg.persistedContent === 'string' &&
    !!msg.chatMessage && typeof msg.chatMessage === 'object' &&
    !!msg.createOpts && typeof msg.createOpts === 'object' &&
    (msg.createOpts.agentKind === 'claude-code' || msg.createOpts.agentKind === 'codex')
  );
}

/**
 * 读回快照。行不存在 → 空数组;JSON 损坏 / 整体形状不对 → 删行 + 空数组
 * (坏快照没有恢复价值,留着会让每次打开会话都报一次);逐条形状校验,
 * 坏条目丢弃、好条目保留。读失败(db 未就绪等)抛出,由调用方决定重试语义。
 */
export async function loadAgentInputQueueSnapshot(
  sessionId: string,
): Promise<AgentInputQueuedMessage[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({ payload: agentInputQueueSnapshots.payload })
    .from(agentInputQueueSnapshots)
    .where(eq(agentInputQueueSnapshots.sessionId, sessionId))
    .limit(1);
  const payload = rows[0]?.payload;
  if (payload === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    log.warn('discarding corrupt queue snapshot', { sessionId, bytes: payload.length });
    void saveAgentInputQueueSnapshot(sessionId, []).catch(() => undefined);
    return [];
  }
  const validItems = parsed.filter(isRestorableQueuedMessage);
  const items = validItems.map(sanitizeQueuedMessageForPersistence);
  if (items.length !== parsed.length) {
    log.warn('dropped malformed rows from queue snapshot', {
      sessionId,
      kept: items.length,
      dropped: parsed.length - items.length,
    });
  }
  if (items.some((item, index) => item !== validItems[index])) {
    log.warn('stripped trusted session reference bodies from legacy queue snapshot', {
      sessionId,
      items: items.length,
    });
    void saveAgentInputQueueSnapshot(sessionId, items).catch(() => undefined);
  }
  return items;
}
