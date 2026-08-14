/**
 * 阶段 11 偏好帧(prefs.get / prefs.set / prefs.state)测试:
 *   1. 构造 -> 序列化 -> 解析 round-trip(含部分更新的 undefined/null 混合)
 *   2. 校验负例: requestId / workspace / patch 字段类型 / bound 联动 / 条目形状
 */

import { describe, expect, it } from 'vitest';

import {
  makePrefsGet,
  makePrefsSet,
  makePrefsState,
  parseHookMessage,
  serializeHookMessage,
  type HookMessage,
  type PrefsStatePayload,
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

const STATE: PrefsStatePayload = {
  replyTo: 'req-1',
  bound: true,
  prefs: [
    {
      workspace: 'cindy',
      model: 'claude-opus-4-8',
      effort: 'high',
      agentKind: 'claude-code',
      permissionMode: 'ask',
    },
    { workspace: 'blog', model: null, effort: null, agentKind: null, permissionMode: null },
  ],
};

describe('prefs 帧 round-trip', () => {
  it('prefs.get', () => {
    roundTrip(makePrefsGet({ requestId: 'req-1' }));
  });

  it('prefs.set: 全量 patch / 部分 patch(undefined 缺席) / null 清空', () => {
    roundTrip(
      makePrefsSet({
        requestId: 'req-2',
        workspace: 'cindy',
        model: 'claude-opus-4-8',
        effort: 'high',
        agentKind: 'claude-code',
        permissionMode: 'ask',
      }),
    );
    // 只动 effort, 其余缺席(JSON.stringify 会剥掉 undefined, round-trip 仍等价)
    roundTrip(makePrefsSet({ requestId: 'req-3', workspace: 'cindy', effort: 'low' }));
    roundTrip(makePrefsSet({ requestId: 'req-4', workspace: 'blog', permissionMode: null }));
  });

  it('prefs.state: 应答(replyTo 回显)与主动推送(replyTo null)、未绑定空快照', () => {
    roundTrip(makePrefsState(STATE));
    roundTrip(makePrefsState({ ...STATE, replyTo: null }));
    roundTrip(makePrefsState({ replyTo: null, bound: false, prefs: [] }));
  });
});

describe('prefs 帧校验负例', () => {
  it('prefs.get: requestId 必填非空', () => {
    const msg = makePrefsGet({ requestId: 'req-1' });
    expectReject({ ...msg, payload: { requestId: '' } }, 'prefs.get.requestId');
    expectReject({ ...msg, payload: {} }, 'prefs.get.requestId');
  });

  it('prefs.set: workspace 必填非空, patch 字段必须 string|null', () => {
    const msg = makePrefsSet({ requestId: 'r', workspace: 'cindy', effort: 'low' });
    expectReject({ ...msg, payload: { requestId: 'r', workspace: '' } }, 'prefs.set.workspace');
    expectReject(
      { ...msg, payload: { requestId: 'r', workspace: 'cindy', model: 42 } },
      'prefs.set.model must be a string or null',
    );
    expectReject(
      { ...msg, payload: { requestId: 'r', workspace: 'cindy', permissionMode: false } },
      'prefs.set.permissionMode must be a string or null',
    );
  });

  it('prefs.state: bound=false 时 prefs 必须为空', () => {
    const msg = makePrefsState(STATE);
    expectReject(
      { ...msg, payload: { ...STATE, bound: false } },
      'prefs must be empty when bound is false',
    );
  });

  it('prefs.state: 条目形状(workspace 非空, 字段显式 null 而非缺席)', () => {
    const msg = makePrefsState(STATE);
    const badWs = structuredClone(STATE) as unknown as Record<string, unknown>;
    (badWs.prefs as Array<Record<string, unknown>>)[0].workspace = '';
    expectReject({ ...msg, payload: badWs }, 'prefs[0].workspace');
    const missingField = structuredClone(STATE) as unknown as Record<string, unknown>;
    delete (missingField.prefs as Array<Record<string, unknown>>)[1].model;
    expectReject({ ...msg, payload: missingField }, 'prefs[1].model must be a string or null');
    const badReply = structuredClone(STATE) as unknown as Record<string, unknown>;
    expectReject({ ...msg, payload: { ...badReply, replyTo: 7 } }, 'prefs.state.replyTo');
  });
});
