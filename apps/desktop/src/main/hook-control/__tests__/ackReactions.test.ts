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
  emojiReactions: TelegramEmojiReactions = 'minimal',
  random: () => number = () => 0,
) {
  const sent: HookMessage[] = [];
  const send = vi.fn((m: HookMessage) => {
    sent.push(m);
    return true;
  });
  const warn = vi.fn();
  const reactions = createAckReactions({
    serverFeatures: new Map([[CONN, features]]),
    emojiReactions: () => emojiReactions,
    random,
    log: { info: () => undefined, warn },
  });
  return { reactions, send, sent, warn };
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

    it('补发只补自己那条连接的, 且只补一次', () => {
      const h = harness();
      h.reactions.onFinished(TASK, 'ok', vi.fn(() => false));
      h.reactions.onReconnected('another-conn', h.send);
      expect(h.send).not.toHaveBeenCalled();
      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(1);
      h.reactions.onReconnected(CONN, h.send);
      expect(h.sent).toHaveLength(1);
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

  it('回执失败只记一行, 不抛不重试(表情是装饰, 不能影响任务)', () => {
    const h = harness();
    h.reactions.onResult({ opId: 'req-1:ack', ok: false, error: 'message not in lane' });
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.reactions.onResult({ opId: 'req-1:final', ok: true, messageId: '55' });
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});
