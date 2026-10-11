// @vitest-environment jsdom
/**
 * ghostCardStore.test.ts — 意识卡片 renderer store 单测。
 * 覆盖:推送入库(ready + 活卡登记/换海报刷新)、ensureCard 幂等与
 * ready/missing/失败路径、推送与取件竞态(ready 不被回退)、订阅通知。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  __resetGhostCardStoreForTest,
  ensureCard,
  ensureSessionCards,
  getGhostCardEntry,
  getGhostCardSnapshot,
  ingestCardPush,
  subscribeGhostCards,
} from '@/cindy-brain/ghostCardStore';

type GetCardResult = { card: { ghostId: string; html: string; height: number } | null };
type ListResult = { cards: Array<{ callId: string; ghostId: string; html: string; height: number }> };

function mockApi(
  getCard?: (id: string) => Promise<GetCardResult>,
  listCardsBySession?: (id: string) => Promise<ListResult>,
) {
  (window as unknown as { electronAPI?: unknown }).electronAPI = {
    ghosts: {
      onCardUpdated: vi.fn(() => () => {}),
      ...(getCard ? { getCard } : {}),
      ...(listCardsBySession ? { listCardsBySession } : {}),
    },
  };
}

afterEach(() => {
  __resetGhostCardStoreForTest();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

const push = (callId: string, over: Partial<Parameters<typeof ingestCardPush>[0]> = {}) => ({
  callId,
  ghostId: 'g1',
  toolUseId: null,
  html: '<p>x</p>',
  height: 240,
  ...over,
});

describe('ghostCardStore', () => {
  it('preserves the logical identity of an in-place plugin on its live card', () => {
    ingestCardPush(push('org', { ghostId: 'helper', logicalGhostId: '_ns__acme__helper' }));
    expect(getGhostCardSnapshot().liveCards[0]).toMatchObject({
      ghostId: 'helper', logicalGhostId: '_ns__acme__helper',
    });
  });

  it('推送入库:ready 条目 + 活卡登记;换海报只刷内容不重复登记', () => {
    ingestCardPush(push('c1', { toolUseId: 'tu1' }));
    let snap = getGhostCardSnapshot();
    expect(snap.byCallId.get('c1')).toMatchObject({ status: 'ready', html: '<p>x</p>' });
    expect(snap.liveCards).toHaveLength(1);
    expect(snap.liveCards[0]).toMatchObject({ callId: 'c1', toolUseId: 'tu1' });

    ingestCardPush(push('c1', { html: '<p>v2</p>' }));
    snap = getGhostCardSnapshot();
    expect(snap.byCallId.get('c1')).toMatchObject({ html: '<p>v2</p>' });
    expect(snap.liveCards).toHaveLength(1);
  });

  it('订阅者在推送时收到通知,version 递增', () => {
    const cb = vi.fn();
    const unsub = subscribeGhostCards(cb);
    const v0 = getGhostCardSnapshot().version;
    ingestCardPush(push('c1'));
    expect(cb).toHaveBeenCalledTimes(1);
    expect(getGhostCardSnapshot().version).toBe(v0 + 1);
    unsub();
    ingestCardPush(push('c2'));
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('ensureCard:命中 → ready;null → missing;幂等不重打', async () => {
    const getCard = vi.fn(async (id: string): Promise<GetCardResult> =>
      id === 'hit'
        ? { card: { ghostId: 'g1', html: '<p>db</p>', height: 300 } }
        : { card: null },
    );
    mockApi(getCard);

    ensureCard('hit');
    ensureCard('hit'); // 幂等:loading 中不再发
    ensureCard('miss');
    await vi.waitFor(() => {
      expect(getGhostCardSnapshot().byCallId.get('hit')).toMatchObject({
        status: 'ready',
        html: '<p>db</p>',
      });
      expect(getGhostCardSnapshot().byCallId.get('miss')).toEqual({ status: 'missing' });
    });
    expect(getCard).toHaveBeenCalledTimes(2);
    ensureCard('miss'); // missing 已缓存,不重打
    expect(getCard).toHaveBeenCalledTimes(2);
  });

  it('取件在途时推送先到:ready 不被取件结果回退', async () => {
    let resolveGet: (r: GetCardResult) => void = () => {};
    mockApi(() => new Promise<GetCardResult>((r) => (resolveGet = r)));

    ensureCard('c1');
    ingestCardPush(push('c1', { html: '<p>live</p>' }));
    resolveGet({ card: null });
    await new Promise((r) => setTimeout(r, 0));
    expect(getGhostCardSnapshot().byCallId.get('c1')).toMatchObject({
      status: 'ready',
      html: '<p>live</p>',
    });
  });

  it('无 electronAPI(测试/无桥环境)ensureCard 落 missing 不抛', () => {
    ensureCard('c1');
    expect(getGhostCardSnapshot().byCallId.get('c1')).toEqual({ status: 'missing' });
  });

  it('IPC 失败落 missing', async () => {
    mockApi(async () => Promise.reject(new Error('ipc down')));
    ensureCard('c1');
    await vi.waitFor(() => {
      expect(getGhostCardSnapshot().byCallId.get('c1')).toEqual({ status: 'missing' });
    });
  });
  it('权威实测高回填内存条目:ready 条目更新并广播,等值/非 ready 静默', async () => {
    const { noteCardMeasuredHeight } = await import('@/cindy-brain/ghostCardStore');
    ingestCardPush(push('c1', { height: 500 }));
    const cb = vi.fn();
    subscribeGhostCards(cb);
    noteCardMeasuredHeight('c1', 613);
    expect(getGhostCardSnapshot().byCallId.get('c1')).toMatchObject({ height: 613 });
    expect(cb).toHaveBeenCalledTimes(1);
    noteCardMeasuredHeight('c1', 613); // 等值不广播
    expect(cb).toHaveBeenCalledTimes(1);
    noteCardMeasuredHeight('nope', 300); // 未知条目静默
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('turn 级自绘卡(turnCard):只入卡库不进 liveCards 锚定池(review P1)', () => {
    ingestCardPush(push('msg-clientid', { turnCard: true }));
    const snap = getGhostCardSnapshot();
    expect(snap.byCallId.get('msg-clientid')).toMatchObject({ status: 'ready' });
    // 不进锚定池:同意识进行中的 ghost_call 启发式锚定不会抢走它。
    expect(snap.liveCards).toHaveLength(0);
    // 普通工具卡照常登记,互不影响。
    ingestCardPush(push('tool-call-id'));
    expect(getGhostCardSnapshot().liveCards).toHaveLength(1);
  });

  it('ensureSessionCards:批量灌 byCallId(含 turn 级自绘卡 callId=消息 clientId),幂等,不覆盖已 ready', async () => {
    const list = vi.fn(async (): Promise<ListResult> => ({
      cards: [
        { callId: 'tool-uuid', ghostId: 'g1', html: '<p>tool</p>', height: 200 },
        { callId: 'msg-clientid', ghostId: 'g2', html: '<p>自绘</p>', height: 180 },
      ],
    }));
    mockApi(undefined, list);
    // 推送先到的卡不被批量覆盖。
    ingestCardPush(push('msg-clientid', { ghostId: 'gX', html: '<p>live</p>' }));

    ensureSessionCards('s1');
    ensureSessionCards('s1'); // 幂等:同会话不重打
    await vi.waitFor(() => {
      // tool 卡按 callId 落入。
      expect(getGhostCardEntry('tool-uuid')).toMatchObject({ status: 'ready', html: '<p>tool</p>' });
    });
    // 自绘卡 = 消息 clientId 为键(AssistantMessage 据 getGhostCardEntry(clientId) 判自绘)。
    // 推送先到,批量不回退。
    expect(getGhostCardEntry('msg-clientid')).toMatchObject({ status: 'ready', html: '<p>live</p>' });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('ensureSessionCards:取件失败允许重试(loadedSessions 回滚)', async () => {
    const list = vi
      .fn<() => Promise<ListResult>>()
      .mockRejectedValueOnce(new Error('ipc down'))
      .mockResolvedValueOnce({ cards: [{ callId: 'c9', ghostId: 'g', html: '<p>ok</p>', height: 160 }] });
    mockApi(undefined, list as unknown as (id: string) => Promise<ListResult>);
    ensureSessionCards('s1');
    // 首次失败后 loadedSessions 回滚(catch 内),再次调用才真正重取。轮询驱动:
    // loadedSessions 仍占位时 ensureSessionCards 是 no-op,清空后下一次触发 resolved 调用。
    await vi.waitFor(() => {
      ensureSessionCards('s1');
      expect(getGhostCardEntry('c9')).toMatchObject({ status: 'ready' });
    });
  });
});
