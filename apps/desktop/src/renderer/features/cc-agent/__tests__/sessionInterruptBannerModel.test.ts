import { describe, expect, it } from 'vitest';

import { resolveSessionInterruptCandidate } from '../sessionInterruptBannerModel';

const baseInput = {
  acked: false,
  remoteTurnActive: false,
  mainTurnActive: false as boolean | null,
  activeTurnStartedAt: 3_000,
  lastTurnEndedAt: 1_000,
  clearedAtMs: null as number | null,
};

describe('resolveSessionInterruptCandidate — 运行态反驳信号优先', () => {
  it('acked(本窗口已观察到运行态/用户已操作)时恒不显示', () => {
    expect(resolveSessionInterruptCandidate({ ...baseInput, acked: true })).toBe(false);
  });

  it('remoteTurnActive(device-link 活动镜像)时恒不显示', () => {
    expect(resolveSessionInterruptCandidate({ ...baseInput, remoteTurnActive: true })).toBe(false);
  });
});

describe('resolveSessionInterruptCandidate — main 真值回填(#4513)', () => {
  it('mainTurnActive=true(main 侧 turn 在飞)时不显示:双时间戳对在飞 turn 天然成立', () => {
    expect(resolveSessionInterruptCandidate({ ...baseInput, mainTurnActive: true })).toBe(false);
  });

  it('mainTurnActive=null(查询在途/失败/不适用)时不显示:未确认不当中断证据', () => {
    expect(resolveSessionInterruptCandidate({ ...baseInput, mainTurnActive: null })).toBe(false);
  });

  it('main 明确回答不在 turn 中(started > ended)才显示', () => {
    expect(resolveSessionInterruptCandidate({ ...baseInput })).toBe(true);
  });

  it('切会话时旧会话的真值不得带到新会话:调用方按 sessionId 过滤(P1)', () => {
    // 视图侧 mainTurnActiveForSession 只认归属当前 sessionId 的查询结果;
    // 这里锁定过滤语义:旧会话残留 { sessionId: A, inTurn: true } 在会话 B 下
    // 必须折成 null(未确认),不得以 true 锁存 B 的 ack、也不得直接当 B 的证据。
    const staleForB = (truth: { sessionId: string; inTurn: boolean } | null, sessionId: string) =>
      truth?.sessionId === sessionId ? truth.inTurn : null;
    expect(staleForB({ sessionId: 'sess-a', inTurn: true }, 'sess-b')).toBe(null);
    expect(
      resolveSessionInterruptCandidate({ ...baseInput, mainTurnActive: staleForB({ sessionId: 'sess-a', inTurn: true }, 'sess-b') }),
    ).toBe(false);
    // 同会话真值保持原语义:true 压住横幅,false 放行双时间戳候选。
    expect(staleForB({ sessionId: 'sess-b', inTurn: true }, 'sess-b')).toBe(true);
    expect(staleForB({ sessionId: 'sess-b', inTurn: false }, 'sess-b')).toBe(false);
  });
});

describe('resolveSessionInterruptCandidate — 双时间戳语义保持不变', () => {
  it('started <= ended(turn 已正常收尾)不显示', () => {
    expect(
      resolveSessionInterruptCandidate({ ...baseInput, lastTurnEndedAt: 3_000 }),
    ).toBe(false);
    expect(
      resolveSessionInterruptCandidate({ ...baseInput, lastTurnEndedAt: 5_000 }),
    ).toBe(false);
  });

  it('started 被 /clear 越过(cleared)不显示', () => {
    expect(
      resolveSessionInterruptCandidate({ ...baseInput, clearedAtMs: 4_000 }),
    ).toBe(false);
  });

  it('cleared 在 started 之前不影响判定', () => {
    expect(
      resolveSessionInterruptCandidate({ ...baseInput, clearedAtMs: 500 }),
    ).toBe(true);
  });

  it('没有 active turn(started 为空)不显示', () => {
    expect(
      resolveSessionInterruptCandidate({ ...baseInput, activeTurnStartedAt: null }),
    ).toBe(false);
  });

  it('ended 缺失(从未收尾)且 main 确认空闲时显示', () => {
    expect(
      resolveSessionInterruptCandidate({ ...baseInput, lastTurnEndedAt: null }),
    ).toBe(true);
  });
});
