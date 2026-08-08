/**
 * dispatchMakerEventBatch.test.ts — `maker:event` 微批转发的行为契约。
 * ---------------------------------------------------------------------------
 * 微批把「每事件一帧」压成「每窗口一帧」,是这条链路上唯一削减**出站帧数**的
 * 手段(#2167 只改拥塞取舍、#2185 只推迟重连,都不减帧)。四条不变量:
 *  1. 能力协商:只有声明 maker-event-batch-v1 的控制端收批,旧控制端照旧逐帧;
 *  2. 无损与保序:批内事件是原 payload 原样序列,顺序即产生顺序,不跨会话合并;
 *  3. 到量即发:条数上限不等窗口(长思考不把单帧撑大到需要分片);
 *  4. 生命周期:退订该会话 / link-close / 控制端离线都不再投递;背压不丢事件。
 * mock 面与 dispatchSendSafety.test.ts 一致:只 mock electron + settings。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DeviceLinkError,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  DL_SUBSCRIBE_CHANNEL,
  DL_UNSUBSCRIBE_CHANNEL,
  MAKER_EVENT_BATCH_CHANNEL,
  isCoalesciblePushChannel,
  SESSION_ACTIVITY_CHANNEL,
  topicForPush,
  type MakerEventBatchPayload,
} from '@cindy/device-link';

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '/tmp/xdt-maker-test/app',
    getPath: () => '/tmp/xdt-maker-test',
    getVersion: () => '0.0.0-test',
  },
  powerSaveBlocker: { start: () => 0, stop: () => {}, isStarted: () => false },
  nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
}));
const deviceLinkSettings = vi.hoisted(() => ({
  value: {
    remoteControlEnabled: true,
    revokedControllers: [] as string[],
  },
}));
vi.mock('../settings-store', () => ({
  readDeviceLinkSettings: () => deviceLinkSettings.value,
}));

import {
  __testing,
  flushMakerEventBatchesOnReconnect,
  handleControllerOffline,
} from '../dispatch';
import * as subscriptions from '../subscriptions';

/** 微批窗口与退避间隔(dispatch 内部常量);推进定时器用。 */
const WINDOW_MS = 120;
const MAKER_EVENT_BATCH_RETRY_MS = 250;

type SentPush = { dst: string; channel: string; payload: unknown; ownerStamp?: unknown };

function mkClient(over: { sendPush?: ReturnType<typeof vi.fn> } = {}) {
  const sent: SentPush[] = [];
  const sendPush = over.sendPush
    ?? vi.fn((dst: string, channel: string, payload: unknown, ownerStamp?: unknown) => {
      sent.push({ dst, channel, payload, ownerStamp });
    });
  return {
    client: {
      getStatus: vi.fn(() => 'online'),
      sendPush,
      sendInvokeResult: vi.fn(),
      sendLinkAccept: vi.fn(),
      closeLink: vi.fn(),
      onFrame: vi.fn(),
      getReliableSendQueueDepth: vi.fn(() => 0),
    },
    sent,
    sendPush,
  };
}

/** 注册一个声明了微批能力的控制端。 */
function subscribeBatchController(id: string, topics: string[]): void {
  subscriptions.subscribe(id, topics, id, [CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1]);
}

function batchesIn(sent: SentPush[]): MakerEventBatchPayload[] {
  return sent
    .filter((s) => s.channel === MAKER_EVENT_BATCH_CHANNEL)
    .map((s) => s.payload as MakerEventBatchPayload);
}

