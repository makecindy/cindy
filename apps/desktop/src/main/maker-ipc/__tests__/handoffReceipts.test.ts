/**
 * send_to_session 完成回执回投单测 —— createHandoffReceiptSender 的投递契约。
 *
 * 测试价值
- 生产入口与可观察结果：register.ts 把 sendToSessionInternalBase 注入本模块;发起任务的
  Agent 能观察到的契约是——目标 turn 正常结束后收到恰好一条隐藏回执,clientId 确定
  (`handoff-receipt-done:<nonce>`),投递失败退避重试后有界收口(warn,不无限重试)。
- Bug／规则依据：docs/dev-rules/protocol-compatibility.md「send_to_session 完成回执」
  (本 PR 新增);幂等靠确定性 clientId + messages 表 (sessionId, clientId) 唯一索引。
- 现有覆盖缺口：委派完成回投(botDelegationService deliverCompletion)有自己的重试机制;
  本模块是 send_to_session 的独立通路,无相邻覆盖。
- 最小失败输入：send 连续失败时,第 3 次后必须停止并 warn;无法解析的输入 id 必须跳过
  不投递。
- tier：unit(注入 fake send/delay)。
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildHandoffReceiptMessage,
  createHandoffReceiptGate,
  createHandoffReceiptSender,
  type HandoffReceiptSend,
} from '../handoffReceipts.js';

const NONCE = '0f0e0d0c-0b0a-4999-8999-990099887766';
const INPUT_ID = `handoff-receipt:disp-1:${NONCE}`;

function fakeSend() {
  const send = vi.fn<HandoffReceiptSend>(async () => ({ ok: true }));
  return { send };
}

describe('handoff receipt sender', () => {
  it('按确定性 clientId 回投到发起任务, persistedContent 带隐藏触发前缀', async () => {
    const { send } = fakeSend();
    await createHandoffReceiptSender({ send, delay: async () => {} })('tgt-9', [INPUT_ID]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({
        targetSessionId: 'disp-1',
        dispatcherSessionId: 'tgt-9',
        clientId: `handoff-receipt-done:${NONCE}`,
        forceQueue: true,
      }),
    );
    const call = send.mock.calls[0]![0];
    expect(call.persistedContent.startsWith('[UI_ACTION_TRIGGER]')).toBe(true);
    expect(call.message).toContain('消息 id');
    expect(call.message).toContain(INPUT_ID);
  });

  it('无法解析的输入 id 直接跳过, 不投递', async () => {
    const { send } = fakeSend();
    await createHandoffReceiptSender({ send, delay: async () => {} })('tgt-9', ['plain-client-id']);
    expect(send).not.toHaveBeenCalled();
  });

  it('投递失败退避重试, 第三次仍失败则 warn 收口不无限重试', async () => {
    const send = vi.fn(async () => ({
      ok: false as const,
      errorCode: 'AGENT_NOT_READY',
      message: 'x',
    }));
    const warn = vi.fn();
    const delays: number[] = [];
    await createHandoffReceiptSender({
      send,
      warn,
      delay: async (ms) => {
        delays.push(ms);
      },
    })('tgt-9', [INPUT_ID]);
    expect(send).toHaveBeenCalledTimes(3);
    expect(delays).toEqual([1_000, 2_000]);
    expect(warn).toHaveBeenCalledWith(
      'handoff receipt was not delivered',
      expect.objectContaining({
        targetSessionId: 'tgt-9',
        dispatcherSessionId: 'disp-1',
        errorCode: 'AGENT_NOT_READY',
      }),
    );
  });

  it('重发永远携带同一 clientId(配合唯一索引幂等), 首次成功即停', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, errorCode: 'HOST_NOT_READY', message: 'x' })
      .mockResolvedValueOnce({ ok: true });
    await createHandoffReceiptSender({ send, delay: async () => {} })('tgt-9', [INPUT_ID]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(new Set(send.mock.calls.map(([c]) => c!.clientId)).size).toBe(1);
  });
});

describe('buildHandoffReceiptMessage', () => {
  it('声明不是用户消息, 带目标 session 与消息 id, 指引 get_chat_history 且不承诺成功', () => {
    const text = buildHandoffReceiptMessage({ targetSessionId: 'tgt-9', inputClientId: INPUT_ID });
    expect(text).toContain('[Handoff receipt]');
    expect(text).toContain('tgt-9');
    expect(text).toContain(INPUT_ID);
    expect(text).toContain('get_chat_history');
    expect(text).toContain('不保证成功');
  });
});

describe('handoff receipt gate (终态失败轮次不回投)', () => {
  it('同代次 error→done 配对被拦; 成功后不再拦截', () => {
    const gate = createHandoffReceiptGate();
    gate.markTerminalError('s1', 'instA', 7);
    expect(gate.isFailedTurn('s1', 'instA', 7)).toBe(true);
    // 拦截后同代次记录已清, 重放的 done 不再拦(幂等由确定性 clientId 负责)。
    expect(gate.isFailedTurn('s1', 'instA', 7)).toBe(false);
  });

  it('失败后的更新代次正常回投, 并清理陈旧记录', () => {
    const gate = createHandoffReceiptGate();
    gate.markTerminalError('s1', 'instA', 7);
    expect(gate.isFailedTurn('s1', 'instA', 8)).toBe(false);
    expect(gate.isFailedTurn('s1', 'instA', 8)).toBe(false);
  });

  it('未标记失败(可重试 error / 从未失败)时放行; 乱序旧 done 保守拦截', () => {
    const gate = createHandoffReceiptGate();
    expect(gate.isFailedTurn('s2', 'instA', 3)).toBe(false);
    gate.markTerminalError('s2', 'instA', 9);
    expect(gate.isFailedTurn('s2', 'instA', 4)).toBe(true);
    gate.markTerminalError('s3', 'instA', undefined);
    expect(gate.isFailedTurn('s3', 'instA', 5)).toBe(false);
  });

  it('失败归属按实例隔离: 旧实例失败不拦截重建实例的回执(代次从零重来)', () => {
    const gate = createHandoffReceiptGate();
    // 旧实例: 失败在代次 5, 关闭时可能没有配对 done, 记录残留。
    gate.markTerminalError('s1', 'instA', 5);
    // 新实例: 代次从 0 重来, 成功 done 必须放行。
    expect(gate.isFailedTurn('s1', 'instB', 0)).toBe(false);
    expect(gate.isFailedTurn('s1', 'instB', 1)).toBe(false);
    // 旧实例键不被新实例污染: 旧实例自己的失败 done 仍被拦。
    expect(gate.isFailedTurn('s1', 'instA', 5)).toBe(true);
    // 无 instanceId 的事件(异常路径)独立归属, 不撞有实例的记录。
    expect(gate.isFailedTurn('s1', undefined, 5)).toBe(false);
  });
});
