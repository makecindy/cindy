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
  /**
   * 服务端回执。
   *
   * 失败分两类: 表情本身被拒(比如群限制了可用表情)会用基础款重试一次; 其余
   * 只记一行 —— 表情是装饰, 不影响任务。
   */
  onResult(
    payload: MessageOpResultPayload,
    sendFor?: (connectionId: string) => ((m: HookMessage) => boolean) | undefined,
  ): void;
  /**
   * 连接恢复。断线时发不出去的**终态**表情在这里补发 —— 不补的话那条消息会
   * 永远挂着 👀。受理的 👀 过期不补(迟到的「正在做」只会更奇怪)。
   */
  onReconnected(connectionId: string, send: (m: HookMessage) => boolean): void;
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

  /** 返回是否真的送出去了 —— 终态送不出去要留着重连补发。 */
  function react(
    task: AckReactionTask,
    suffix: 'ack' | 'final' | 'final-fallback',
    emoji: string,
    send: (m: HookMessage) => boolean,
  ): boolean {
    if (task.triggerMessageId === null) return true;
    if (!supports(task.connectionId)) return true;
    // off 档一个表情都不发(含 👀 ack 与终态)—— 与个人 bot 的 off 同语义。
    if (modeOf() === 'off') return true;
    // 发不出去就算了: 表情是「正在做」的提示, 补发一个迟到的 👀 只会更奇怪。
    // 任务本身的送达由 turn.end 的 outbox 保证, 与这里无关。
    return send(
      makeMessageOp({
        opId: `${task.requestId}:${suffix}`,
        requestId: task.requestId,
        scope: { externalKey: task.externalKey },
        action: { kind: 'react', targetMessageId: task.triggerMessageId, emoji },
      }),
    );
  }

  /**
   * 断线时没发出去的终态表情。key 用 opId —— 同一个动作重发拿同一个幂等键,
   * 服务端据此去重, 补发不会打出第二个表情。
   */
  const pendingFinals = new Map<
    string,
    { task: AckReactionTask; emoji: string; failed: boolean }
  >();
  /**
   * 可回落的终态表情: opId → 该轮的任务与成败。
   *
   * 只有 expressive 档进这张表 —— 基础款 👍/👎 是 Telegram 的默认可用集, 被拒
   * 也没有更基础的可退。
   */
  const retryables = new Map<string, { task: AckReactionTask; failed: boolean }>();

  return {
    supports,
    onReconnected(connectionId, send) {
      for (const [opId, entry] of [...pendingFinals]) {
        if (entry.task.connectionId !== connectionId) continue;
        pendingFinals.delete(opId);
        if (react(entry.task, 'final', entry.emoji, send) && modeOf() === 'expressive') {
          retryables.set(opId, { task: entry.task, failed: entry.failed });
        }
      }
    },
    onAccepted(task, send) {
      // 受理的 👀 发不出去就算了: 补一个迟到的「正在做」只会更奇怪, 而终态会
      // 在重连后补上, 消息不会永远停在处理中。
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
      if (react(task, 'final', emoji, send)) {
        if (modeOf() === 'expressive') {
          retryables.set(`${task.requestId}:final`, { task, failed });
        }
      } else {
        // 送不出去(断线)就记下来, 重连时补 —— 否则那条消息永远挂着 👀。
        pendingFinals.set(`${task.requestId}:final`, { task, emoji, failed });
      }
    },
    onResult(payload, sendFor) {
      if (payload.ok) return;
      const retry = retryables.get(payload.opId);
      // 用这一轮自己记下的 connectionId 取发送函数 —— 不猜「当前哪条连接」。
      const send = retry !== undefined ? sendFor?.(retry.task.connectionId) : undefined;
      if (retry !== undefined && send !== undefined) {
        // 群可以限制 available_reactions —— expressive 随机出的那款可能不在名单
        // 里。回落基础款并换一个幂等键(服务端按 opId 去重, 沿用旧键会被当成重复
        // 直接返回上一次的失败)。只回落一次, 基础款再被拒就认了。
        retryables.delete(payload.opId);
        const fallback = retry.failed ? FAIL_EMOJI : OK_EMOJI;
        log.info(`msg.op ${payload.opId} reaction rejected; retrying with the base emoji`);
        react(retry.task, 'final-fallback', fallback, send);
        return;
      }
      log.warn(`msg.op ${payload.opId} failed: ${payload.error ?? 'unknown'}`);
    },
  };
}
