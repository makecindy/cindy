import type { FeishuIM, IMMessageEvent } from '@cindy/im';
import type { Logger } from '@cindy/maker-core';
import { ImAccountScopeClosedError, type createImAccountBoundary } from '../../accountBoundary';
export interface FeishuNotificationOrigin {
  channel: 'feishu'; botContextId: string; userId: string; messageId: string;
  chatId: string; sessionId: string; createdAt: number;
}
export interface FeishuNotificationStore {
  insert(origin: FeishuNotificationOrigin): Promise<void>;
  find(key: Omit<FeishuNotificationOrigin, 'sessionId' | 'createdAt'>): Promise<{ sessionId: string } | null>;
  session(id: string): Promise<{ workingDir: string | null; status: string; orcaRole?: string | null } | null>;
}
/** The store is captured before network I/O, and never resolves a replacement owner. */
export function createFeishuNotifications(host: {
  account: Pick<ReturnType<typeof createImAccountBoundary>, 'captureImAccountGeneration' | 'isImAccountGenerationCurrent' | 'runInImAccountGeneration'>;
  captureStore(): FeishuNotificationStore;
  log: Pick<Logger, 'error' | 'info'>;
}) {
const { captureImAccountGeneration, isImAccountGenerationCurrent, runInImAccountGeneration } = host.account;
const { log } = host;
const sending = new Map<string, Set<Promise<unknown>>>();

function sendingKey(generation: number, appId: string, userId: string): string {
  return JSON.stringify([generation, appId, userId]);
}

function sendFeishuSessionNotification(
  im: FeishuIM, sessionId: string, text: string,
): Promise<{ messageId: string; chatId?: string; sessionLinked: boolean }> {
  const generation = captureImAccountGeneration();
  const status = im.getStatus();
  const userId = im.getOwnerOpenId();
  if (generation === null || status.kind !== 'connected' || !userId) {
    return Promise.reject(new Error('Feishu notification channel is not ready'));
  }
  const store = host.captureStore();
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
      await store.insert({
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

async function resolveFeishuNotificationReply(im: FeishuIM, event: IMMessageEvent): Promise<string | null> {
  if (!event.replyThread || event.speaker || event.senderId !== im.getOwnerOpenId()) return null;
  const status = im.getStatus();
  if (status.kind !== 'connected' || status.appId !== event.contextId) return null;
  const generation = captureImAccountGeneration();
  if (generation === null) throw new ImAccountScopeClosedError();
  const store = host.captureStore();
  const readOrigin = async () => {
    if (!isImAccountGenerationCurrent(generation)) throw new ImAccountScopeClosedError();
    const origin = await store.find({ channel: 'feishu', botContextId: event.contextId,
      userId: event.senderId, messageId: event.replyThread!.rootMessageId, chatId: event.chatId });
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
  const row = await store.session(origin.sessionId);
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

return { sendFeishuSessionNotification, resolveFeishuNotificationReply };
}
