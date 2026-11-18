/**
 * hook-control/feishuTurnCarrier.ts
 * ---------------------------------------------------------------------------
 * 官方飞书 / Lark 一轮的**消息载体**: 进度卡(`feishu-progress-ops-v1`)与不带附件的
 * 成功终稿(`feishu-final-ops-v1`)由本端排版、经 msg.op 驱动, 服务端只执行(核验这一轮
 * 属于本设备、把卡片发在这一轮的回复位置、登记归属)。
 *
 * **不另写一套排版**: 中间帧怎么截、长回复怎么分条、过程记录怎么折叠, 全部复用个人
 * 飞书 bot 的同一个 handle(@cindy/im `startFeishuTurnCarrier`); 本模块只把它的发送
 * 通道(`FeishuStreamingDeps`)落到 msg.op 上:
 *   - 建卡 / 更新进度卡 → `purpose: 'turn-progress'` 的 `send` / `edit`;
 *   - 终稿第 1 张 → `purpose: 'turn-final'`、`finalPart: 0`(服务端把它落在这一轮的进度卡
 *     上, 没有或改不了时新发); 其余各张 → `finalPart: n` 依次新发;
 *   - `action.text` 是序列化后的卡片 JSON, 不带 `tier` 与按钮。
 * 投递位置(私聊 / 群主会话 / 话题)由服务端按在途记录决定, 本端不给目标。
 *
 * 幂等: 建卡在拿到定案回执前沿用同一个 opId(服务端按 opId 去重, 飞书侧按它派生的 uuid
 * 去重), 不会多出一张进度卡。终稿段回执未知时同 opId 同内容有界重发对账, 仍没有完整
 * 确认就以 `clientFinal.complete=false` 交回服务端: 服务端撤掉本端另发的后续卡片并照旧
 * 自己发布完整终稿。失败 / 取消 / 带附件的轮次始终由服务端发布。
 */

import {
  makeMessageOp,
  MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE,
  MESSAGE_OP_ERROR_RATE_LIMITED,
  type MessageOpAction,
  type MessageOpPurpose,
  type MessageOpResultPayload,
} from '@cindy/slack-hook-protocol';
import { startFeishuTurnCarrier, type FeishuStreamingDeps } from '@cindy/im';

import {
  abortableSleep,
  isMsgOpOutcomeUnknown,
  isMsgOpStopCode,
  MSG_OP_UNKNOWN_REPLAYS,
  TELEGRAM_OP_MARKER,
  type MsgOpResultRouter,
  type MsgOpSendFn,
} from './telegramMsgOp.js';
import {
  isClientFinalEligible,
  type ClientFinalInput,
  type OfficialTelegramTurnCarrier,
} from './telegramTurnCarrier.js';

/**
 * 包含等待在途进度与全部终稿卡片。超时交回服务端按 turn.end 发布, 不让一次慢发布挡住
 * 这一轮的收口和同一任务的下一轮。
 */
const CLIENT_FINAL_TIMEOUT_MS = 120_000;
/** 终稿卡片撞上限速时最多再试几次(按服务端给的等待时间)。 */
const FINAL_RATE_LIMIT_RETRIES = 3;
/** 单次限速等待的上限: 超过就不在本端硬等, 交回服务端。 */
const FINAL_RATE_LIMIT_MAX_WAIT_MS = 10_000;

/** msg.op 的失败回执: 只带诊断字段, 不带卡片内容。 */
class FeishuMsgOpError extends Error {
  readonly name = 'FeishuMsgOpError';
}

export interface OfficialFeishuTurnCarrierDeps {
  connectionId: string;
  requestId: string;
  externalKey: string;
  /** 该连接**当前**的发送函数; 断线时 undefined。每次出站现取, 不缓存旧 socket。 */
  getSend: () => MsgOpSendFn | undefined;
  router: MsgOpResultRouter;
  log: { info(msg: string): void; warn(msg: string): void };
  resultTimeoutMs?: number;
}

