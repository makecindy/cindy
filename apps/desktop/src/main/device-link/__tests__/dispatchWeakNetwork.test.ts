/**
 * dispatchWeakNetwork.test.ts — 被控端弱网收尾行为契约。
 * -------------------------------------------------------------------------
 * 三条不变量(2026-08-03 弱网实测暴露):
 *  1. link-accept 发送失败(WS 背压)不再静默放弃:短退避有限重试,重试前
 *     复验开关/连接,成功才提交订阅;耗尽/断线/新 open 都会终止旧重试。
 *  2. invoke-result outbox 在 relay 离线期间不自旋:不 trySend、不刷日志,
 *     只做慢速 TTL 出清;ws-online 事件触发立即投递。
 *  3. outbox 条目保留时长按 channel 的控制端等待预算收窄(×2,封顶全局
 *     120s):控制端早已超时放弃的回包不再白占两分钟配额。
 * mock 面与 dispatchSendSafety.test.ts 一致:只 mock electron + settings。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DeviceLinkClient,
  DeviceLinkError,
  DL_SUBSCRIBE_CHANNEL,
  INVOKE_TIMEOUT_OVERRIDES_MS,
  PROTOCOL_VERSION,
  type Envelope,
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
  deactivateAllControllers,
  deactivateController,
  flushRemoteInvokeResultOutboxOnReconnect,
  handleControllerOffline,
  setControllersChangedListener,
  setDispatchPresenceOfflineCheck,
  wireInboundDispatch,
} from '../dispatch';
import * as subscriptions from '../subscriptions';

function mkClient(
  over: Partial<{
    getConnectionEpoch: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    sendInvokeResult: ReturnType<typeof vi.fn>;
    sendLinkAccept: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    getConnectionEpoch: over.getConnectionEpoch ?? vi.fn(() => 1),
    getStatus: over.getStatus ?? vi.fn(() => 'online'),
    sendInvokeResult: over.sendInvokeResult ?? vi.fn(),
    sendLinkAccept: over.sendLinkAccept ?? vi.fn(),
    closeLink: vi.fn(),
    onFrame: vi.fn(),
    sendPush: vi.fn(),
  };
}

const backpressure = () => new DeviceLinkError('BACKPRESSURE', 'websocket send buffer is full');
const notConnected = () => new DeviceLinkError('NOT_CONNECTED', 'not connected to relay');

type LinkedWsHandler = (...args: never[]) => void;

/** 只保留这轮回归需要的最小内存 relay:真实 DeviceLinkClient 互相建链,可按目的地注入离线。 */
class DispatchTestWs {
  readonly sent: Envelope[] = [];
  readonly bufferedAmount = 0;
  private readonly handlers = new Map<string, LinkedWsHandler[]>();

  constructor(
    private readonly relay: DispatchTestRelay,
    readonly ownerId: string,
  ) {}

  send(data: string): void {
    const envelope = JSON.parse(data) as Envelope;
    this.sent.push(envelope);
    this.relay.route(this.ownerId, this, envelope);
  }

  close(code = 1000, reason = ''): void {
    this.emit('close', code, reason);
  }

  terminate(): void {
    this.emit('close', 1006, 'terminated');
  }

  on(event: string, cb: LinkedWsHandler): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(cb);
    this.handlers.set(event, handlers);
  }

  push(envelope: Envelope): void {
    this.emit('message', { toString: () => JSON.stringify(envelope) });
  }

  open(): void {
    this.emit('open');
  }

  private emit(event: string, ...args: unknown[]): void {
    for (const cb of this.handlers.get(event) ?? []) cb(...(args as never[]));
  }
}

class DispatchTestRelay {
  private readonly sockets = new Map<string, DispatchTestWs>();
  private holdPredicate: ((senderId: string, envelope: Envelope) => boolean) | null = null;
  private readonly held: Array<{ senderId: string; envelope: Envelope }> = [];
  readonly offline = new Set<string>();

