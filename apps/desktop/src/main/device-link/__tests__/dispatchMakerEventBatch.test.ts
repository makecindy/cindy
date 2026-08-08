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
  DL_UNSUBSCRIBE_CHANNEL,
  MAKER_EVENT_BATCH_CHANNEL,
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

import { __testing, handleControllerOffline } from '../dispatch';
import * as subscriptions from '../subscriptions';

/** 微批窗口(dispatch 内部常量);推进定时器用。 */
const WINDOW_MS = 120;

type SentPush = { dst: string; channel: string; payload: unknown };

function mkClient(over: { sendPush?: ReturnType<typeof vi.fn> } = {}) {
  const sent: SentPush[] = [];
  const sendPush = over.sendPush
    ?? vi.fn((dst: string, channel: string, payload: unknown) => {
      sent.push({ dst, channel, payload });
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
    vi.advanceTimersByTime(250); // 退避重试间隔
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
    vi.advanceTimersByTime(250);
    expect(batchesIn(h.sent)).toHaveLength(1);
  });
});

describe('[5] 与拥塞取舍(#2167)的一致性', () => {
  it('批 channel 与 maker:event 同属可驱逐档:拥塞时不退回 BACKPRESSURE 风暴', async () => {
    // 漏登记会让启用微批的控制端在拥塞时重新遭遇逐帧 BACKPRESSURE——正是微批
    // 要消除的那一个。判据正本在 packages/device-link/src/client.ts。
    const src = await import('node:fs/promises').then((fs) =>
      fs.readFile(
        new URL('../../../../../../packages/device-link/src/client.ts', import.meta.url),
        'utf8',
      ),
    );
    const table = src.slice(
      src.indexOf('const COALESCIBLE_PUSH_CHANNELS'),
      src.indexOf(']);', src.indexOf('const COALESCIBLE_PUSH_CHANNELS')),
    );
    expect(table).toContain("'maker:event'");
    expect(table).toContain('MAKER_EVENT_BATCH_CHANNEL');
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
