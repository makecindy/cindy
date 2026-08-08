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
  /** 账号切换 / 销毁: 清掉待补发与可回落表。 */
  reset(): void;
}

/**
 * `react` 的三种去向。
 *
 * `skipped` 与 `failed` 必须分开: 前者是「本来就不该发」(老 server、off 档、
 * 没有 triggerMessageId), 后者是「该发但没送出去」—— 只有后者要留着重连补发。
 */
type ReactOutcome = 'sent' | 'skipped' | 'failed';

export function createAckReactions(deps: {
  serverFeatures: ReadonlyMap<string, readonly string[]>;
  /**
   * 当前生效的表情档位。服务端经 provider.behavior.state 下发。
   *
   * 返回 `null` = **有效值还不知道**(连接刚起、还没收到 behavior.state)。这时
   * 一帧都不发: 拿基线先斩后奏, 设置里关掉表情的用户会在每次重启后又被打一次。
   * 整个 getter 缺席才按协议基线(minimal)—— 那是「没有这套配置」的语境。
   */
  emojiReactions?: () => TelegramEmojiReactions | null;
  /** 测试注入随机源, 让 expressive 档可确定化。 */
  random?: () => number;
  log: { info(msg: string): void; warn(msg: string): void };
}): AckReactions {
  const { serverFeatures, log } = deps;
  const modeOf = (): TelegramEmojiReactions | null =>
    deps.emojiReactions === undefined
      ? DEFAULT_TELEGRAM_BEHAVIOR.emojiReactions
      : deps.emojiReactions();
  const random = deps.random ?? Math.random;

  /**
   * 曾经宣告过 msg-op-v1 的连接。
   *
   * 断线时 serverFeatures 会被清掉(那是对的 —— 滚动发布后重连可能落到不支持的
   * 实例上, 不能拿旧快照发帧)。但「刚断线」与「老 server 从来不支持」是两回事:
   * 前者的终态表情要进待补发队列, 后者一帧都不该有。靠这张表区分。
   */
  const everSupported = new Set<string>();

  function supports(connectionId: string): boolean {
    const features = serverFeatures.get(connectionId);
    // 快照缺席 = 这条连接当前离线(断线时会清), 不是「服务端说了不支持」。
    if (features === undefined) return false;
    const ok = features.includes(HOOK_FEATURE_MESSAGE_OPS);
    if (ok) everSupported.add(connectionId);
    // 新 welcome 明确没有这条能力(滚动发布重连到旧节点): 撤销放行。继续往旧
    // 节点发未协商的 msg.op 可能被拒, 甚至触发再次断连。
    else everSupported.delete(connectionId);
    return ok;
  }

  function react(
    task: AckReactionTask,
    suffix: 'ack' | 'final' | 'final-fallback',
    emoji: string,
    send: (m: HookMessage) => boolean,
  ): ReactOutcome {
    if (task.triggerMessageId === null) return 'skipped';
    // 断线时能力快照已被清 —— 那条连接曾经支持过就照常尝试, 让失败落进待补发。
    if (!supports(task.connectionId) && !everSupported.has(task.connectionId)) return 'skipped';
    const mode = modeOf();
    // 有效档位还没到 —— 一帧不发, 等下一个任务。
    if (mode === null) return 'skipped';
    // off 档一个表情都不发(含 👀 ack 与终态)—— 与个人 bot 的 off 同语义。
    // 但**撤销**(空串)不受此限: 它正是「把已经打出去的那个收掉」。
    if (mode === 'off' && emoji !== '') return 'skipped';
    return send(
      makeMessageOp({
        opId: `${task.requestId}:${suffix}`,
        requestId: task.requestId,
        scope: { externalKey: task.externalKey },
        action: { kind: 'react', targetMessageId: task.triggerMessageId, emoji },
      }),
    )
      ? 'sent'
      : 'failed';
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
  /**
   * 已经真的打出过 👀 的任务(requestId)。
   *
   * 用户可以在任务跑到一半时把表情改成 off。那之后终态按 off 什么都不发, 那条
   * 消息就会永远挂着 👀 显示在处理中 —— 所以得记住谁欠一个收口。
   */
  const acked = new Set<string>();

  return {
    supports,
    reset() {
      pendingFinals.clear();
      retryables.clear();
      everSupported.clear();
      acked.clear();
    },
    onReconnected(connectionId, send) {
      const features = serverFeatures.get(connectionId);
      const capable = features?.includes(HOOK_FEATURE_MESSAGE_OPS) === true;
      if (capable) everSupported.add(connectionId);
      // 「新 welcome 里明确没有这条能力」是**确定性**降级(滚动发布落到旧节点):
      // 待补发留着也永远发不出去, 作废。而能力快照还没到只是「这一刻还不知道」
      // —— 那时必须留着, 否则一次时序抖动就把待补发全丢了。
      const definitelyIncapable = features !== undefined && !capable;
      if (definitelyIncapable) everSupported.delete(connectionId);
      for (const [opId, entry] of [...pendingFinals]) {
        if (entry.task.connectionId !== connectionId) continue;
        if (!capable) {
          if (definitelyIncapable) pendingFinals.delete(opId);
          continue;
        }
        pendingFinals.delete(opId);
        const outcome = react(entry.task, 'final', entry.emoji, send);
        // 补发时 socket 又断了 —— 放回去等下一次重连, 否则那条消息永远挂着 👀。
        if (outcome === 'failed') pendingFinals.set(opId, entry);
        else if (outcome === 'sent' && modeOf() === 'expressive') {
          retryables.set(opId, { task: entry.task, failed: entry.failed });
        }
      }
    },
    onAccepted(task, send) {
      // 受理的 👀 发不出去就算了: 补一个迟到的「正在做」只会更奇怪, 而终态会
      // 在重连后补上, 消息不会永远停在处理中。
      if (react(task, 'ack', ACK_EMOJI, send) === 'sent') acked.add(task.requestId);
    },
    onFinished(task, status, send) {
      const failed = status === 'error';
      const mode = modeOf();
      const hadAck = acked.delete(task.requestId);
      // 任务跑到一半用户把表情关了: 没打过 👀 就什么都不做(用户要的就是「别打」),
      // 打过就必须收掉 —— 撤销(空串)而不是补一个终态, 否则等于无视用户的选择。
      if (mode === 'off' && !hadAck) return;
      // expressive 只影响**终态**: ack 恒为 👀(与个人 bot 一致 —— 生动档也不
      // 拿开场表情做文章), 正负池分开取, 成功不会随机出 👎 一类。
      const emoji =
        mode === 'off'
          ? ''
          : mode === 'expressive'
            ? pickExpressiveReaction(failed ? EXPRESSIVE_ERROR_POOL : EXPRESSIVE_DONE_POOL, random)
            : failed
              ? FAIL_EMOJI
              : OK_EMOJI;
      const outcome = react(task, 'final', emoji, send);
      if (outcome === 'sent') {
        if (mode === 'expressive') retryables.set(`${task.requestId}:final`, { task, failed });
      } else if (outcome === 'failed') {
        // 送不出去(断线)就记下来, 重连时补 —— 否则那条消息永远挂着 👀。
        pendingFinals.set(`${task.requestId}:final`, { task, emoji, failed });
      }
    },
    onResult(payload, sendFor) {
      // 成功即出表 —— 否则每个跑完的任务都会在回落表里留一条, 只涨不落。
      if (payload.ok) {
        retryables.delete(payload.opId);
        return;
      }
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