  makeWebSocket(deviceId: string): DispatchTestWs {
    const socket = new DispatchTestWs(this, deviceId);
    this.sockets.set(deviceId, socket);
    setTimeout(() => socket.open(), 0);
    return socket;
  }

  holdNext(predicate: (senderId: string, envelope: Envelope) => boolean): void {
    this.holdPredicate = predicate;
  }

  heldCount(): number {
    return this.held.length;
  }

  releaseHeld(): void {
    const held = this.held.splice(0);
    this.holdPredicate = null;
    for (const item of held) this.deliver(item.senderId, item.envelope);
  }

  route(senderId: string, socket: DispatchTestWs, envelope: Envelope): void {
    if (envelope.kind === 'hello') {
      socket.push({
        v: PROTOCOL_VERSION,
        kind: 'hello-ack',
        payload: {
          serverProtocolVersion: PROTOCOL_VERSION,
          deviceId: senderId,
          userId: 'test-user',
        },
      });
      return;
    }
    if (!envelope.dst) return;
    if (this.offline.has(envelope.dst)) {
      socket.push({
        v: PROTOCOL_VERSION,
        kind: 'relay-error',
        payload: {
          code: 'DEVICE_OFFLINE',
          message: 'target device offline',
          dst: envelope.dst,
        },
      });
      return;
    }
    if (this.holdPredicate?.(senderId, envelope)) {
      this.held.push({ senderId, envelope });
      this.holdPredicate = null;
      return;
    }
    this.deliver(senderId, envelope);
  }

  private deliver(senderId: string, envelope: Envelope): void {
    const destination = envelope.dst ? this.sockets.get(envelope.dst) : undefined;
    if (!destination) return;
    destination.push({ ...envelope, src: senderId });
  }
}

