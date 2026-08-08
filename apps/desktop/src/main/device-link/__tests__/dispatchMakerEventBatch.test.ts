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

  it('背压:事件保留在缓冲里退避重试,不丢;恢复后一并发出', () => {
    let failing = true;
    const sendPush = vi.fn((_dst: string, channel: string, _payload: unknown) => {
      if (failing && channel === MAKER_EVENT_BATCH_CHANNEL) {
        throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
      }
    });
    const h = mkClient({ sendPush });
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 0 } });
    vi.advanceTimersByTime(WINDOW_MS);
    expect(sendPush).toHaveBeenCalledTimes(1); // 首次尝试遭背压

    // 背压期间继续产生事件:累积进同一批,不丢
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 1 } });
    failing = false;
    vi.advanceTimersByTime(MAKER_EVENT_BATCH_RETRY_MS); // 退避重试间隔
    const batch = sendPush.mock.calls.at(-1)![2] as MakerEventBatchPayload;
    expect(batch.events).toHaveLength(2);
    expect(batch.events).toEqual([
      { sessionId: 's1', event: { i: 0 } },
      { sessionId: 's1', event: { i: 1 } },
    ]);
  });

  it('relay 离线:不发送、保留事件,上线后由重试投出', () => {
    const h = mkClient();
    let status = 'connecting';
    h.client.getStatus = vi.fn(() => status) as never;
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    // 离线期间 forwardPush 走离线队列而非批(liveTargets 为空),这里直接验证
    // 批 stage 在 relay 离线时不会盲发:先在线入批,再切离线推进窗口。
    status = 'online';
    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    status = 'connecting';
    vi.advanceTimersByTime(WINDOW_MS);
    expect(h.sent).toHaveLength(0);

    status = 'online';
    vi.advanceTimersByTime(MAKER_EVENT_BATCH_RETRY_MS);
    expect(batchesIn(h.sent)).toHaveLength(1);
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

describe('[7] 归属切换与背压的交互(review 首轮 P1)', () => {
  it('ownerStamp 切换且旧段正背压:旧段不被覆盖,恢复后按段序全部发出', () => {
    let failing = true;
    const sendPush = vi.fn((
      _dst: string,
      channel: string,
      _payload: unknown,
      _ownerStamp?: unknown,
    ) => {
      if (failing && channel === MAKER_EVENT_BATCH_CHANNEL) {
        throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
      }
    });
    const h = mkClient({ sendPush });
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);
    const stampA = { dataOwnerId: 'owner-a', ownerGeneration: 1 };
    const stampB = { dataOwnerId: 'owner-b', ownerGeneration: 2 };

    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 0 } }, stampA);
    vi.advanceTimersByTime(WINDOW_MS); // 首次 flush 遭背压,旧段保留
    expect(sendPush).toHaveBeenCalledTimes(1);

    // 归属切换:新事件必须进新段,绝不能覆盖仍待重试的旧段
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 1 } }, stampB);
    failing = false;
    vi.advanceTimersByTime(MAKER_EVENT_BATCH_RETRY_MS);

    // 自定义 sendPush 不填充 h.sent,直接读 mock.calls:[dst, channel, payload, ownerStamp]
    const delivered = sendPush.mock.calls.filter((c) => c[1] === MAKER_EVENT_BATCH_CHANNEL);
    const succeeded = delivered.slice(1); // 第 1 次是遭背压那次
    expect(succeeded).toHaveLength(2);
    expect((succeeded[0]![2] as MakerEventBatchPayload).events)
      .toEqual([{ sessionId: 's1', event: { i: 0 } }]);
    expect((succeeded[1]![2] as MakerEventBatchPayload).events)
      .toEqual([{ sessionId: 's1', event: { i: 1 } }]);
    // 段序 = 归属切换顺序,ownerStamp 分别随段下发
    expect(succeeded[0]![3]).toEqual(stampA);
    expect(succeeded[1]![3]).toEqual(stampB);
  });

  it('持续背压 + 到量:不退化为逐事件同步 sendPush(退避期间不插队)', () => {
    const sendPush = vi.fn((_dst: string, channel: string, _payload: unknown) => {
      if (channel === MAKER_EVENT_BATCH_CHANNEL) {
        throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
      }
    });
    const h = mkClient({ sendPush });
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    // 先攒到量触发一次 flush(遭背压)
    for (let i = 0; i < 64; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }
    expect(sendPush).toHaveBeenCalledTimes(1);

    // 再来 64 条:退避中,一次都不该再同步发送(旧实现每条都会试一次)
    for (let i = 64; i < 128; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }
    expect(sendPush).toHaveBeenCalledTimes(1);

    // 退避到点才重试一次
    vi.advanceTimersByTime(MAKER_EVENT_BATCH_RETRY_MS);
    expect(sendPush).toHaveBeenCalledTimes(2);
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

  it('退避中跨 channel 收口不再尝试:交错 push 不产生额外的注定失败发送', () => {
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

    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    vi.advanceTimersByTime(WINDOW_MS);
    const batchAttempts = () =>
      sendPush.mock.calls.filter((c) => c[1] === MAKER_EVENT_BATCH_CHANNEL).length;
    expect(batchAttempts()).toBe(1); // 退避已生效

    // 交错 10 条同会话其它 channel:一次都不该再试批
    for (let i = 0; i < 10; i++) {
      __testing.forwardPush('maker:status-changed', { sessionId: 's1', status: 'running' });
    }
    expect(batchAttempts()).toBe(1);
  });

  it('待重试段按上限切片发送:不把滞留段撑成一个超限逻辑消息', () => {
    let failing = true;
    const sendPush = vi.fn((
      _dst: string,
      channel: string,
      _payload: unknown,
      _ownerStamp?: unknown,
    ) => {
      if (failing && channel === MAKER_EVENT_BATCH_CHANNEL) {
        throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
      }
    });
    const h = mkClient({ sendPush });
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    // 触发退避,然后在退避期间累积到远超单批上限(64)的事件量
    __testing.forwardPush('maker:event', { sessionId: 's1', event: { i: 0 } });
    vi.advanceTimersByTime(WINDOW_MS);
    for (let i = 1; i < 200; i++) {
      __testing.forwardPush('maker:event', { sessionId: 's1', event: { i } });
    }

    failing = false;
    vi.advanceTimersByTime(MAKER_EVENT_BATCH_RETRY_MS);
    const delivered = sendPush.mock.calls
      .filter((c) => c[1] === MAKER_EVENT_BATCH_CHANNEL)
      .slice(1) // 第 1 次是遭背压那次
      .map((c) => c[2] as MakerEventBatchPayload);
    // 200 条按 64 上限切成 4 片(64+64+64+8),每片都不超上限,事件一条不丢
    expect(delivered.every((b) => b.events.length <= 64)).toBe(true);
    expect(delivered.reduce((n, b) => n + b.events.length, 0)).toBe(200);
    // 切片顺序 = 原始顺序
    const flat = delivered.flatMap((b) => b.events) as Array<{ event: { i: number } }>;
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

  it('ws-online 收口入口清掉断线时的退避位,批不被闸门永久卡住', () => {
    let status = 'online';
    const h = mkClient();
    h.client.getStatus = vi.fn(() => status) as never;
    __testing.setActiveClient(h.client as never);
    subscribeBatchController('ctrl-1', ['session:s1']);

    __testing.forwardPush('maker:event', { sessionId: 's1', event: {} });
    // 断线期间窗口到点:flush 失败并置退避位
    status = 'connecting';
    vi.advanceTimersByTime(WINDOW_MS);
    expect(h.sent).toHaveLength(0);

    // 重连事件:清退避位并立即投出
    status = 'online';
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
