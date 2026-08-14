/**
 * slack-hook-protocol 阶段 10(执行中交互)帧测试:
 *   1. interaction.request / decision / cancel 构造 -> 序列化 -> 解析 round-trip
 *   2. request 的按钮约束(非空 / 上限 / id 唯一 / id 不含 '|' / style 枚举)
 *   3. progress 复活语义不在此测(payload 形状未变, 见 protocol.test.ts)
 */

import { describe, it, expect } from 'vitest';

import {
  MAX_INTERACTION_BUTTONS,
  makeInteractionCancel,
  makeInteractionDecision,
  makeInteractionRequest,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type InteractionRequestPayload,
} from '../index';

function roundTrip(message: HookMessage): HookMessage {
  const parsed = parseHookMessage(serializeHookMessage(message));
  expect(parsed.ok, parsed.ok ? '' : parsed.error).toBe(true);
  if (!parsed.ok) throw new Error('unreachable');
  expect(parsed.message).toEqual(message);
  return parsed.message;
}

function expectReject(mutated: unknown, keyword: string): void {
  const parsed = parseHookMessage(mutated);
  expect(parsed.ok).toBe(false);
  if (parsed.ok) throw new Error('unreachable');
  expect(parsed.error).toContain(keyword);
}

const REQUEST: InteractionRequestPayload = {
  requestId: 'req-1',
  interactionId: 'int-1',
  kind: 'ask_user_question',
  title: '❓ 选一个方案',
  body: '两个方案各有取舍',
  buttons: [
    { id: 'ask:0', label: '方案 A', style: 'default' },
    { id: 'ask:1', label: '方案 B', style: 'primary' },
  ],
};

describe('interaction.* 帧', () => {
  it('三种帧 round-trip', () => {
    roundTrip(makeInteractionRequest(REQUEST));
    roundTrip(
      makeInteractionDecision({ requestId: 'req-1', interactionId: 'int-1', buttonId: 'ask:1' }),
    );
    roundTrip(
      makeInteractionCancel({ requestId: 'req-1', interactionId: 'int-1', reason: '等待超时' }),
    );
  });

  it('request: body 可为空串, buttons 不可为空数组', () => {
    roundTrip(makeInteractionRequest({ ...REQUEST, body: '' }));
    const msg = makeInteractionRequest(REQUEST);
    expectReject({ ...msg, payload: { ...REQUEST, buttons: [] } }, 'non-empty array');
  });

  it('request: 按钮上限 / id 唯一 / id 不含竖线 / style 枚举', () => {
    const msg = makeInteractionRequest(REQUEST);
    const many = Array.from({ length: MAX_INTERACTION_BUTTONS + 1 }, (_, i) => ({
      id: `b${i}`,
      label: 'x',
      style: 'default' as const,
    }));
    expectReject({ ...msg, payload: { ...REQUEST, buttons: many } }, 'at most');
    expectReject(
      {
        ...msg,
        payload: {
          ...REQUEST,
          buttons: [
            { id: 'dup', label: 'a', style: 'default' },
            { id: 'dup', label: 'b', style: 'default' },
          ],
        },
      },
      'unique',
    );
    expectReject(
      { ...msg, payload: { ...REQUEST, buttons: [{ id: 'a|b', label: 'x', style: 'default' }] } },
      "must not contain '|'",
    );
    expectReject(
      { ...msg, payload: { ...REQUEST, buttons: [{ id: 'a', label: 'x', style: 'fancy' }] } },
      'style must be one of',
    );
  });

  it('decision / cancel: 关键字段缺失拒收', () => {
    const d = makeInteractionDecision({ requestId: 'r', interactionId: 'i', buttonId: 'b' });
    expectReject(
      { ...d, payload: { requestId: 'r', interactionId: 'i', buttonId: '' } },
      'buttonId',
    );
    const c = makeInteractionCancel({ requestId: 'r', interactionId: 'i', reason: '' });
    roundTrip(c); // reason 允许空串(字符串即可)
    expectReject({ ...c, payload: { requestId: 'r', reason: 'x' } }, 'interactionId');
  });
});

describe('turn.end 出站附件', () => {
  it('携带 attachments round-trip; 形状非法拒收; 缺省合法', async () => {
    const { makeTurnEnd } = await import('../index');
    const base = {
      requestId: 'r1',
      externalKey: 'C1:1.1',
      sessionId: 's1',
      status: 'ok' as const,
      finalText: '完成',
      errorMessage: null,
      usage: { durationMs: 100 },
    };
    roundTrip(makeTurnEnd(base)); // 缺省
    roundTrip(
      makeTurnEnd({
        ...base,
        attachments: [{ name: 'chart.png', mimeType: 'image/png', dataBase64: 'aGk=' }],
      }),
    );
    const msg = makeTurnEnd(base);
    expectReject(
      {
        ...msg,
        payload: { ...base, attachments: [{ name: 'x', mimeType: '', dataBase64: 'aGk=' }] },
      },
      'turn.end.attachments[0].mimeType',
    );
  });
});
