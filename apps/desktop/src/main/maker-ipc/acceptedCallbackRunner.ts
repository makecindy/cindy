import { createLogger } from '../logger.js';

const defaultLog = createLogger('maker-ipc');

/** accepted callback runner 的最小日志接口，供 Orca dispatcher 与通用 send_to_session 复用。 */
export interface AcceptedCallbackLogger {
  warn: (message: string, meta?: Record<string, unknown>) => void;
}

/**
 * accepted 回调用来要求「**别派发这一轮**」的信号。
 *
 * 这个回调跑在 vendor dispatch **之前**(coordinator 的 onPersisted 链),所以它是排队方
 * 唯一能拦下派发的时机。但普通异常在这里是刻意被吞掉的 —— 见 runAcceptedCallback 的
 * 契约:副作用失败不该连带毁掉一次已经受理的 turn。于是"取消派发"这个意图必须走一条
 * 独立通道,否则会被当成副作用失败吞掉、turn 照样发出去
 * (review #944 第十一轮 P1:调度心跳已顺延/终止,prompt 却脱离 run 继续执行烧 token)。
 */
export class AcceptedCallbackDispatchCancelled extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AcceptedCallbackDispatchCancelled';
  }
}

/**
 * 运行已通过 vendor accepted 边界的业务副作用；副作用失败只记日志，不回滚已派发 turn。
 * 唯一例外是 AcceptedCallbackDispatchCancelled:那不是副作用失败,而是"取消本次派发"的
 * 明确请求,必须原样上抛让调用方回滚。
 */
export async function runAcceptedCallback(
  callback: (() => void | Promise<void>) | undefined,
  sessionId: string,
  clientId: string,
  log: AcceptedCallbackLogger = defaultLog,
): Promise<void> {
  if (!callback) return;
  try {
    await callback();
  } catch (err) {
    if (err instanceof AcceptedCallbackDispatchCancelled) {
      log.warn('accepted callback cancelled this dispatch', {
        sessionId,
        clientId,
        err: err.message,
      });
      throw err;
    }
    log.warn('accepted callback failed', {
      sessionId,
      clientId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/** 派发被取消或失败后回滚已经执行过的 accepted 副作用；回滚失败同样只记日志。 */
export async function runAcceptedRollback(
  callback: (() => void | Promise<void>) | undefined,
  sessionId: string,
  clientId: string,
  log: AcceptedCallbackLogger = defaultLog,
): Promise<void> {
  if (!callback) return;
  try {
    await callback();
  } catch (err) {
    log.warn('accepted rollback failed', {
      sessionId,
      clientId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}