beforeEach(() => {
  vi.useFakeTimers();
  deviceLinkSettings.value = { remoteControlEnabled: true, revokedControllers: [] };
  __testing.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[1] 能力协商', () => {
  it('声明能力的控制端:窗口内多条事件合并成一帧批,不再每事件一帧', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-batch', ['session:s1']);

    for (let i = 0; i < 5; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }
    // 窗口未到:一帧都还没发(这正是削减帧数的来源)
    expect(h.sent).toHaveLength(0);

    vi.advanceTimersByTime(WINDOW_MS);
    const batches = batchesIn(h.sent);
    expect(h.sent).toHaveLength(1);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.sessionId).toBe('s1');
    expect(batches[0]!.events).toHaveLength(5);
  });

  it('未声明能力的控制端(旧版本):照旧逐帧,零感知', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscriptions.subscribe('ctrl-legacy', ['session:s1'], 'legacy');

    for (let i = 0; i < 3; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }
    expect(h.sent).toHaveLength(3);
    expect(h.sent.every((s) => s.channel === 'maker:event')).toBe(true);
    vi.advanceTimersByTime(WINDOW_MS * 3);
    expect(h.sent).toHaveLength(3); // 没有额外的批帧
  });

  it('新旧控制端共存:各走各的路径,互不影响', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-new', ['session:s1']);
    subscriptions.subscribe('ctrl-old', ['session:s1'], 'old');

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 0 } });
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 1 } });
    // 旧控制端已收到两帧;新控制端还在攒批
    expect(h.sent.filter((s) => s.dst === 'ctrl-old')).toHaveLength(2);
    expect(h.sent.filter((s) => s.dst === 'ctrl-new')).toHaveLength(0);

    vi.advanceTimersByTime(WINDOW_MS);
    const newSent = h.sent.filter((s) => s.dst === 'ctrl-new');
    expect(newSent).toHaveLength(1);
    expect((newSent[0]!.payload as MakerEventBatchPayload).events).toHaveLength(2);
  });
});

describe('[2] 无损与保序', () => {
  it('批内事件是原 payload 原样序列,顺序即产生顺序', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    const originals = [0, 1, 2].map((i) => ({ sessionId: 's1', event: { seq: i } }));
    for (const p of originals) __testing.forwardPush('maker:event', p);
    vi.advanceTimersByTime(WINDOW_MS);

    const batch = batchesIn(h.sent)[0]!;
    expect(batch.events).toEqual(originals);
  });

  it('不跨会话合并:每个会话一帧批(否则 topic 路由算不出)', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1', 'session:s2']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { a: 1 } });
    __testing.forwardPush('maker:event', { sessionId: 's2', event: { b: 1 } });
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { a: 2 } });
    vi.advanceTimersByTime(WINDOW_MS);

    const batches = batchesIn(h.sent);
    expect(batches).toHaveLength(2);
    expect(batches.find((b) => b.sessionId === 's1')!.events).toHaveLength(2);
    expect(batches.find((b) => b.sessionId === 's2')!.events).toHaveLength(1);
  });

  it('批帧的 topic 路由与逐帧一致(顶层 sessionId → session:<id>)', () => {
    // 微批刻意复用 topicForPush 的 session-scoped 兜底分支,不改 topics.ts。
    const payload: MakerEventBatchPayload = { sessionId: 's9', events: [{}] };
    expect(topicForPush(MAKER_EVENT_BATCH_CHANNEL, payload)).toBe('session:s9');
    expect(topicForPush('maker:event', { sessionId: 's9' })).toBe('session:s9');
  });
});

describe('[3] 到量即发', () => {
  it('条数达上限:立即 flush,不等窗口(不把单帧撑到需要分片)', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    for (let i = 0; i < 64; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }
    // 第 64 条触发上限 flush,定时器还没到点
    expect(batchesIn(h.sent)).toHaveLength(1);
    expect(batchesIn(h.sent)[0]!.events).toHaveLength(64);

    // 后续事件进入新批,按窗口发出
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 64 } });
    vi.advanceTimersByTime(WINDOW_MS);
    expect(batchesIn(h.sent)).toHaveLength(2);
    expect(batchesIn(h.sent)[1]!.events).toHaveLength(1);
  });
});