function makeDispatchTestClient(relay: DispatchTestRelay, deviceId: string): DeviceLinkClient {
  return new DeviceLinkClient({
    getWsUrl: () => 'ws://test/api/device-link/ws',
    getToken: async () => 'jwt-token',
    getHello: () => ({
      deviceName: deviceId,
      platform: 'darwin',
      appVersion: '1.0.0',
      remoteControlEnabled: true,
      busy: false,
    }),
    createWebSocket: () => relay.makeWebSocket(deviceId) as never,
    timing: {
      reconnectBaseMs: 5,
      reconnectMaxMs: 20,
      pingIntervalMs: 60_000,
      pongMissLimit: 4,
      requestTimeoutMs: 2_000,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  deviceLinkSettings.value = {
    remoteControlEnabled: true,
    revokedControllers: [],
  };
  __testing.reset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[1] link-accept 发送失败的有限重试', () => {
  it('背压首发失败 → 不提交订阅;500ms 重试成功后才提交', () => {
    const sendLinkAccept = vi.fn().mockImplementationOnce(() => {
      throw backpressure();
    });
    const client = mkClient({ sendLinkAccept });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);
    // 失败即返回:订阅未提交(幽灵订阅防护),留下一个待触发的重试
    expect(__testing.getActiveControllers()).toHaveLength(0);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(1);

    vi.advanceTimersByTime(500);
    expect(sendLinkAccept).toHaveBeenCalledTimes(2);
    expect(sendLinkAccept).toHaveBeenLastCalledWith('ctrl-a', 'open-1', expect.anything());
    // 第二次成功:订阅提交,无遗留重试
    expect(__testing.getActiveControllers().map((c) => c.deviceId)).toEqual(['ctrl-a']);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(0);
  });

  it('持续背压:按 500ms/1s/2s 重试三次后放弃,回到「等控制端重开」', () => {
    const sendLinkAccept = vi.fn(() => {
      throw backpressure();
    });
    const client = mkClient({ sendLinkAccept });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500);
    expect(sendLinkAccept).toHaveBeenCalledTimes(2);
    vi.advanceTimersByTime(1_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(2_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(4);
    // 耗尽:不再有排期
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(4);
    expect(__testing.getActiveControllers()).toHaveLength(0);
  });

  it('重试等待期间新 link-open 到达:旧重试被顶掉,只按新 requestId 回 accept', () => {
    const sendLinkAccept = vi
      .fn()
      .mockImplementationOnce(() => {
        throw backpressure();
      });
    const client = mkClient({ sendLinkAccept });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-old', undefined);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(1);
    // 控制端超时重发:新 requestId 立即处理成功
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-new', undefined);
    expect(sendLinkAccept).toHaveBeenLastCalledWith('ctrl-a', 'open-new', expect.anything());
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(0);
    // 旧重试不再触发
    vi.advanceTimersByTime(10_000);
    expect(sendLinkAccept).toHaveBeenCalledTimes(2);
  });

  it('重试触发时 relay 已断线 / 开关已关闭:放弃,不发 accept', () => {
    // 首发路径不查询连接状态;第一次 getStatus 调用发生在重试回调的世代校验里
    const getStatus = vi.fn(() => 'connecting');
    const sendLinkAccept = vi.fn(() => {
      throw backpressure();
    });
    const client = mkClient({ sendLinkAccept, getStatus: getStatus as never });
    __testing.setActiveClient(client as never);
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(500); // 触发时 getStatus() = 'connecting' → 放弃
    expect(sendLinkAccept).toHaveBeenCalledTimes(1);

    // 开关关闭场景:重试走完整 handleLinkOpen,复验后拒绝
    __testing.reset();
    const sendLinkAccept2 = vi.fn(() => {
      throw backpressure();
    });
    const client2 = mkClient({ sendLinkAccept: sendLinkAccept2 });
    __testing.setActiveClient(client2 as never);
    __testing.handleLinkOpen(client2 as never, 'ctrl-b', 'open-2', undefined);
    deviceLinkSettings.value = { remoteControlEnabled: false, revokedControllers: [] };
    vi.advanceTimersByTime(500);
    expect(sendLinkAccept2).toHaveBeenCalledTimes(1); // 复验失败,不再尝试发送
  });
});

describe('[4] 多控制端隔离:两个控制端共享同一被控端,一个静默不波及另一个', () => {
  it('ctrl-a 停止收 accept(持续背压重试→耗尽)期间与之后,ctrl-b 建链/订阅/回包全程零感知', () => {
    // 故障半径三问的被控端拓扑用例(remote-and-mobile-adaptation §3):被控端与
    // relay 只有一条连接,ctrl-a 的 link 级故障(accept 送不出去 = peer 静默形态)
    // 的全部恢复动作(有限重试→放弃)必须收在 ctrl-a 的 link 内。
    const sendLinkAccept = vi.fn((dst: string) => {
      if (dst === 'ctrl-a') throw backpressure();
    });
    const sendInvokeResult = vi.fn();
    const client = mkClient({ sendLinkAccept, sendInvokeResult });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-a', undefined);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(1);

    // a 的重试等待期间,b 建链立即成功、订阅提交
    __testing.handleLinkOpen(client as never, 'ctrl-b', 'open-b', undefined);
    expect(sendLinkAccept).toHaveBeenLastCalledWith('ctrl-b', 'open-b', expect.anything());
    expect(__testing.getActiveControllers().map((c) => c.deviceId)).toEqual(['ctrl-b']);

    // b 的在途回包照常投递,不被 a 的重试状态牵连
    expect(
      __testing.sendInvokeResultSafe(
        client as never,
        'ctrl-b',
        'req-b',
        { ok: true, result: 1 },
        'local-db:sessions:list',
      ),
    ).toBe(true);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);

    // a 重试耗尽(500ms/1s/2s)后放弃:b 的订阅仍在,恢复动作从未升级到连接层
    vi.advanceTimersByTime(4_000);
    expect(__testing.pendingLinkAcceptRetryCount()).toBe(0);
    expect(__testing.getActiveControllers().map((c) => c.deviceId)).toEqual(['ctrl-b']);
    expect(client.closeLink).not.toHaveBeenCalled();
  });
});

describe('[2] outbox 离线不自旋,上线事件驱动投递', () => {
  it('relay 离线期间 flush 不 trySend;ws-online 触发立即投递', () => {
    let status = 'connecting';
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw notConnected();
    });
    const client = mkClient({
      sendInvokeResult,
      getStatus: vi.fn(() => status) as never,
    });
    __testing.setActiveClient(client as never);

    // 首发失败入 outbox(此时 relay 离线)
    expect(
      __testing.sendInvokeResultSafe(
        client as never,
        'ctrl-a',
        'req-1',
        { ok: true, result: 1 },
        'local-db:sessions:list',
      ),
    ).toBe(true);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);
    expect(sendInvokeResult).toHaveBeenCalledTimes(1);

    // 离线期间多轮慢扫描:不再尝试发送(无 NOT_CONNECTED 自旋)
    vi.advanceTimersByTime(20_000);
    expect(sendInvokeResult).toHaveBeenCalledTimes(1);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 上线事件:立即投递成功
    status = 'online';
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);
  });
});

