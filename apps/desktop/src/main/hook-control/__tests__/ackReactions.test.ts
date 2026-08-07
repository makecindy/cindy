/**
 * 官方 bot ack 表情回归。
 *
 * 这是 msg.op 的第一个真实使用点, 刻意挑了一个纯增量、失败无害的动作打通链路。
 * 用例守三件事: 能力协商门控(老 server 一帧都不发)、幂等键稳定(断连重发不
 * 重复打表情)、以及表情语义与个人 bot 一致。
 */

import { describe, expect, it, vi } from 'vitest';

import { HOOK_FEATURE_MESSAGE_OPS, type HookMessage } from '@cindy/slack-hook-protocol';

import { createAckReactions, type AckReactionTask } from '../ackReactions';

const CONN = 'telegram';
const TASK: AckReactionTask = {
  connectionId: CONN,
  requestId: 'req-1',
  externalKey: 'telegram:group:bot:-100200:user-7',
  triggerMessageId: '55',
};

function harness(features: readonly string[] = [HOOK_FEATURE_MESSAGE_OPS]) {
  const sent: HookMessage[] = [];
  const send = vi.fn((m: HookMessage) => {
    sent.push(m);
    return true;
  });
  const warn = vi.fn();
  const reactions = createAckReactions({
    serverFeatures: new Map([[CONN, features]]),
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

  it('回执失败只记一行, 不抛不重试(表情是装饰, 不能影响任务)', () => {
    const h = harness();
    h.reactions.onResult({ opId: 'req-1:ack', ok: false, error: 'message not in lane' });
    expect(h.warn).toHaveBeenCalledTimes(1);
    h.reactions.onResult({ opId: 'req-1:final', ok: true, messageId: '55' });
    expect(h.warn).toHaveBeenCalledTimes(1);
  });
});