describe('[4] 生命周期与背压', () => {
  it('退订 session:<id>:该会话待发批不再投递', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1', 'session:s2']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    __testing.forwardPush('maker:event', { sessionId: 's2', event: {} });
    __testing.handleSubscriptionFrame('ctrl-1', {
      channel: DL_UNSUBSCRIBE_CHANNEL,
      args: [{ topics: ['session:s1'] }],
    });
    vi.advanceTimersByTime(WINDOW_MS);

    const batches = batchesIn(h.sent);
    expect(batches.map((b) => b.sessionId)).toEqual(['s2']); // s1 已丢弃
  });

  it('控制端离线:待发批清空,不在恢复后补投陈旧事件', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    handleControllerOffline('ctrl-1');
    vi.advanceTimersByTime(WINDOW_MS * 3);
    expect(h.sent).toHaveLength(0);
  });

  it('发送失败即就地降级为逐帧 best-effort,缓冲不跨越失败存在', () => {
    // 强不变量(review 四轮结论):flush 返回时缓冲必为空——要么整批发出,要么
    // 降级逐帧(旧语义)。缓冲不滞留 = 顺序问题整族消失。
    const sendPush = vi.fn((
      _dst: string,
      channel: string,
      _payload: unknown,
      _ownerStamp?: unknown,
    ) => {
      if (channel === MAKER_EVENT_BATCH_CHANNEL) {
        throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
      }
    });
    const h = mkClient({ sendPush });
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 0 } });
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 1 } });
    vi.advanceTimersByTime(WINDOW_MS);

    // 批被拒 → 两条事件各自以逐帧 maker:event 发出(顺序不变)
    const perEvent = sendPush.mock.calls.filter((c) => c[1] === 'maker:event');
    expect(perEvent).toHaveLength(2);
    expect(perEvent.map((c) => (c[2] as { event: { i: number } }).event.i)).toEqual([0, 1]);

    // 缓冲已空:再推进任何时间都不会有第二次投递
    const before = sendPush.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(sendPush.mock.calls.length).toBe(before);
  });

  it('relay 离线:同样就地降级(逐帧 best-effort 自行吞掉失败),不滞留', () => {
    let status = 'online';
    const h = mkClient();
    h.client.getStatus = vi.fn(() => status) as never;
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    status = 'connecting';
    vi.advanceTimersByTime(WINDOW_MS);

    // 未以批帧发出;缓冲已空,不会在恢复后突然补投陈旧事件
    expect(batchesIn(h.sent)).toHaveLength(0);
    status = 'online';
    vi.advanceTimersByTime(10_000);
    expect(batchesIn(h.sent)).toHaveLength(0);
  });
});

describe('[5] 与拥塞取舍(#2167)的一致性', () => {
  it('批 channel 与 maker:event 同属可驱逐档:拥塞时不退回 BACKPRESSURE 风暴', () => {
    // 漏登记会让启用微批的控制端在拥塞时重新遭遇逐帧 BACKPRESSURE——正是微批要
    // 消除的那一个。直接问判据函数(client.ts 的唯一入口),不耦合源码文本。
    expect(isCoalesciblePushChannel('maker:event')).toBe(true);
    expect(isCoalesciblePushChannel(MAKER_EVENT_BATCH_CHANNEL)).toBe(true);
    // 反向:不可合并的事件流不得混进该档
    expect(isCoalesciblePushChannel('local-db:messages:created')).toBe(false);
    expect(isCoalesciblePushChannel('maker:interaction-request')).toBe(false);
  });
});

describe('[7] 归属切换分段(review 首轮 P1)', () => {
  it('窗口内 ownerStamp 切换:分两段按序发出,各段带自己的水印', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);
    const stampA = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    const stampB = { dataOwnerId: 'owner-b', ownerGeneration: 2 };

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 0 } }, stampA);
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 1 } }, stampB);
    vi.advanceTimersByTime(WINDOW_MS);

    const batches = batchesIn(h.sent);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.events).toEqual([{ sessionId: 's1', event: { i: 0 } }]);
    expect(batches[1]!.events).toEqual([{ sessionId: 's1', event: { i: 1 } }]);
    expect(h.sent[0]!.ownerStamp).toEqual(stampA);
    expect(h.sent[1]!.ownerStamp).toEqual(stampB);
  });
});

