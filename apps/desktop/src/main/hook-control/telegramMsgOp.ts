/**
 * hook-control/telegramMsgOp.ts
 * ---------------------------------------------------------------------------
 * 官方 Telegram 由本端驱动的 msg.op(进度 / 终稿 / 交互卡)共用的传输小件:
 *   - 请求/回执配对(MsgOpResultRouter): 回执按 opId 路由回等待方, 发不出去 /
 *     超时 / 断线都以 null(回执未知)收口, 绝不悬挂;
 *   - 失败映射(TelegramMsgOpError): 把 msg.op.result 映射成与 Bot API
 *     `TelegramApiError` 同形的错误, 让 @cindy/im `outboundPolicy` 的判据
 *     (HTML 400 回落 / not modified / 429 退避)对两个 bot 原样生效;
 *   - opId 命名: 由 requestId 派生, 带用途标记, dispatcher 据此把回执只路由给
 *     这些模块(不落到 ack 表情的失败日志里)。
 *
 * 不持有任何一轮的状态 —— 每轮的状态在 telegramTurnCarrier / telegramCardOps 里。
 */

import {
  MESSAGE_OP_ERROR_BINDING_REVOKED,
  MESSAGE_OP_ERROR_MESSAGE_NOT_OWNED,
  MESSAGE_OP_ERROR_OUTCOME_UNKNOWN,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_RATE_LIMITED,
  MESSAGE_OP_ERROR_TURN_UNAVAILABLE,
  MESSAGE_OP_ERROR_UNSUPPORTED_PARAMETERS,
  type HookMessage,
  type MessageOpResultPayload,
} from '@cindy/slack-hook-protocol';

/** 等 msg.op.result 的时限; 过时按"回执未知"处理。 */
export const TELEGRAM_MSG_OP_RESULT_TIMEOUT_MS = 30_000;

/** 本端派生的 opId 用途标记: `<requestId>:<marker>...`。 */
export const TELEGRAM_OP_MARKER = {
  progress: ':progress:',
  final: ':final:',
  card: ':card:',
} as const;

/** 这条回执属于本端驱动的某一轮 msg.op(进度 / 终稿 / 卡片)吗。 */
export function isTelegramTurnOpId(opId: string): boolean {
  return Object.values(TELEGRAM_OP_MARKER).some((marker) => opId.includes(marker));
}

export type MsgOpSendFn = (m: HookMessage) => boolean;

/**
 * msg.op 请求/回执配对。dispatcher 持有一份, 所有轮次共用。
 */
export interface MsgOpResultRouter {
  request(
    connectionId: string,
    send: MsgOpSendFn,
    message: HookMessage,
    opId: string,
    timeoutMs?: number,
  ): Promise<MessageOpResultPayload | null>;
  /** 回执入口; 有人在等这个 opId 返回 true。 */
  settle(payload: MessageOpResultPayload): boolean;
  /** 连接断开: 该连接上在等的回执不会再来。 */
  failConnection(connectionId: string): void;
  /** 账号切换 / dispose。 */
  failAll(): void;
}

export function createMsgOpResultRouter(): MsgOpResultRouter {
  const waiters = new Map<
    string,
    { connectionId: string; settle: (r: MessageOpResultPayload | null) => void }
  >();
  return {
    request(connectionId, send, message, opId, timeoutMs = TELEGRAM_MSG_OP_RESULT_TIMEOUT_MS) {
      return new Promise((resolve) => {
        // 同一 opId 的旧等待方(幂等重发)以"未知"让位: 回执只会来一次, 归最新的等待方。
        waiters.get(opId)?.settle(null);
        const timer = setTimeout(() => settle(null), timeoutMs);
        timer.unref?.();
        const settle = (result: MessageOpResultPayload | null): void => {
          clearTimeout(timer);
          if (waiters.get(opId)?.settle === settle) waiters.delete(opId);
          resolve(result);
        };
        waiters.set(opId, { connectionId, settle });
        let transmitted = false;
        try {
          transmitted = send(message);
        } catch {
          transmitted = false;
        }
        if (!transmitted) settle(null);
      });
    },
    settle(payload) {
      const waiter = waiters.get(payload.opId);
      if (!waiter) return false;
      waiter.settle(payload);
      return true;
    },
    failConnection(connectionId) {
      for (const waiter of [...waiters.values()]) {
        if (waiter.connectionId === connectionId) waiter.settle(null);
      }
    },
    failAll() {
      for (const waiter of [...waiters.values()]) waiter.settle(null);
    },
  };
}

