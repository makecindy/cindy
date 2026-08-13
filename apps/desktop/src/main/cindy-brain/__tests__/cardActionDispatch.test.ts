/**
 * cardActionDispatch.test.ts — 交互卡按钮点击派发单测(纯 DI,无 Electron)。
 * 覆盖:载荷校验、归属解析(内存优先/持久兜底/查无拒)、卡槽校验、wake+投递、
 * 投递失败折叠、fire-and-forget 不抛。
 */

import { describe, it, expect, vi } from 'vitest';

import { GhostCardActionDispatcher, type CardActionDispatchDeps } from '../cardActionDispatch';
import type { InstalledGhost } from '../../../shared/ghost';

function fakeGhost(overrides: { enabled?: boolean; slots?: string[] } = {}): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id: 'cindy-mivo',
      name: 'Mivo',
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: overrides.slots ?? ['tool', 'card', 'network'],
    },
    dir: '/fake/cindy-mivo',
    enabled: overrides.enabled ?? true,
  } as InstalledGhost;
}

function makeDispatcher(overrides: Partial<CardActionDispatchDeps> = {}) {
  const wake = vi.fn(async () => {});
  const sendToGhost = vi.fn();
  const reopenForAction = vi.fn();
  const deps: CardActionDispatchDeps = {
    resolveLiveInfo: () => ({ ghostId: 'cindy-mivo', sessionId: null }),
    resolvePersistedCard: async () => null,
    reopenForAction,
    getGhost: () => fakeGhost(),
    isRunning: () => true,
    wake,
    sendToGhost,
    now: () => 1000,
    ...overrides,
  };
  return { dispatcher: new GhostCardActionDispatcher(deps), wake, sendToGhost, reopenForAction };
}

describe('cardActionDispatch owner boundary', () => {
  it('rechecks the owner after wake and never sends to a stale Ghost', async () => {
    let releaseWake!: () => void;
    let ownerValid = true;
    const onInvalidated = vi.fn();
    const wake = vi.fn(() => new Promise<void>((resolve) => { releaseWake = resolve; }));
    const { dispatcher, sendToGhost } = makeDispatcher({
      isRunning: () => false,
      wake,
      ownerScope: {
        capture: () => ({ ownerId: 'owner-a', generation: 1 }),
        isCurrent: () => ownerValid,
        isStable: () => ownerValid,
        onInvalidated,
      },
    });

    const resultPromise = dispatcher.dispatch('call-abc', CUSTOM_ID);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledOnce());
    ownerValid = false;
    releaseWake();

    await expect(resultPromise).resolves.toEqual({ ok: false, reason: 'owner-boundary' });
    expect(sendToGhost).not.toHaveBeenCalled();
    expect(onInvalidated).toHaveBeenCalledWith('cindy-mivo');
  });
});

const CALL_ID = 'call-abc';
const CUSTOM_ID = 'MJ::JOB::upsample::1::0f3a2b1c-4d5e-6f70-8a9b-0c1d2e3f4a5b';
// 假时钟 1000 → 36 进制 'rs':派发器铸的衍生卡位。
const SPAWN_ID = 'call-abc::sprs';

describe('cardActionDispatch · 载荷校验', () => {
  it('callId 缺失/空/超长、actionId 非法一律拒,不投递', async () => {
    const { dispatcher, sendToGhost } = makeDispatcher();
    expect((await dispatcher.dispatch(undefined, CUSTOM_ID)).ok).toBe(false);
    expect((await dispatcher.dispatch('', CUSTOM_ID)).ok).toBe(false);
    expect((await dispatcher.dispatch('x'.repeat(129), CUSTOM_ID)).ok).toBe(false);
    expect((await dispatcher.dispatch(CALL_ID, 'has space')).ok).toBe(false);
    expect((await dispatcher.dispatch(CALL_ID, 'x'.repeat(129))).ok).toBe(false);
    expect((await dispatcher.dispatch(CALL_ID, '中文')).ok).toBe(false);
    expect(sendToGhost).not.toHaveBeenCalled();
  });
});