describe('[5] outbox flush 的 presence 显式离线门禁', () => {
  it('presence 明确离线的控制端本轮跳过(条目保留),在线控制端照常投递;设备回归后可投', () => {
    // 门禁要掐掉的是**同一连接代内**的稳态盲发:relay 在线时全量轮每 500ms 跑一次
    // (REMOTE_INVOKE_RESULT_OUTBOX_RETRY_MS),对 presence 已明说离线的控制端就是
    // 2 帧/秒的 DEVICE_OFFLINE 稳定输出,直到 TTL 出清——纯粹喂 relay 聚合背压。
    // 门禁按 src 隔离:一个离线控制端不影响其它控制端本轮的投递。
    const offline = new Set(['ctrl-offline']);
    setDispatchPresenceOfflineCheck((id) => offline.has(id));
    const sendInvokeResult = vi.fn().mockImplementation(() => {
      throw notConnected();
    });
    const client = mkClient({ sendInvokeResult });
    __testing.setActiveClient(client as never);

    // 两个控制端各一条 outbox 积压(首发失败入队)
    for (const src of ['ctrl-offline', 'ctrl-online']) {
      __testing.sendInvokeResultSafe(
        client as never,
        src,
        `req-${src}`,
        { ok: true, result: 1 },
        'local-db:sessions:list',
      );
    }
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(2);

    // ws-online 全量 flush:离线者被门禁跳过(不 trySend),在线者投递成功
    sendInvokeResult.mockImplementation(() => {});
    const callsBefore = sendInvokeResult.mock.calls.length;
    flushRemoteInvokeResultOutboxOnReconnect();
    const flushed = sendInvokeResult.mock.calls.slice(callsBefore);
    expect(flushed.map((c) => c[0])).toEqual(['ctrl-online']);
    // 离线者的条目保留(TTL 照常),没有被丢弃
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 设备回归(presence 翻转):下一次 flush 正常投递
    offline.clear();
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult).toHaveBeenLastCalledWith(
      'ctrl-offline',
      'req-ctrl-offline',
      expect.anything(),
    );
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);
  });

  it('定向 flush(link-open 触发)不受门禁约束:对端已主动建链是更强的在线证据', () => {
    // review P2:presence 短暂滞后/误报为 offline 时,不得把「对端刚 link-open」
    // 这条恢复事件一并拦死——定向轮(onlySrc)必须照常投递。
    setDispatchPresenceOfflineCheck(() => true); // 极端:判据说所有设备都离线
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw notConnected();
    });
    const client = mkClient({ sendInvokeResult });
    __testing.setActiveClient(client as never);
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-1',
      { ok: true, result: 1 },
      'local-db:sessions:list',
    );
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 全量轮:被门禁挡住(条目保留)
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 定向轮(link-open 路径):不看门禁,直接投递
    __testing.flushRemoteInvokeResultOutbox('ctrl-a');
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);
  });

  it('presence 滞后为 offline 但控制端已 link-open 回归:全量轮不再拦它(定向轮失败后的无参重试照样投递)', () => {
    // codex review 同族第 3 次指出的缺口:定向轮首发被 BACKPRESSURE 打回后,末尾排的
    // 重试是**无参全量轮**、丢掉 onlySrc 证据 —— 判据若只看 presence,这个已建链的
    // peer 会被持续跳过到 presence 更新或 TTL 丢结果。判据带上 accepted link 后 fail-open。
    setDispatchPresenceOfflineCheck(() => true); // presence 停留在陈旧的 offline
    const sendInvokeResult = vi.fn().mockImplementation(() => {
      throw backpressure();
    });
    const client = mkClient({ sendInvokeResult });
    __testing.setActiveClient(client as never);
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-1',
      { ok: true, result: 1 },
      'local-db:sessions:list',
    );
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 还没有 accepted link:全量轮被门禁挡住(不 trySend)
    let calls = sendInvokeResult.mock.calls.length;
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult.mock.calls.length).toBe(calls);

    // 控制端 link-open 回归 → accepted link 成立;它触发的定向轮仍被背压打回,
    // 条目保留、末尾排下无参全量重试。
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(__testing.getActiveControllers().map((c) => c.deviceId)).toEqual(['ctrl-a']);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 无参全量重试:presence 判据仍说离线,但 accepted link 是更新的可达证据 → 放行
    sendInvokeResult.mockImplementation(() => {});
    calls = sendInvokeResult.mock.calls.length;
    vi.advanceTimersByTime(500);
    expect(sendInvokeResult.mock.calls.length).toBeGreaterThan(calls);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);
  });

  it('presence 宣告离线拆掉 accepted link 后:全量轮重新受门禁约束', () => {
    // 可达证据不得比链路活得更久 —— presence 说离线时 index.ts 会调
    // handleControllerOffline 拆掉该控制端的 accepted link 与订阅,此后必须回到
    // 「presence 说了算」,否则一次历史建链会永久豁免门禁。
    setDispatchPresenceOfflineCheck(() => true);
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw notConnected();
    });
    const client = mkClient({ sendInvokeResult });
    __testing.setActiveClient(client as never);
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-1',
      { ok: true, result: 1 },
      'local-db:sessions:list',
    );
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // accepted link 在场:全量轮放行
    sendInvokeResult.mockImplementation(() => {
      throw notConnected();
    });
    let calls = sendInvokeResult.mock.calls.length;
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult.mock.calls.length).toBeGreaterThan(calls);

    // presence 宣告离线 → 拆链:证据随链路一起消失,门禁重新生效
    handleControllerOffline('ctrl-a');
    calls = sendInvokeResult.mock.calls.length;
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult.mock.calls.length).toBe(calls);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);
  });

  it('presence 判据未接线(null)时 fail-open:行为与门禁不存在时一致', () => {
    // __testing.reset() 已把判据清空;不接线直接 flush,验证默认路径不受影响
    const sendInvokeResult = vi.fn().mockImplementationOnce(() => {
      throw notConnected();
    });
    const client = mkClient({ sendInvokeResult });
    __testing.setActiveClient(client as never);
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-1',
      { ok: true, result: 1 },
      'local-db:sessions:list',
    );
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);
  });
});

