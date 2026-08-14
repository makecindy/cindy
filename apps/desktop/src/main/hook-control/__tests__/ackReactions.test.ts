/**
 * 官方 bot ack 表情回归。
 *
 * 这是 msg.op 的第一个真实使用点, 刻意挑了一个纯增量、失败无害的动作打通链路。
 * 用例守三件事: 能力协商门控(老 server 一帧都不发)、幂等键稳定(断连重发不
 * 重复打表情)、以及表情语义与个人 bot 一致。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  HOOK_FEATURE_MESSAGE_OPS,
  type HookMessage,
  type TelegramEmojiReactions,
} from '@cindy/slack-hook-protocol';
import { EXPRESSIVE_DONE_POOL, EXPRESSIVE_ERROR_POOL } from '@cindy/im';

import { createAckReactions, type AckReactionTask } from '../ackReactions';

const CONN = 'telegram';
const TASK: AckReactionTask = {
  connectionId: CONN,
  requestId: 'req-1',
  externalKey: 'telegram:group:bot:-100200:user-7',
  triggerMessageId: '55',
};

function harness(
  features: readonly string[] = [HOOK_FEATURE_MESSAGE_OPS],
  emojiReactions: TelegramEmojiReactions | null = 'minimal',
  random: () => number = () => 0,
) {
  const sent: HookMessage[] = [];
  const send = vi.fn((m: HookMessage) => {
    sent.push(m);
    return true;
  });
  const warn = vi.fn();
  let mode = emojiReactions;
  const serverFeatures = new Map<string, readonly string[]>([[CONN, features]]);
  const reactions = createAckReactions({
    serverFeatures,
    emojiReactions: () => mode,
    random,
    log: { info: () => undefined, warn },
  });
  return {
    reactions,
    send,
    sent,
    warn,
    serverFeatures,
    /** 模拟用户中途改设置 / manager hydrate 落定。 */
    setMode(next: TelegramEmojiReactions | null) {
      mode = next;
    },
  };
}

function opOf(message: HookMessage): {
  opId: string;
  action: { kind: string; targetMessageId?: string; emoji?: string };
  scope: { externalKey: string };
} {
  expect(message.type).toBe('msg.op');
  return message.payload as never;
}

