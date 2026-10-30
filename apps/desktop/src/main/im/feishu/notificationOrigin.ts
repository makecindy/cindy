/** Links private bot notification receipts to their original Cindy session, independently of /ctr. */
import { and, eq } from 'drizzle-orm';
import type { FeishuIM, IMMessageEvent } from '@cindy/im';
import { getDbClient } from '../../localDb/client/current';
import { imNotificationOrigins, sessions } from '../../localDb/schema';
import { createLogger } from '../../logger';
import {
  captureImAccountGeneration,
  isImAccountGenerationCurrent,
  ImAccountScopeClosedError,
  runInImAccountGeneration,
} from '../accountBoundary';

const log = createLogger('im:feishu:notification');
const sending = new Map<string, Set<Promise<unknown>>>();

function sendingKey(generation: number, appId: string, userId: string): string {
  return JSON.stringify([generation, appId, userId]);
}

export function sendFeishuSessionNotification(
  im: FeishuIM, sessionId: string, text: string,
): Promise<{ messageId: string; chatId?: string; sessionLinked: boolean }> {
  const generation = captureImAccountGeneration();
  const status = im.getStatus();
  const userId = im.getOwnerOpenId();
  if (generation === null || status.kind !== 'connected' || !userId) {
    return Promise.reject(new Error('Feishu notification channel is not ready'));
  }
  const db = getDbClient();
  const key = sendingKey(generation, status.appId, userId);
  const operation = runInImAccountGeneration(generation, async () => {
    const current = im.getStatus();
    if (current.kind !== 'connected' || current.appId !== status.appId || im.getOwnerOpenId() !== userId) {
      throw new ImAccountScopeClosedError();
    }
    const receipt = await im.sendNotification(userId, text);
    // A receipt proves delivery: subsequent failures must never become SEND_FAIL.
    try {
      if (!isImAccountGenerationCurrent(generation)) throw new ImAccountScopeClosedError();
      if (!receipt.chatId) throw new Error('Notification receipt has no chat id');
      await db.drizzle.insert(imNotificationOrigins).values({
        channel: 'feishu',
        botContextId: status.appId,
        userId,
        messageId: receipt.messageId,
        chatId: receipt.chatId,
        sessionId,
        createdAt: Date.now(),
      });
    } catch {
      log.error('notification sent but session link persistence failed', { message: receipt.messageId.slice(-8) });
      return { ...receipt, sessionLinked: false };
    }
    log.info('notification linked', { message: receipt.messageId.slice(-8), session: sessionId.slice(-8) });
    return { ...receipt, sessionLinked: true };
  });
  const pending = sending.get(key) ?? new Set<Promise<unknown>>();
  sending.set(key, pending);
  pending.add(operation);
  const remove = () => {
    pending.delete(operation);
    if (!pending.size) sending.delete(key);
  };
  void operation.then(remove, remove);
  return operation;
}

export async function resolveFeishuNotificationReply(im: FeishuIM, event: IMMessageEvent): Promise<string | null> {
  if (!event.replyThread || event.speaker || event.senderId !== im.getOwnerOpenId()) return null;
  const status = im.getStatus();
  if (status.kind !== 'connected' || status.appId !== event.contextId) return null;
  const generation = captureImAccountGeneration();
  if (generation === null) throw new ImAccountScopeClosedError();
  const db = getDbClient();
  const readOrigin = async () => {
    if (!isImAccountGenerationCurrent(generation)) throw new ImAccountScopeClosedError();
    const [origin] = await db.drizzle.select({ sessionId: imNotificationOrigins.sessionId })
      .from(imNotificationOrigins).where(and(
        eq(imNotificationOrigins.channel, 'feishu'),
        eq(imNotificationOrigins.botContextId, event.contextId),
        eq(imNotificationOrigins.userId, event.senderId),
        eq(imNotificationOrigins.messageId, event.replyThread!.rootMessageId),
        eq(imNotificationOrigins.chatId, event.chatId),
      )).limit(1);
    if (!isImAccountGenerationCurrent(generation)) throw new ImAccountScopeClosedError();
    return origin;
  };
  // Existing links must not wait for unrelated notifications. For a fast reply,
  // recheck after each pending send settles, rather than waiting for every send.
  const pending = new Set(sending.get(sendingKey(generation, status.appId, event.senderId)));
  let origin = await readOrigin();
  if (!origin && pending.size) {
    const remaining = new Map([...pending].map((operation) => [
      operation, operation.then(() => ({ operation }), () => ({ operation })),
    ]));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), 10_000);
    });
    try {
      while (!origin && remaining.size) {
        const settled = await Promise.race([...remaining.values(), timeout]);
        origin = await readOrigin();
        // A pending send cannot prove this root belongs to a notification.
        // After the bounded wait, preserve the unlinked topic's normal route.
        if (settled === null) break;
        remaining.delete(settled.operation);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (!origin) return null;
  const [row] = await db.drizzle.select({ workingDir: sessions.workingDir, status: sessions.status, orcaRole: sessions.orcaRole }).from(sessions).where(eq(sessions.id, origin.sessionId)).limit(1);
  if (!isImAccountGenerationCurrent(generation)) throw new ImAccountScopeClosedError();
  const current = im.getStatus();
  if (current.kind !== 'connected' || current.appId !== event.contextId || im.getOwnerOpenId() !== event.senderId) {
    throw new ImAccountScopeClosedError();
  }
  if (!row?.workingDir || row.status === 'deleted' || row.status === 'archived' || row.orcaRole === 'worker') {
    throw new Error('Notification target session is unavailable');
  }
  log.info('notification reply resolved', { root: event.replyThread.rootMessageId.slice(-8), session: origin.sessionId.slice(-8) });
  return origin.sessionId;
}
