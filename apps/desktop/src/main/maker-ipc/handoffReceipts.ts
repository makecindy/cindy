import {
  handoffReceiptDoneClientId,
  parseHandoffReceiptInputClientId,
} from '@cindy/maker-shared/handoff-receipt';
import { UI_ACTION_TRIGGER_PREFIX } from '@cindy/maker-shared/synthetic-trigger';

/**
 * send_to_session 完成回执的回投:目标任务消费带 `handoff-receipt:` clientId 的输入且
 * turn 正常结束后,向发起任务回投一条隐藏唤醒。回执不含对方回复正文(发起方用
 * get_chat_history 自取),确定性 clientId 保证重放/重试幂等。回执 clientId 前缀是
 * `handoff-receipt-done:`,不会再被完成钩子当作请求回执的输入 —— 循环抑制由前缀互斥保证。
 */
export interface HandoffReceiptSend {
  (params: {
    targetSessionId: string;
    dispatcherSessionId: string;
    message: string;
    persistedContent: string;
    clientId: string;
    forceQueue: boolean;
  }): Promise<{ ok: true } | { ok: false; errorCode: string; message: string }>;
}

export function buildHandoffReceiptMessage(params: {
  targetSessionId: string;
  inputClientId: string;
}): string {
  return [
    `[Handoff receipt] 任务 ${params.targetSessionId} 已结束对你用 send_to_session 发送的一条消息的处理(消息 id: ${params.inputClientId})。本条不是用户消息。`,
    '回执仅表示该轮已收口,不保证成功;不含对方回复正文,需要结果与实际状态用 history 类目 get_chat_history(session_id: ' +
      `${params.targetSessionId}) 读取。回复用户时不要复述本条回执或内部 id。`,
  ].join('\n');
}

const MAX_ATTEMPTS = 3;

/**
 * 终态失败轮次的回执闸门:按 sessionId+sessionInstanceId 记录最近一次终态 error 的
 * turn 代次。代次是单实例计数,实例重建后从 0 重来 —— 归属必须含实例,否则旧实例
 * 的失败记录会拦截新实例的全部回执;旧实例关闭时可能只有终态 error 没有配对 done
 * (settleUnfinishedTurn),记录随旧实例键作废,不做跨实例清理。done 快照若属同一
 * (或更旧)失败代次,不得回投「已收口」回执;可重试 error 不记。
 */
export function createHandoffReceiptGate() {
  const failedGenerations = new Map<string, number>();
  const keyOf = (sessionId: string, instanceId: string | undefined) =>
    `${sessionId}:${instanceId ?? 'unknown'}`;
  return {
    markTerminalError(
      sessionId: string,
      instanceId: string | undefined,
      generation: number | undefined,
    ): void {
      if (typeof generation !== 'number') return;
      const key = keyOf(sessionId, instanceId);
      const prev = failedGenerations.get(key);
      if (prev === undefined || generation >= prev) failedGenerations.set(key, generation);
    },
    /** 返回该 done 是否属于已记录的失败代次;顺带清理被更新代次越过的陈旧记录。 */
    isFailedTurn(
      sessionId: string,
      instanceId: string | undefined,
      generation: number | undefined,
    ): boolean {
      const key = keyOf(sessionId, instanceId);
      const failed = failedGenerations.get(key);
      if (failed === undefined) return false;
      if (typeof generation !== 'number') return true;
      if (failed < generation) {
        failedGenerations.delete(key);
        return false;
      }
      if (failed === generation) failedGenerations.delete(key);
      // failed > generation:done 比失败记录更旧(乱序/陈旧终态),保守当作失败。
      return true;
    },
  };
}

export function createHandoffReceiptSender(deps: {
  send: HandoffReceiptSend;
  /** 注入以便单测;缺省 1s×attempt 的真实退避。 */
  delay?: (ms: number) => Promise<void>;
  warn?: (message: string, details: Record<string, unknown>) => void;
}): (targetSessionId: string, inputClientIds: readonly string[]) => Promise<void> {
  const delay =
    deps.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref?.()));
  const warn = deps.warn ?? (() => {});
  return async (targetSessionId, inputClientIds) => {
    for (const inputClientId of inputClientIds) {
      const parsed = parseHandoffReceiptInputClientId(inputClientId);
      if (!parsed) continue;
      const message = buildHandoffReceiptMessage({ targetSessionId, inputClientId });
      const clientId = handoffReceiptDoneClientId(parsed.nonce);
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        // 确定性 clientId + messages 表 (sessionId, clientId) 唯一索引:重发不会产生第二条回执。
        const result = await deps
          .send({
            targetSessionId: parsed.dispatcherSessionId,
            dispatcherSessionId: targetSessionId,
            message,
            persistedContent: `${UI_ACTION_TRIGGER_PREFIX}${message}`,
            clientId,
            forceQueue: true,
          })
          .catch((error: unknown) => ({
            ok: false as const,
            errorCode: 'INTERNAL',
            message: error instanceof Error ? error.message : String(error),
          }));
        if (result.ok) break;
        if (attempt === MAX_ATTEMPTS - 1) {
          warn('handoff receipt was not delivered', {
            targetSessionId,
            dispatcherSessionId: parsed.dispatcherSessionId,
            inputClientId,
            errorCode: result.errorCode,
          });
        } else {
          await delay(1_000 * (attempt + 1));
        }
      }
    }
  };
}