/** 一轮的官方飞书消息载体: msg.op 版发送通道 + 个人飞书 bot 同一个 handle。 */
export function createOfficialFeishuTurnCarrier(
  deps: OfficialFeishuTurnCarrierDeps,
): OfficialTelegramTurnCarrier {
  const { connectionId, requestId, externalKey, router, log } = deps;
  let closed = false;
  /** 服务端说这一轮的进度不归本端(只停进度; 终稿仍可由本端发布)。 */
  let progressStopped = false;
  /** 这一轮整体不归本端(已收口 / 不属于该设备 / 契约错误) —— 不再出站。 */
  let turnStopped = false;
  let progressSendSeq = 0;
  let progressEditSeq = 0;
  /**
   * 回执未知的进度卡首个 send。服务端按 opId + 内容指纹去重, 所以下一次 send 必须**原样**
   * 重发它(同 opId 同卡片)对账: 沿用 opId 换内容会被拒为 IDEMPOTENCY_CONFLICT, 换 opId 又
   * 可能多建一张。
   */
  let unresolvedProgressSend: { opId: string; action: MessageOpAction } | null = null;
  /** 每张终稿卡片的 opId 序号: 只在拿到明确失败后换号。 */
  const finalAttempt = new Map<number, number>();
  const abort = new AbortController();
  const sleep = abortableSleep(abort.signal);
  const isLive = (): boolean => !closed && !turnStopped;
  const isProgressLive = (): boolean => isLive() && !progressStopped;

  async function request(
    opId: string,
    purpose: MessageOpPurpose,
    action: MessageOpAction,
    finalPart?: number,
  ): Promise<MessageOpResultPayload | null> {
    if (purpose === 'turn-progress' ? !isProgressLive() : !isLive()) {
      throw new FeishuMsgOpError('feishu turn carrier is closed');
    }
    const send = deps.getSend();
    if (!send) throw new FeishuMsgOpError('feishu turn carrier is offline');
    const result = await router.request(
      connectionId,
      send,
      makeMessageOp({
        opId,
        requestId,
        scope: { externalKey },
        purpose,
        ...(finalPart !== undefined ? { finalPart } : {}),
        action,
      }),
      opId,
      deps.resultTimeoutMs,
    );
    if (result && !result.ok) {
      // 只记诊断字段, 不写卡片内容或服务端原始错误。
      log.warn(
        `feishu msg.op rejected: requestId=${requestId} purpose=${purpose} action=${action.kind} code=${result.errorCode ?? 'none'} channelCode=${result.channelErrorCode ?? 'none'} retryAfterMs=${result.retryAfterMs ?? 'none'}`,
      );
    }
    return result;
  }

  /** 定案的失败回执: 停手码让本轮停止出站, 其余只让这一次失败。 */
  function failed(result: MessageOpResultPayload): FeishuMsgOpError {
    if (result.errorCode === MESSAGE_OP_ERROR_PROGRESS_UNAVAILABLE) {
      progressStopped = true;
      log.info(`feishu progress ops unavailable for ${requestId}; leaving progress to the server`);
    } else if (isMsgOpStopCode(result)) {
      turnStopped = true;
      log.info(
        `feishu turn ops stopped for ${requestId} (${result.errorCode}); leaving the rest to the server`,
      );
    }
    return new FeishuMsgOpError(
      `feishu msg.op ${result.opId} failed: ${result.errorCode ?? result.channelErrorCode ?? 'unknown'}`,
    );
  }

  const messageIdOf = (result: MessageOpResultPayload, what: string): string => {
    const id = result.messageId ?? null;
    if (id !== null) return id;
    // 违约回执: 没有 messageId 就无法更新这张卡, 再发只会多建卡片。本轮停手。
    turnStopped = true;
    log.warn(`feishu ${what} for ${requestId} succeeded without a messageId; stopping`);
    throw new FeishuMsgOpError(`feishu ${what} returned no messageId`);
  };

  async function progressOp(requested: MessageOpAction): Promise<MessageOpResultPayload> {
    let opId: string;
    let action = requested;
    if (requested.kind === 'send') {
      if (unresolvedProgressSend !== null) {
        ({ opId, action } = unresolvedProgressSend);
      } else {
        opId = `${requestId}${TELEGRAM_OP_MARKER.progress}send:${progressSendSeq}`;
        unresolvedProgressSend = { opId, action };
      }
    } else {
      opId = `${requestId}${TELEGRAM_OP_MARKER.progress}edit:${++progressEditSeq}`;
    }
    const result = await request(opId, 'turn-progress', action);
    // 回执未知: send 保持 unresolvedProgressSend, 下一帧原样重发对账。
    if (isMsgOpOutcomeUnknown(result)) {
      throw new FeishuMsgOpError(`feishu msg.op ${opId} outcome unknown`);
    }
    const settled = result!;
    if (action.kind === 'send') {
      unresolvedProgressSend = null;
      if (!settled.ok) progressSendSeq += 1;
    }
    if (settled.ok) return settled;
    throw failed(settled);
  }

  /**
   * 终稿卡片: 回执未知时同 opId 同内容有界重发对账(服务端有应答就回显原结果, 不会多出
   * 一张); 撞限速按服务端给的时间等一等再发; 其余明确失败直接交回服务端。
   */
  async function finalOp(part: number, card: unknown): Promise<MessageOpResultPayload> {
    const action: MessageOpAction = { kind: 'send', text: JSON.stringify(card) };
    for (let rateLimited = 0; ; rateLimited += 1) {
      const attempt = finalAttempt.get(part) ?? 0;
      const opId = `${requestId}${TELEGRAM_OP_MARKER.final}${part}:${attempt}`;
      let result = await request(opId, 'turn-final', action, part);
      for (
        let replay = 0;
        isMsgOpOutcomeUnknown(result) && replay < MSG_OP_UNKNOWN_REPLAYS && isLive();
        replay += 1
      ) {
        result = await request(opId, 'turn-final', action, part);
      }
      if (isMsgOpOutcomeUnknown(result)) {
        throw new FeishuMsgOpError(`feishu msg.op ${opId} outcome unknown`);
      }
      const settled = result!;
      if (settled.ok) return settled;
      finalAttempt.set(part, attempt + 1);
      const wait = settled.retryAfterMs;
      if (
        settled.errorCode !== MESSAGE_OP_ERROR_RATE_LIMITED ||
        typeof wait !== 'number' ||
        wait > FINAL_RATE_LIMIT_MAX_WAIT_MS ||
        rateLimited >= FINAL_RATE_LIMIT_RETRIES
      ) {
        throw failed(settled);
      }
      await sleep(wait);
      if (!isLive()) throw new FeishuMsgOpError('feishu turn carrier is closed');
    }
  }

  const streamingDeps: FeishuStreamingDeps = {
    isCurrent: isLive,
    async createCard(card) {
      const text = JSON.stringify(card);
      const pending = unresolvedProgressSend?.action;
      // 对账重发的是更早那一帧: 拿到消息号后补一次更新到这一帧, 失败交给下一帧。
      const replayedOlderFrame = pending?.kind === 'send' && pending.text !== text;
      const result = await progressOp({ kind: 'send', text });
      const messageId = messageIdOf(result, 'progress card');
      if (replayedOlderFrame) {
        await progressOp({ kind: 'edit', messageId, text }).catch(() => undefined);
      }
      return messageId;
    },
    async updateCard(messageId, card) {
      await progressOp({ kind: 'edit', messageId, text: JSON.stringify(card) });
    },
    // 终稿第 1 张落在哪张卡上由服务端决定(这一轮的进度卡, 没有或改不了时新发): 本端
    // 可能不知道卡片号(建卡回执未知), 也不该替服务端判断卡片还能不能改。
    async putFinalHead(_messageId, card) {
      return messageIdOf(await finalOp(0, card), 'final card');
    },
    async sendFinalPart(index, card) {
      await finalOp(index, card);
    },
    // 空结果不由本端发布(isClientFinalEligible): 服务端按 turn.end 撤回进度卡。
    recallEmpty: async () => undefined,
    // 没有完整送达时不在这里另发说明: turn.end 带 complete=false, 服务端会发布完整终稿。
    sendNotice: async () => undefined,
    log: {
      debug: () => undefined,
      warn: (message) => log.warn(message),
      error: (message) => log.warn(message),
    },
  };
  const carrier = startFeishuTurnCarrier(streamingDeps);

  const close = (): void => {
    if (closed) return;
    closed = true;
    abort.abort();
    carrier.close();
  };

  return {
    update(markdown) {
      if (!isProgressLive()) return;
      carrier.replace(markdown);
    },
    // 不由本端发布终稿时直接停下, 不冲刷最后一帧: 服务端随后按 turn.end 改写同一张卡,
    // 一帧迟到的进度不值得去和终稿抢先后。
    finish: close,
    async publishFinal(input: ClientFinalInput) {
      if (closed || turnStopped || !isClientFinalEligible(input)) {
        close();
        return false;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => {
          // 先关闭载体并唤醒等待, 迟到回执不得在服务端接管后再发卡片。
          close();
          log.warn(
            `feishu client final for ${requestId} timed out after ${CLIENT_FINAL_TIMEOUT_MS}ms; handing back to the server`,
          );
          resolve(false);
        }, CLIENT_FINAL_TIMEOUT_MS);
        timer.unref?.();
      });
      try {
        return await Promise.race([
          carrier
            .finalize(input.finalText, input.process ? { process: input.process } : undefined)
            .then((delivered) => delivered && isLive()),
          deadline,
        ]);
      } catch (err) {
        log.warn(
          `feishu client final for ${requestId} not confirmed; handing back to the server: ${err instanceof Error ? err.message : String(err)}`,
        );
        return false;
      } finally {
        clearTimeout(timer);
        close();
      }
    },
    close,
  };
}