describe('[8] 跨 channel 顺序(review 首轮 P2)', () => {
  it('同会话的其它推送先收口事件批:确认卡不会插到攒批的文本前面', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { text: 'delta' } });
    expect(h.sent).toHaveLength(0); // 还在攒批

    // 紧跟一条有顺序语义的同会话推送:必须先把批发出去
    __testing.forwardPush('maker:interaction-request', { sessionId: 's1', request: { id: 'r1' } });
    expect(h.sent.map((s) => s.channel)).toEqual([
      MAKER_EVENT_BATCH_CHANNEL,
      'maker:interaction-request',
    ]);
  });

  it('其它会话的推送不触发本会话收口(按 sessionId 精确)', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1', 'session:s2']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    __testing.forwardPush('maker:status-changed', { sessionId: 's2', status: 'closed' });
    // s1 的批未被 s2 的推送带出去
    expect(h.sent.map((s) => s.channel)).toEqual(['maker:status-changed']);

    vi.advanceTimersByTime(WINDOW_MS);
    expect(batchesIn(h.sent)).toHaveLength(1);
  });
});

describe('[10] 收敛检查点:主动发送闸门的全部入口与边界(review 第二轮)', () => {
  it('activity 终态也先收口事件批:收口在所有 session-scoped 分支之前', () => {
    // 第二轮实测漏洞:activity 分支自带 continue,收口放在它之后就永不生效,
    // 手机端会先收到 completed(结束流式)再收到之前的文本批。
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1', 'sessions']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { text: 'delta' } });
    expect(h.sent).toHaveLength(0);
    __testing.forwardPush(SESSION_ACTIVITY_CHANNEL, { sessionId: 's1', phase: 'completed' });

    // 批必须先于 activity 发出
    expect(h.sent[0]!.channel).toBe(MAKER_EVENT_BATCH_CHANNEL);
    expect(h.sent.some((s) => s.channel === SESSION_ACTIVITY_CHANNEL)).toBe(true);
    expect(h.sent.findIndex((s) => s.channel === MAKER_EVENT_BATCH_CHANNEL))
      .toBeLessThan(h.sent.findIndex((s) => s.channel === SESSION_ACTIVITY_CHANNEL));
  });

  it('批发送失败后缓冲即空:交错 push 不会与滞留批产生顺序竞争', () => {
    // 第四轮的根因:只要缓冲能跨越失败存在,大批被拒而小终态帧通过就会乱序。
    // 现在 flush 返回即空,交错 push 之前不可能存在"待发批"。
    const sendPush = vi.fn((
      _dst: string,
      channel: string,
      _payload: unknown,
      _ownerStamp?: unknown,
    ) => {
      if (channel === MAKER_EVENT_BATCH_CHANNEL) {
        throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
      }
    });
    const h = mkClient({ sendPush });
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { text: 'delta' } });
    // 交错帧触发收口:批被拒 → 降级逐帧,缓冲清空
    __testing.forwardPush('maker:status-changed', { sessionId: 's1', status: 'closed' });

    const channels = sendPush.mock.calls.map((c) => c[1]);
    // 顺序:批尝试 → 降级的逐帧事件 → 终态帧
    expect(channels).toEqual([
      MAKER_EVENT_BATCH_CHANNEL,
      'maker:event',
      'maker:status-changed',
    ]);
    // 之后不再有任何滞留投递
    const before = sendPush.mock.calls.length;
    vi.advanceTimersByTime(10_000);
    expect(sendPush.mock.calls.length).toBe(before);
  });

  it('单会话事件量远超单批上限:按上限切片,每帧不超限且顺序无损', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    // 200 条:到量 flush 三次(64×3),余 8 条随窗口发出
    for (let i = 0; i < 200; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }
    vi.advanceTimersByTime(WINDOW_MS);

    const batches = batchesIn(h.sent);
    expect(batches.every((b) => b.events.length <= 64)).toBe(true);
    expect(batches.reduce((n, b) => n + b.events.length, 0)).toBe(200);
    const flat = batches.flatMap((b) => b.events) as Array<{ event: { i: number } }>;
    expect(flat.map((e) => e.event.i)).toEqual([...Array(200).keys()]);
  });

  it('单条即超批字节上限的事件走逐帧路径(保留 compact 兜底),且排在批之后', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 0 } });
    // 单条 ~300KB UTF-8:不入批,先收口批再逐帧发
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { big: 'x'.repeat(300_000) } });

    expect(h.sent.map((s) => s.channel)).toEqual([
      MAKER_EVENT_BATCH_CHANNEL,
      'maker:event',
    ]);
    expect((h.sent[0]!.payload as MakerEventBatchPayload).events).toHaveLength(1);
  });
});

