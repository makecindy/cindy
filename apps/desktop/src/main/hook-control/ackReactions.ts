/**
 * hook-control/ackReactions.ts — 官方 bot 的 ack 表情。
 * ---------------------------------------------------------------------------
 * 个人 Telegram bot 一直有这个动作: 收到消息先打 👀 表示「看到了, 在做」, 跑完
 * 换成 👍 / 👎。官方 bot 没有 —— 用户在两个 bot 之间切换时, 这是最先被察觉的
 * 差异之一(消息发出去后, 到第一条回复落地之前, 官方 bot 那边什么反馈都没有)。
 *
 * 补上它靠的是 msg.op(#1855 第二刀): 客户端说「给这条消息打这个表情」, 服务端
 * 只做授权与执行。这也是 msg.op 的第一个真实使用点 —— 刻意挑了一个**纯增量、
 * 失败无害**的动作打通链路: 表情没打上不影响任何消息、任何任务。
 *
 * 幂等键直接用 requestId 派生(`<requestId>:ack` / `<requestId>:final`)。断连
 * 重发时同一个动作天然拿到同一个 opId, 不需要额外记账 —— Telegram 没有发送端
 * 幂等键, opId 是服务端去重的唯一依据。
 */

import {
  DEFAULT_TELEGRAM_BEHAVIOR,
  HOOK_FEATURE_MESSAGE_OPS,
  makeMessageOp,
  type HookMessage,
  type MessageOpResultPayload,
  type TelegramEmojiReactions,
} from '@cindy/slack-hook-protocol';
import {
  EXPRESSIVE_DONE_POOL,
  EXPRESSIVE_ERROR_POOL,
  pickExpressiveReaction,
} from '@cindy/im';

/** minimal 档 —— 与个人 bot 逐个对齐, 两个 bot 的表情语义不该各说各话。 */
const ACK_EMOJI = '👀';
const OK_EMOJI = '👍';
const FAIL_EMOJI = '👎';

export interface AckReactionTask {
  connectionId: string;
  requestId: string;
  externalKey: string;
  /** 触发本任务的渠道消息 id; 缺省 = 老 server 没下发, 本模块整体跳过。 */
  triggerMessageId: string | null;
}

export interface AckReactions {
  /** 任务被接下: 打 👀。 */
  onAccepted(task: AckReactionTask, send: (m: HookMessage) => boolean): void;
  /** 任务收口: 换成 👍 / 👎。cancelled 与 ok 同档 —— 用户主动停止不是失败。 */
  onFinished(
    task: AckReactionTask,
    status: 'ok' | 'error' | 'cancelled',
    send: (m: HookMessage) => boolean,
  ): void;
  /** 服务端回执。表情是纯装饰, 失败只记一行, 不重试、不影响任务。 */
  onResult(payload: MessageOpResultPayload): void;
  /** 该连接握手时宣告了 msg-op-v1 吗(缺席 = 老 server, 整体不发)。 */
  supports(connectionId: string): boolean;
}

export function createAckReactions(deps: {
  serverFeatures: ReadonlyMap<string, readonly string[]>;
  /**
   * 当前生效的表情档位。服务端经 provider.behavior.state 下发, 尚未到达时按
   * 协议基线(minimal)——与个人 bot 出厂行为同值。
   */
  emojiReactions?: () => TelegramEmojiReactions;
  /** 测试注入随机源, 让 expressive 档可确定化。 */
  random?: () => number;
  log: { info(msg: string): void; warn(msg: string): void };
}): AckReactions {
  const { serverFeatures, log } = deps;
  const modeOf = (): TelegramEmojiReactions =>
    deps.emojiReactions?.() ?? DEFAULT_TELEGRAM_BEHAVIOR.emojiReactions;
  const random = deps.random ?? Math.random;

  function supports(connectionId: string): boolean {
    return serverFeatures.get(connectionId)?.includes(HOOK_FEATURE_MESSAGE_OPS) === true;
  }

  function react(
    task: AckReactionTask,
    suffix: 'ack' | 'final',
    emoji: string,
    send: (m: HookMessage) => boolean,
  ): void {
    if (task.triggerMessageId === null) return;
    if (!supports(task.connectionId)) return;
    // off 档一个表情都不发(含 👀 ack 与终态)—— 与个人 bot 的 off 同语义。
    if (modeOf() === 'off') return;
    // 发不出去就算了: 表情是「正在做」的提示, 补发一个迟到的 👀 只会更奇怪。
    // 任务本身的送达由 turn.end 的 outbox 保证, 与这里无关。
    send(
      makeMessageOp({
        opId: `${task.requestId}:${suffix}`,
        requestId: task.requestId,
        scope: { externalKey: task.externalKey },
        action: { kind: 'react', targetMessageId: task.triggerMessageId, emoji },
      }),
    );
  }

  return {
    supports,
    onAccepted(task, send) {
      react(task, 'ack', ACK_EMOJI, send);
    },
    onFinished(task, status, send) {
      const failed = status === 'error';
      // expressive 只影响**终态**: ack 恒为 👀(与个人 bot 一致 —— 生动档也不
      // 拿开场表情做文章), 正负池分开取, 成功不会随机出 👎 一类。
      const emoji =
        modeOf() === 'expressive'
          ? pickExpressiveReaction(failed ? EXPRESSIVE_ERROR_POOL : EXPRESSIVE_DONE_POOL, random)
          : failed
            ? FAIL_EMOJI
            : OK_EMOJI;
      react(task, 'final', emoji, send);
    },
    onResult(payload) {
      if (payload.ok) return;
      log.warn(`msg.op ${payload.opId} failed: ${payload.error ?? 'unknown'}`);
    },
  };
}