/**
 * msg.op 失败, 与 Bot API `TelegramApiError` 同形: `errorCode` = Telegram 原生
 * error_code(服务端透传), `message` 含 Telegram 原文。回执未知时**不带** errorCode
 * —— 那时不能判断 Telegram 是否已接收, 任何回落都不该触发。
 */
export class TelegramMsgOpError extends Error {
  readonly name = 'TelegramMsgOpError';
  constructor(
    message: string,
    readonly errorCode?: number,
    readonly retryAfterSec?: number,
    /** 服务端自己判定的结构化拒绝码(未调 Bot API)。 */
    readonly serverCode?: string,
  ) {
    super(message);
  }
}

/**
 * 回执未知时同 opId、同内容最多原样重发几次(卡片与终稿段共用)。服务端拿到过 Telegram
 * 应答的, 重发只回显原结果(对上账、不重复); 服务端也没应答的, 每个 opId 只重新执行一次,
 * 之后回显缓存的 OUTCOME_UNKNOWN。仍未知就按各自路径放弃。
 */
export const MSG_OP_UNKNOWN_REPLAYS = 2;

/** 回执未知: 没收到 / 超时 / 断线, 或服务端明说调用结果未知。 */
export function isMsgOpOutcomeUnknown(result: MessageOpResultPayload | null): boolean {
  return result === null || result.errorCode === MESSAGE_OP_ERROR_OUTCOME_UNKNOWN;
}

/**
 * 服务端拒绝码里"本轮这类 op 别再发了"的那几种: 不归本端承载 / 契约错误 / 消息不归属 /
 * 绑定已撤。其余明确失败(IDEMPOTENCY_CONFLICT / CAPACITY_REACHED / PERSIST_FAILED /
 * 不认识的码)只让这一次失败。
 */
const STOP_CODES: ReadonlySet<string> = new Set([
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_TURN_UNAVAILABLE,
  MESSAGE_OP_ERROR_UNSUPPORTED_PARAMETERS,
  MESSAGE_OP_ERROR_MESSAGE_NOT_OWNED,
  MESSAGE_OP_ERROR_BINDING_REVOKED,
]);

export function isMsgOpStopCode(result: MessageOpResultPayload): boolean {
  return typeof result.errorCode === 'string' && STOP_CODES.has(result.errorCode);
}

/** 失败回执 → 同形错误。服务端限速队列的拒收(RATE_LIMITED + retryAfterMs)与渠道 429 同一处理。 */
export function msgOpErrorFromResult(result: MessageOpResultPayload): TelegramMsgOpError {
  const rateLimited =
    result.errorCode === MESSAGE_OP_ERROR_RATE_LIMITED || typeof result.retryAfterMs === 'number';
  const errorCode =
    typeof result.channelErrorCode === 'number'
      ? result.channelErrorCode
      : rateLimited
        ? 429
        : undefined;
  const retryAfterSec =
    typeof result.retryAfterMs === 'number' ? result.retryAfterMs / 1000 : undefined;
  return new TelegramMsgOpError(
    `telegram msg.op ${result.opId} failed: ${errorCode ?? ''} ${result.error ?? result.errorCode ?? 'unknown'}`.trim(),
    errorCode,
    retryAfterSec,
    result.errorCode ?? undefined,
  );
}

/** 绑定在一个 AbortSignal 上的 sleep: abort 时提前 resolve(调用方醒来后自行复核)。 */
export function abortableSleep(signal: AbortSignal): (ms: number) => Promise<void> {
  return (ms) =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve();
      const timer = setTimeout(done, ms);
      timer.unref?.();
      function done(): void {
        signal.removeEventListener('abort', done);
        clearTimeout(timer);
        resolve();
      }
      signal.addEventListener('abort', done, { once: true });
    });
}