describe('[3] outbox 保留时长按 channel 收窄', () => {
  it('锁「预算 ×2、封顶 120s」联动:表内 channel 跟随共享表,缺省 30s→60s', () => {
    // 联动语义从共享表推导,不再硬编码结果值——此断言曾在 #1418/#1477 并行开发
    // 时写死 60s(当时表里还没有 listing 条目),两 PR 各自 CI 都绿、先后合入后
    // main 变红。表值本身(12s/60s)在下面单独锁定:它们是产品决策,变更时红在
    // 这里提醒显式确认;而「×2 封顶」的联动对表变更免疫。
    const listingBudget = INVOKE_TIMEOUT_OVERRIDES_MS['local-db:sessions:list'];
    const worktreeBudget = INVOKE_TIMEOUT_OVERRIDES_MS['worktree:create'];
    expect(listingBudget).toBe(12_000);
    expect(worktreeBudget).toBe(60_000);
    expect(__testing.outboxEntryMaxAgeMs('local-db:sessions:list')).toBe(
      Math.min(listingBudget * 2, 120_000),
    );
    expect(__testing.outboxEntryMaxAgeMs(undefined)).toBe(60_000);
    expect(__testing.outboxEntryMaxAgeMs('worktree:create')).toBe(
      Math.min(worktreeBudget * 2, 120_000),
    );
  });

  it('离线慢扫描按逐条 TTL 出清:listing(24s 档)先被丢,长任务 channel 保留到 120s', () => {
    const sendInvokeResult = vi.fn(() => {
      throw notConnected();
    });
    const client = mkClient({
      sendInvokeResult,
      getStatus: vi.fn(() => 'connecting') as never,
    });
    __testing.setActiveClient(client as never);
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-listing',
      { ok: true, result: 1 },
      'local-db:sessions:list',
    );
    __testing.sendInvokeResultSafe(
      client as never,
      'ctrl-a',
      'req-worktree',
      { ok: true, result: 2 },
      'worktree:create',
    );
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(2);

    vi.advanceTimersByTime(61_000);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1); // listing 出清,worktree 保留

    vi.advanceTimersByTime(60_000);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0); // 121s:worktree 也到期
  });
});