describe('官方 bot ack 表情', () => {
  it('受理时打 👀, 收口时换 👍 —— 与个人 bot 的 minimal 档同语义', () => {
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', h.send);
    expect(h.sent).toHaveLength(2);
    expect(opOf(h.sent[0]).action).toMatchObject({
      kind: 'react',
      targetMessageId: '55',
      emoji: '👀',
    });
    expect(opOf(h.sent[1]).action).toMatchObject({ emoji: '👍' });
  });

  it('失败收口换 👎; 用户主动取消不算失败, 仍是 👍', () => {
    const err = harness();
    err.reactions.onFinished(TASK, 'error', err.send);
    expect(opOf(err.sent[0]).action).toMatchObject({ emoji: '👎' });

    const cancelled = harness();
    cancelled.reactions.onFinished(TASK, 'cancelled', cancelled.send);
    expect(opOf(cancelled.sent[0]).action).toMatchObject({ emoji: '👍' });
  });

  it('幂等键由 requestId 派生 —— 断连重发不会重复打表情', () => {
    // Telegram 没有发送端幂等键, opId 是服务端去重的唯一依据; 从 requestId
    // 派生就天然稳定, 不需要额外记账。
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', h.send);
    expect(opOf(h.sent[0]).opId).toBe('req-1:ack');
    expect(opOf(h.sent[1]).opId).toBe('req-1:final');
  });

  it('老 server 没宣告 msg-op-v1 → 一帧都不发', () => {
    const old = harness([]);
    old.reactions.onAccepted(TASK, old.send);
    old.reactions.onFinished(TASK, 'ok', old.send);
    expect(old.send).not.toHaveBeenCalled();
    expect(old.reactions.supports(CONN)).toBe(false);
  });

  it('server 没下发触发消息 id → 跳过, 不猜一个 id', () => {
    const h = harness();
    h.reactions.onAccepted({ ...TASK, triggerMessageId: null }, h.send);
    expect(h.send).not.toHaveBeenCalled();
  });

  it('scope 只带 externalKey —— 寻址权在服务端', () => {
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    expect(opOf(h.sent[0]).scope).toEqual({ externalKey: TASK.externalKey });
  });

  describe('表情档位(与个人 bot 的三档同语义)', () => {
    it('off: 一个表情都不发, 含 👀 与终态', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'off');
      h.reactions.onAccepted(TASK, h.send);
      h.reactions.onFinished(TASK, 'ok', h.send);
      expect(h.send).not.toHaveBeenCalled();
    });

    it('minimal: 固定 👀 → 👍 / 👎', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'minimal');
      h.reactions.onAccepted(TASK, h.send);
      h.reactions.onFinished(TASK, 'error', h.send);
      expect(opOf(h.sent[0]).action.emoji).toBe('👀');
      expect(opOf(h.sent[1]).action.emoji).toBe('👎');
    });

    it('expressive: 终态取变体池, ack 仍是 👀 且正负池不串', () => {
      // 生动档也不拿开场表情做文章 —— 与个人 bot 一致。正负分开是底线:
      // 成功不能随机出 👎 一类。
      const ok = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0.5);
      ok.reactions.onAccepted(TASK, ok.send);
      ok.reactions.onFinished(TASK, 'ok', ok.send);
      expect(opOf(ok.sent[0]).action.emoji).toBe('👀');
      expect(EXPRESSIVE_DONE_POOL).toContain(opOf(ok.sent[1]).action.emoji);

      const failed = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0.5);
      failed.reactions.onFinished(TASK, 'error', failed.send);
      expect(EXPRESSIVE_ERROR_POOL).toContain(opOf(failed.sent[0]).action.emoji);
    });

    it('未收到服务端下发时按协议基线 minimal', () => {
      const sent: HookMessage[] = [];
      const reactions = createAckReactions({
        serverFeatures: new Map([[CONN, [HOOK_FEATURE_MESSAGE_OPS]]]),
        log: { info: () => undefined, warn: vi.fn() },
      });
      reactions.onFinished(TASK, 'ok', (m) => {
        sent.push(m);
        return true;
      });
      expect(opOf(sent[0]).action.emoji).toBe('👍');
    });
  });

  describe('断线与受限表情', () => {
    it('终态送不出去 → 重连时补发, 不让消息永远挂着 👀', () => {
      const h = harness();
      const offline = vi.fn(() => false);
      h.reactions.onAccepted(TASK, h.send);
      h.reactions.onFinished(TASK, 'ok', offline); // 断线
      expect(h.sent).toHaveLength(1); // 只有 👀

      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(2);
      expect(opOf(h.sent[1]).action.emoji).toBe('👍');
      // 幂等键不变 —— 服务端据此去重, 补发不会打出第二个表情。
      expect(opOf(h.sent[1]).opId).toBe('req-1:final');
    });

    it('补发只补自己那条连接的; 拿到成功回执前一直补, 拿到就停', () => {
      // send() 返回 true 只代表帧进了本地 ws 缓冲 —— socket 在 flush 前断开那一帧
      // 就没了, 而消息上还挂着 👀。所以收口的判据是**回执**, 不是「发出去了」。
      // opId 不变, 服务端按它去重, 重复补发不会打出第二个表情。
      const h = harness();
      h.reactions.onFinished(TASK, 'ok', vi.fn(() => false));
      h.reactions.onReconnected('another-conn', h.send);
      expect(h.send).not.toHaveBeenCalled();

      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(1);
      // 还没有回执 —— 再次重连仍然补, 用的是同一个幂等键。
      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(2);
      expect(opOf(h.sent[1]).opId).toBe('req-1:final');

      h.reactions.onResult({ opId: 'req-1:final', ok: true, messageId: '55' });
      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(2); // 收口了, 不再补
    });

    it('发出去但没等到回执 → 重连照样补(本地入队不算送达)', () => {
      const h = harness();
      h.reactions.onAccepted(TASK, h.send);
      h.reactions.onFinished(TASK, 'ok', h.send); // send 成功, 但没有回执
      expect(h.sent).toHaveLength(2);
      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(3);
      expect(opOf(h.sent[2]).opId).toBe('req-1:final');
    });

    it('服务端明确拒绝且无可回落 → 出表, 不反复重发', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'minimal');
      h.reactions.onFinished(TASK, 'ok', h.send);
      h.reactions.onResult({ opId: 'req-1:final', ok: false, error: 'message not in lane' });
      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(1);
      expect(h.warn).toHaveBeenCalled();
    });

    it('expressive 的表情被群拒绝 → 换新幂等键回落基础款', () => {
      // 群可以限制 available_reactions, 随机出的那款可能不在名单里。沿用旧
      // opId 会被服务端当成重复直接返回上一次的失败, 所以必须换键。
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0.5);
      h.reactions.onFinished(TASK, 'ok', h.send);
      const firstOpId = opOf(h.sent[0]).opId;
      h.reactions.onResult({ opId: firstOpId, ok: false, error: 'REACTION_INVALID' }, () => h.send);
      expect(h.sent).toHaveLength(2);
      expect(opOf(h.sent[1]).action.emoji).toBe('👍');
      expect(opOf(h.sent[1]).opId).toBe('req-1:final-fallback');
      expect(opOf(h.sent[1]).opId).not.toBe(firstOpId);
    });

    it('基础款再被拒就认了 —— 不无限回落', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0.5);
      h.reactions.onFinished(TASK, 'ok', h.send);
      const firstOpId = opOf(h.sent[0]).opId;
      h.reactions.onResult({ opId: firstOpId, ok: false, error: 'x' }, () => h.send);
      h.reactions.onResult(
        { opId: 'req-1:final-fallback', ok: false, error: 'x' },
        () => h.send,
      );
      expect(h.sent).toHaveLength(2);
    });

    it('成功回执后出回落表 —— 不让跑完的任务长期占着内存', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0.5);
      h.reactions.onFinished(TASK, 'ok', h.send);
      h.reactions.onResult({ opId: 'req-1:final', ok: true, messageId: '55' }, () => h.send);
      // 出表后再来一条同 opId 的失败回执, 不该再触发回落。
      h.reactions.onResult({ opId: 'req-1:final', ok: false, error: 'x' }, () => h.send);
      expect(h.sent).toHaveLength(1);
    });

    it('reset 清掉待补发与回落表(账号切换)', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0.5);
      h.reactions.onFinished(TASK, 'ok', vi.fn(() => false)); // 断线, 进待补发
      h.reactions.reset();
      h.reactions.onReconnected(CONN, h.send);
      expect(h.send).not.toHaveBeenCalled();
    });

    it('minimal 档的失败不回落 —— 基础款没有更基础的可退', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'minimal');
      h.reactions.onFinished(TASK, 'ok', h.send);
      h.reactions.onResult({ opId: 'req-1:final', ok: false, error: 'x' }, () => h.send);
      expect(h.sent).toHaveLength(1);
      expect(h.warn).toHaveBeenCalled();
    });
  });

  describe('档位未就绪与中途切换', () => {
    it('有效档位还不知道(null) → 一帧不发; 落定后照常', () => {
      // 连接就绪与「用户选的档位到达」之间有一段空窗。这段时间按基线发,
      // 关掉表情的用户每次重启都会又被打一次 —— 那正是本 PR 要修的 bug。
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], null);
      h.reactions.onAccepted(TASK, h.send);
      h.reactions.onFinished(TASK, 'ok', h.send);
      expect(h.send).not.toHaveBeenCalled();

      h.setMode('minimal');
      h.reactions.onAccepted(TASK, h.send);
      expect(opOf(h.sent[0]).action.emoji).toBe('👀');
    });

    it('打过 👀 之后用户切到 off → 撤销那个 👀, 不留在处理中', () => {
      // off 的语义是「别给我打表情」, 不是「把已经打上的留在那」。补一个终态
      // 表情同样违背用户的选择, 所以发空串(撤销)。
      const h = harness();
      h.reactions.onAccepted(TASK, h.send);
      h.setMode('off');
      h.reactions.onFinished(TASK, 'ok', h.send);
      expect(h.sent).toHaveLength(2);
      expect(opOf(h.sent[1]).action).toMatchObject({ targetMessageId: '55', emoji: '' });
    });

    it('全程 off → 收口时也什么都不发(没打过就没有要收的)', () => {
      const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'off');
      h.reactions.onAccepted(TASK, h.send);
      h.reactions.onFinished(TASK, 'ok', h.send);
      expect(h.send).not.toHaveBeenCalled();
    });
  });

  it('能力降级: 新 welcome 没有 msg-op-v1 → 新任务不发, 待补发也作废', () => {
    // 「离线」与「服务端说了不支持」是两回事: 前者要留着重连补, 后者继续发
    // 就是往旧节点丢它没协商过的帧, 可能被拒甚至触发再次断连。
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', vi.fn(() => false)); // 断线, 进待补发
    expect(h.sent).toHaveLength(1);

    h.serverFeatures.set(CONN, []); // 重连到不支持的旧节点
    h.reactions.onReconnected(CONN, h.send);
    expect(h.sent).toHaveLength(1); // 待补发被丢弃, 没往旧节点发
    h.reactions.onAccepted({ ...TASK, requestId: 'req-2' }, h.send);
    expect(h.sent).toHaveLength(1); // 新任务也不发
    expect(h.reactions.supports(CONN)).toBe(false);
  });

  it('断线期间切到 off → 重连补的是撤销, 不是原终态', () => {
    // 待补项存的是断线前按 minimal/expressive 算好的表情; off 下 react 会把它
    // 跳过, 于是每次重连都原样跳过 —— 👀 永久留在消息上, 表也永远不清。
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', vi.fn(() => false)); // 断线, 进待补发
    h.setMode('off'); // 重连之前用户把表情关了
    h.reactions.onReconnected(CONN, h.send);
    expect(h.sent).toHaveLength(2);
    expect(opOf(h.sent[1]).action).toMatchObject({ targetMessageId: '55', emoji: '' });
    // 撤销的回执到达即收口, 表不残留。
    h.reactions.onResult({ opId: 'req-1:final', ok: true, messageId: '55', error: null }, () => h.send);
    h.reactions.onReconnected(CONN, h.send);
    expect(h.sent).toHaveLength(2); // 没有再补
  });

  it('账号停用: 打过 👀 而终态没人发的任务, 停用时撤销那个 👀', () => {
    // 运行中的任务因账号代次失效跳过 onFinished, 排队任务被直接清 —— 直接
    // reset 会把欠账一笔勾销, 消息永远显示在处理中。
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    expect(h.sent).toHaveLength(1);
    h.reactions.onAccountTeardown(() => h.send);
    expect(h.sent).toHaveLength(2);
    // 撤销(空串), 不是装一个 👍 —— 任务没跑完。
    expect(opOf(h.sent[1]).action).toMatchObject({ targetMessageId: '55', emoji: '' });
    h.reactions.reset();
  });

  it('账号停用: 终态在途(没等到回执)的再发一次, 不静默丢', () => {
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', h.send); // sent, 但回执没来
    expect(h.sent).toHaveLength(2);
    h.reactions.onAccountTeardown(() => h.send);
    expect(h.sent).toHaveLength(3);
    expect(opOf(h.sent[2]).opId).toBe('req-1:final'); // 同 opId, 服务端幂等
    expect(opOf(h.sent[2]).action.emoji).toBe('👍');
    h.reactions.reset();
  });

  it('回落发(:final-fallback)进了待补发后, 重发保持原 opId', () => {
    // 换个后缀等于换幂等键: 服务端当成新操作再执行一遍, 回执的 opId 也对不上
    // 本地表, 那一项永远收不了口。
    const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0);
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', h.send);
    // expressive 被群限制拒掉 → 回落基础款(此时回落发在待补发表里, 键是 :final-fallback)
    h.reactions.onResult(
      { opId: 'req-1:final', ok: false, messageId: null, error: 'REACTION_INVALID' },
      () => h.send,
    );
    const fallbackIdx = h.sent.length - 1;
    expect(opOf(h.sent[fallbackIdx]).opId).toBe('req-1:final-fallback');
    // 回落发没等到回执就断线重连 → 补发用的必须还是 :final-fallback
    h.reactions.onReconnected(CONN, h.send);
    expect(opOf(h.sent[h.sent.length - 1]).opId).toBe('req-1:final-fallback');
    // 账号 teardown 的最后一发同样保持原 opId
    h.reactions.onAccountTeardown(() => h.send);
    const teardownOps = h.sent.slice(fallbackIdx + 1).map((m) => opOf(m).opId);
    expect(teardownOps).not.toContain('req-1:final');
    h.reactions.reset();
  });

  it('待收口表淘汰最旧项时, 同键的回落记录一起清', () => {
    // 服务端从此不回回执时, 只淘汰 pendingFinals 会让 expressive 的每个终态
    // 永久留在 retryables 里 —— 换一张表继续无界增长。
    const h = harness([HOOK_FEATURE_MESSAGE_OPS], 'expressive', () => 0);
    for (let i = 0; i < 501; i += 1) {
      const task = { ...TASK, requestId: `bulk-${i}` };
      h.reactions.onAccepted(task, h.send);
      h.reactions.onFinished(task, 'ok', h.send);
    }
    // 第 0 条被淘汰出待收口表后, 它的回落记录也不能再触发回落发。
    const before = h.sent.length;
    h.reactions.onResult(
      { opId: 'bulk-0:final', ok: false, messageId: null, error: 'REACTION_INVALID' },
      () => h.send,
    );
    expect(h.sent.length).toBe(before); // 没有回落发 = retryables 里已经没有它
    h.reactions.reset();
  });

  it('能力快照还没到时不丢待补发 —— 只有明确降级才作废', () => {
    // 「这一刻还不知道」与「服务端说了不支持」不能混同: 前者一次时序抖动就把
    // 待补发全丢了, 那条消息永远挂着 👀。
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', vi.fn(() => false)); // 断线, 进待补发
    h.serverFeatures.delete(CONN); // 快照还没到
    h.reactions.onReconnected(CONN, h.send);
    expect(h.sent).toHaveLength(1); // 没发, 但也没丢

    h.serverFeatures.set(CONN, [HOOK_FEATURE_MESSAGE_OPS]); // 快照到了
    h.reactions.onReconnected(CONN, h.send);
    expect(h.sent).toHaveLength(2);
    expect(opOf(h.sent[1]).action.emoji).toBe('👍');
  });

  it('补发时又断了 → 留着下次重连再补, 不丢', () => {
    // 先删后发、失败却不放回的话, 后续再重连便无内容可补, 消息永远挂着 👀。
    const h = harness();
    h.reactions.onAccepted(TASK, h.send);
    h.reactions.onFinished(TASK, 'ok', vi.fn(() => false));
    h.reactions.onReconnected(CONN, vi.fn(() => false)); // 补发时 socket 又关了
    expect(h.sent).toHaveLength(1);
    h.reactions.onReconnected(CONN, h.send);
    expect(h.sent).toHaveLength(2);
    expect(opOf(h.sent[1]).action.emoji).toBe('👍');
    expect(opOf(h.sent[1]).opId).toBe('req-1:final');
  });

  it('回执失败只记一行, 不抛不重试(表情是装饰, 不能影响任务)', () => {
    const h = harness();
    h.reactions.onResult({ opId: 'req-1:ack', ok: false, error: 'message not in lane' });
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.reactions.onResult({ opId: 'req-1:final', ok: true, messageId: '55' });
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});