describe('cardActionDispatch · 归属解析', () => {
  it('内存命中即投递,不查持久层;被点卡与衍生卡位都重开', async () => {
    const resolvePersistedCard = vi.fn(async () => null);
    const { dispatcher, sendToGhost, reopenForAction } = makeDispatcher({ resolvePersistedCard });
    const r = await dispatcher.dispatch(CALL_ID, CUSTOM_ID);
    expect(r.ok).toBe(true);
    expect(resolvePersistedCard).not.toHaveBeenCalled();
    expect(reopenForAction).toHaveBeenCalledWith(CALL_ID, { ghostId: 'cindy-mivo', sessionId: null });
    expect(reopenForAction).toHaveBeenCalledWith(SPAWN_ID, { ghostId: 'cindy-mivo', sessionId: null });
    expect(sendToGhost).toHaveBeenCalledTimes(1);
  });

  it('内存查无 → 持久层兜底(sessionId 续会话归属,衍生卡位同享)', async () => {
    const resolvePersistedCard = vi.fn(async () => ({ ghostId: 'cindy-mivo', sessionId: 'sess-9' }));
    const { dispatcher, sendToGhost, reopenForAction } = makeDispatcher({
      resolveLiveInfo: () => null,
      resolvePersistedCard,
    });
    const r = await dispatcher.dispatch(CALL_ID, CUSTOM_ID);
    expect(r.ok).toBe(true);
    expect(resolvePersistedCard).toHaveBeenCalledWith(CALL_ID);
    // 重开须带持久层查到的 sessionId,重建被清扫的条目才不把会话归属丢成 null;
    // 衍生卡位登记同一 sessionId,历史回放才能按会话捞回衍生卡。
    expect(reopenForAction).toHaveBeenCalledWith(CALL_ID, { ghostId: 'cindy-mivo', sessionId: 'sess-9' });
    expect(reopenForAction).toHaveBeenCalledWith(SPAWN_ID, { ghostId: 'cindy-mivo', sessionId: 'sess-9' });
    expect(sendToGhost).toHaveBeenCalledTimes(1);
  });

  it('内存与持久层都查无 → 拒,不投递也不重开', async () => {
    const { dispatcher, sendToGhost, reopenForAction } = makeDispatcher({
      resolveLiveInfo: () => null,
      resolvePersistedCard: async () => null,
    });
    const r = await dispatcher.dispatch(CALL_ID, CUSTOM_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unknown-card');
    expect(reopenForAction).not.toHaveBeenCalled();
    expect(sendToGhost).not.toHaveBeenCalled();
  });
});

describe('cardActionDispatch · 资格审 + 投递', () => {
  it('happy path:含 :: 的 customId 原样投递,事件带衍生卡位 spawnCallId', async () => {
    const { dispatcher, sendToGhost } = makeDispatcher();
    const r = await dispatcher.dispatch(CALL_ID, CUSTOM_ID);
    expect(r.ok).toBe(true);
    expect(sendToGhost).toHaveBeenCalledWith('cindy-mivo', {
      type: 'event',
      name: 'card-action',
      callId: CALL_ID,
      actionId: CUSTOM_ID,
      spawnCallId: SPAWN_ID,
      ts: 1000,
    });
  });

  it('卡片有会话归属时签发 Agent 一次性票,并随点击事件一起交给插件', async () => {
    const issueUserActionToken = vi.fn(() => 'one-shot-token');
    const { dispatcher, sendToGhost } = makeDispatcher({
      resolveLiveInfo: () => ({ ghostId: 'cindy-mivo', sessionId: 'sess-1' }),
      issueUserActionToken,
    });

    expect((await dispatcher.dispatch(CALL_ID, CUSTOM_ID)).ok).toBe(true);
    expect(issueUserActionToken).toHaveBeenCalledWith('cindy-mivo', 'sess-1');
    expect(sendToGhost).toHaveBeenCalledWith(
      'cindy-mivo',
      expect.objectContaining({
        name: 'card-action',
        sessionId: 'sess-1',
        userActionToken: 'one-shot-token',
      }),
    );
  });

  it('衍生卡上的按钮再被点:新 spawn 基于根 callId 铸,平铺不嵌套', async () => {
    const { dispatcher, sendToGhost, reopenForAction } = makeDispatcher();
    const r = await dispatcher.dispatch(SPAWN_ID, CUSTOM_ID); // 点的是衍生卡
    expect(r.ok).toBe(true);
    // 新卡位仍是 call-abc::sp<序>,不是 call-abc::sprs::sp<序>。
    expect(sendToGhost).toHaveBeenCalledWith(
      'cindy-mivo',
      expect.objectContaining({ callId: SPAWN_ID, spawnCallId: SPAWN_ID }),
    );
    // 假时钟恒 1000 → 新 spawn 与被点卡同名(真实时钟单调,不会撞名);
    // 同名时只重开一次(第二次 reopen 被 spawnCallId===callId 跳过)。
    expect(reopenForAction).toHaveBeenCalledTimes(1);
  });

  it('根 callId 过长导致 spawn 超 128 → 回退原 callId(意识原地换卡)', async () => {
    const longRoot = 'x'.repeat(124); // +'::sprs'(6) = 130 > 128
    const { dispatcher, sendToGhost } = makeDispatcher();
    const r = await dispatcher.dispatch(longRoot, CUSTOM_ID);
    expect(r.ok).toBe(true);
    expect(sendToGhost).toHaveBeenCalledWith(
      'cindy-mivo',
      expect.objectContaining({ callId: longRoot, spawnCallId: longRoot }),
    );
  });

  it('不在跑先 wake 再投递', async () => {
    const { dispatcher, wake, sendToGhost } = makeDispatcher({ isRunning: () => false });
    await dispatcher.dispatch(CALL_ID, CUSTOM_ID);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(sendToGhost).toHaveBeenCalledTimes(1);
  });

  it('意识停用 / 不存在 / 无 card 槽 → 拒,不投递', async () => {
    const disabled = makeDispatcher({ getGhost: () => fakeGhost({ enabled: false }) });
    expect((await disabled.dispatcher.dispatch(CALL_ID, CUSTOM_ID)).ok).toBe(false);
    expect(disabled.sendToGhost).not.toHaveBeenCalled();

    const gone = makeDispatcher({ getGhost: () => null });
    expect((await gone.dispatcher.dispatch(CALL_ID, CUSTOM_ID)).ok).toBe(false);

    const noSlot = makeDispatcher({ getGhost: () => fakeGhost({ slots: ['tool'] }) });
    const r = await noSlot.dispatcher.dispatch(CALL_ID, CUSTOM_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no-card-slot');
  });

  it('prompt 透传:非空文字随事件带给意识;空串/缺省不带 prompt 字段', async () => {
    const { dispatcher, sendToGhost } = makeDispatcher();
    expect((await dispatcher.dispatch(CALL_ID, CUSTOM_ID, '  把猫改成橘猫  ')).ok).toBe(true);
    expect(sendToGhost).toHaveBeenLastCalledWith('cindy-mivo', {
      type: 'event',
      name: 'card-action',
      callId: CALL_ID,
      actionId: CUSTOM_ID,
      prompt: '把猫改成橘猫',
      spawnCallId: SPAWN_ID,
      ts: 1000,
    });
    expect((await dispatcher.dispatch(CALL_ID, CUSTOM_ID, '')).ok).toBe(true);
    expect(sendToGhost).toHaveBeenLastCalledWith('cindy-mivo', expect.not.objectContaining({ prompt: expect.anything() }));
  });

  it('prompt 非法(非字符串/超长)整次拒,不投递', async () => {
    const { dispatcher, sendToGhost } = makeDispatcher();
    expect((await dispatcher.dispatch(CALL_ID, CUSTOM_ID, 123)).ok).toBe(false);
    expect((await dispatcher.dispatch(CALL_ID, CUSTOM_ID, 'x'.repeat(2001))).ok).toBe(false);
    expect(sendToGhost).not.toHaveBeenCalled();
  });

  it('wake 抛错 → 折叠成 deliver-failed,不抛', async () => {
    const { dispatcher, sendToGhost } = makeDispatcher({
      isRunning: () => false,
      wake: async () => {
        throw new Error('load stuck');
      },
    });
    const r = await dispatcher.dispatch(CALL_ID, CUSTOM_ID);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('deliver-failed');
    expect(sendToGhost).not.toHaveBeenCalled();
  });

  it('投递成功且会话已知 → 上报活动起点(呼吸链路;key=衍生卡位)', async () => {
    const onActivityStart = vi.fn();
    const { dispatcher } = makeDispatcher({
      resolveLiveInfo: () => ({ ghostId: 'cindy-mivo', sessionId: 'sess-1' }),
      onActivityStart,
    });
    expect((await dispatcher.dispatch(CALL_ID, CUSTOM_ID)).ok).toBe(true);
    expect(onActivityStart).toHaveBeenCalledWith(SPAWN_ID, 'sess-1');
  });

  it('会话归属查无(sessionId null)→ 不上报活动起点;投递失败也不上报', async () => {
    const onActivityStart = vi.fn();
    const noSession = makeDispatcher({ onActivityStart });
    expect((await noSession.dispatcher.dispatch(CALL_ID, CUSTOM_ID)).ok).toBe(true);
    expect(onActivityStart).not.toHaveBeenCalled();

    const failed = makeDispatcher({
      resolveLiveInfo: () => ({ ghostId: 'cindy-mivo', sessionId: 'sess-1' }),
      onActivityStart,
      sendToGhost: () => {
        throw new Error('pipe down');
      },
    });
    expect((await failed.dispatcher.dispatch(CALL_ID, CUSTOM_ID)).ok).toBe(false);
    expect(onActivityStart).not.toHaveBeenCalled();
  });
});