describe('[5] orphan 截止时间按 channel 收窄', () => {
  it('默认 invoke 保持 60s，只有 compact 使用 22min 长预算', () => {
    const compactBudget = INVOKE_TIMEOUT_OVERRIDES_MS['maker:compact-session'];
    expect(compactBudget).toBe(11 * 60_000);
    expect(__testing.remoteInvokeOrphanTimeoutForChannelMs(undefined)).toBe(60_000);
    expect(__testing.remoteInvokeOrphanTimeoutForChannelMs('maker:list-active')).toBe(60_000);
    expect(__testing.remoteInvokeOrphanTimeoutForChannelMs('maker:compact-session')).toBe(
      compactBudget * 2,
    );
  });
});

describe('[6] active controller 生命周期与故障半径', () => {
  it('真实双 peer 链路中 A 的 DEVICE_OFFLINE 不清 B，B 的在途请求仍能完成', async () => {
    vi.useRealTimers();
    const relay = new DispatchTestRelay();
    const target = makeDispatchTestClient(relay, 'target');
    const controllerA = makeDispatchTestClient(relay, 'ctrl-a');
    const controllerB = makeDispatchTestClient(relay, 'ctrl-b');

    wireInboundDispatch(target);
    __testing.setActiveClient(target);
    const routeChanges: string[] = [];
    target.onPeerRouteStateChanged((change) => {
      routeChanges.push(`${change.deviceId}:${change.state}`);
      if (change.state === 'offline') handleControllerOffline(change.deviceId, change);
    });
    target.start();
    controllerA.start();
    controllerB.start();
    await vi.waitFor(() => {
      expect(target.getStatus()).toBe('online');
      expect(controllerA.getStatus()).toBe('online');
      expect(controllerB.getStatus()).toBe('online');
    });

    const openPayload = {
      controllerName: 'controller',
      protocolVersion: 1,
      appVersion: '1.0.0',
    };
    await Promise.all([
      controllerA.openLink('target', openPayload),
      controllerB.openLink('target', openPayload),
    ]);
    await expect(controllerA.invoke('target', {
      channel: DL_SUBSCRIBE_CHANNEL,
      args: [{ topics: ['session:a'], controllerName: 'A', capabilities: ['cap-a'] }],
    })).resolves.toMatchObject({ ok: true });

    relay.holdNext((senderId, envelope) => (
      senderId === 'target' && envelope.dst === 'ctrl-b' && envelope.kind === 'invoke-result'
    ));
    const pendingFromB = controllerB.invoke('target', {
      channel: DL_SUBSCRIBE_CHANNEL,
      args: [{ topics: ['session:b'], controllerName: 'B', capabilities: ['cap-b'] }],
    });
    await vi.waitFor(() => expect(relay.heldCount()).toBe(1));

    // 模拟 relay 对 target→A 的真实路由错误:DeviceLinkClient 先发 typed offline,
    // 再由 host 接入唯一的 deactivateController 状态转换。
    relay.offline.add('ctrl-a');
    target.sendInvokeResult('ctrl-a', 'offline-probe', { ok: true, result: null });

    expect(routeChanges).toContain('ctrl-a:offline');
    expect(__testing.getActiveControllers().map((controller) => controller.deviceId).sort()).toEqual([
      'ctrl-b',
    ]);
    expect(subscriptions.getKnownControllersForTopic('session:a')).toEqual(['ctrl-a']);
    expect(subscriptions.getKnownControllersForTopic('session:b')).toEqual(['ctrl-b']);
    expect(__testing.controllerSupports('ctrl-a', 'cap-a')).toBe(true);

    relay.releaseHeld();
    await expect(pendingFromB).resolves.toMatchObject({ ok: true });
    // B 的 invoke 在 A 失活期间仍完成,证明同一 relay 上的 B 控制方向未被拆掉。

    target.stop();
    controllerA.stop();
    controllerB.stop();
  });

  it('relay 断开清空所有 active projection，但保留 remembered topics/capabilities', () => {
    subscriptions.subscribe('ctrl-a', ['session:a'], 'A', ['cap-a']);
    subscriptions.subscribe('ctrl-b', ['fs-watch:/repo'], 'B', ['cap-b']);
    const changes: Array<{ active: string[]; updateRelaunch: string[] }> = [];
    setControllersChangedListener((active, updateRelaunch) => {
      changes.push({
        active: active.map((controller) => controller.deviceId),
        updateRelaunch: updateRelaunch.map((controller) => controller.deviceId),
      });
    });

    deactivateAllControllers('relay-disconnected');

    expect(__testing.getActiveControllers()).toEqual([]);
    expect(__testing.getUpdateRelaunchControllers()).toEqual([]);
    expect(subscriptions.getKnownControllersForTopic('session:a')).toEqual(['ctrl-a']);
    expect(subscriptions.getKnownControllersForTopic('fs-watch:/repo')).toEqual(['ctrl-b']);
    expect(__testing.controllerSupports('ctrl-a', 'cap-a')).toBe(true);
    expect(__testing.controllerSupports('ctrl-b', 'cap-b')).toBe(true);
    expect(changes.at(-1)).toEqual({ active: [], updateRelaunch: [] });
  });

  it('旧 connection epoch 的 offline 事件不能清掉新 link-open 的 active controller', () => {
    let connectionEpoch = 1;
    const client = mkClient({ getConnectionEpoch: vi.fn(() => connectionEpoch) });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-old', undefined);
    connectionEpoch = 2;
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-new', undefined);

    handleControllerOffline('ctrl-a', {
      deviceId: 'ctrl-a',
      state: 'offline',
      connectionEpoch: 1,
    });
    expect(__testing.getActiveControllers().map((controller) => controller.deviceId)).toEqual([
      'ctrl-a',
    ]);

    handleControllerOffline('ctrl-a', {
      deviceId: 'ctrl-a',
      state: 'offline',
      connectionEpoch: 2,
    });
    expect(__testing.getActiveControllers()).toEqual([]);
  });
});