describe('[11] 重连恢复的顺序(review 第三轮)', () => {
  it('订阅重放 drain 离线积压之前先排空断线前的事件批', () => {
    // 断线期间同会话的新事件/终态进 offlinePushQueue,旧批留在内存等重试;
    // 不先收口就会让新帧先于断线前的文本送达,重现「终态后冒出文本」。
    let status = 'online';
    const h = mkClient();
    h.client.getStatus = vi.fn(() => status) as never;
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    // 在线时入批(窗口未到)
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { text: 'before-drop' } });
    expect(h.sent).toHaveLength(0);

    // relay 断线:同会话新事件进离线积压
    status = 'connecting';
    __testing.forwardPush('maker:status-changed', { sessionId: 's1', status: 'closed' });
    expect(h.sent).toHaveLength(0);

    // 重连 + 控制端重新订阅:批必须先于积压投递
    status = 'online';
    __testing.handleSubscriptionFrame('ctrl-1', {
      channel: DL_SUBSCRIBE_CHANNEL,
      args: [{ topics: ['session:s1'], capabilities: [CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1] }],
    });

    const channels = h.sent.map((s) => s.channel);
    expect(channels.indexOf(MAKER_EVENT_BATCH_CHANNEL)).toBe(0);
    expect(channels).toContain('maker:status-changed');
    expect(channels.indexOf(MAKER_EVENT_BATCH_CHANNEL))
      .toBeLessThan(channels.indexOf('maker:status-changed'));
  });

  it('ws-online 收口入口:窗口内的批在重连后立即投出,不落到积压之后', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    // 窗口内(尚未到点)发生重连事件:批应被立即收口
    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    expect(h.sent).toHaveLength(0);
    flushMakerEventBatchesOnReconnect();
    expect(batchesIn(h.sent)).toHaveLength(1);
  });
});

describe('[9] 字节估算按 UTF-8(review 首轮)', () => {
  it('多字节内容按 UTF-8 计:中文事件到量 flush,阈值不被 UTF-16 低估架空', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    // 每条约 30KB UTF-8(中文 3 字节/字);9 条即越过 256KB 字节阈值,
    // 而按 UTF-16 码元只有约 90K「长度」——旧估算不会触发 flush。
    const text = '中'.repeat(10_000);
    for (let i = 0; i < 9; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { text } });
    }
    // 未到条数上限(64)就已发出:证明字节阈值生效(按 UTF-16 计不会触发)
    const batches = batchesIn(h.sent);
    expect(batches.length).toBeGreaterThan(0);
    // 且每帧都在字节上限内(切片保证),事件一条不丢
    for (const b of batches) {
      const bytes = Buffer.byteLength(JSON.stringify(b.events), 'utf8');
      expect(bytes).toBeLessThanOrEqual(256 * 1024);
    }
    vi.advanceTimersByTime(WINDOW_MS);
    expect(batchesIn(h.sent).reduce((n, b) => n + b.events.length, 0)).toBe(9);
  });
});

describe('[6] 帧数削减度量', () => {
  it('长思考洪峰:100 条事件从 100 帧压到 2 帧(条数上限 + 窗口各一次)', () => {
    const h = mkClient();
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    for (let i = 0; i < 100; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }
    vi.advanceTimersByTime(WINDOW_MS);

    const batches = batchesIn(h.sent);
    expect(h.sent).toHaveLength(2);
    expect(batches[0]!.events).toHaveLength(64);
    expect(batches[1]!.events).toHaveLength(36);
    // 事件一条不丢
    expect(batches.reduce((n, b) => n + b.events.length, 0)).toBe(100);
  });
});
