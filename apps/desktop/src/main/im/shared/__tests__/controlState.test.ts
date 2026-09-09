import { describe, expect, it } from 'vitest';

import { enterControl, exitControl, getControlScope, isInControl } from '../controlState';

/**
 * /ctr 锁的键语义契约。飞书群消息侧的 key 是话题 lane(g/{chatId}/{threadId}),
 * 卡片回调侧必须归一成同一条 lane 才能解锁 — 用 operator.open_id 解锁会落空,
 * 该 lane 永远锁在「选择中」(曾导致「明明创建了还提示还在选择中」的线上 bug,
 * 传输层修复见 packages/lizi-im feishu 的 cardLanes 登记反查)。
 */
describe('controlState key semantics', () => {
  it('group lane and owner open_id are distinct keys — exit must use the enter key', () => {
    enterControl('bot1', 'g/oc_chat/omt_t1');
    expect(isInControl('bot1', 'g/oc_chat/omt_t1')).toBe(true);
    expect(isInControl('bot1', 'ou_owner')).toBe(false);

    // 旧 bug 的解锁键(operator.open_id): 删不中, lane 保持锁定。
    exitControl('bot1', 'ou_owner');
    expect(isInControl('bot1', 'g/oc_chat/omt_t1')).toBe(true);

    // 与消息侧同键的 lane 解锁生效。
    exitControl('bot1', 'g/oc_chat/omt_t1');
    expect(isInControl('bot1', 'g/oc_chat/omt_t1')).toBe(false);
  });

  it('same identity across bots stays independent', () => {
    enterControl('bot1', 'ou_owner');
    expect(isInControl('bot1', 'ou_owner')).toBe(true);
    expect(isInControl('bot2', 'ou_owner')).toBe(false);
    exitControl('bot1', 'ou_owner');
    expect(isInControl('bot1', 'ou_owner')).toBe(false);
  });

  it('thread-model scope is returned separately from the lock itself', () => {
    enterControl('bot1', 'ou_owner', 'omt_anchor');
    expect(isInControl('bot1', 'ou_owner')).toBe(true);
    expect(getControlScope('bot1', 'ou_owner')).toBe('omt_anchor');
    exitControl('bot1', 'ou_owner');
    expect(isInControl('bot1', 'ou_owner')).toBe(false);
    expect(getControlScope('bot1', 'ou_owner')).toBeNull();
  });
});
