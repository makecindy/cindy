import { providerShareHostPeer, sharedTaskGuestPeer } from '@cindy/device-link';
import { AgentNetSessionLinks, SessionPeer, agentNetSessionLane, routeSessionPeers, type SessionLane } from '@cindy/agent-net';
import { projectScheduleEvent, type NormalizedSchedulerEvent } from '@cindy/maker-shared/schedule-events';
import { LatestStatePushStage } from '../latestStatePushStage';
import { ScheduleEventPushStage } from '../scheduleEventPushStage';
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
  createDirectRuntimeBridge,
  createDirectRuntimeHost,
  SHARED_TASK_CAPABILITY,
  DeviceLinkError,
  DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1,
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1,
  CONTROLLER_CAPABILITY_SESSION_TEXT_SNAPSHOT_V1,
  MAKER_EVENT_BATCH_CHANNEL,
  SESSION_SYNC_CHANNEL,
  DL_SUBSCRIBE_CHANNEL,
  INVOKE_TIMEOUT_OVERRIDES_MS,
  PROTOCOL_VERSION,
  TASK_MIGRATION_CHANNEL,
  TASK_MIGRATION_ESTIMATE_TIMEOUT_MS,
  resolveRemoteInvokeTimeoutMs,
  type Envelope,
  type DirectRuntime,
  type DirectRuntimeEvents,
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
const diagnosticLog = vi.hoisted(() => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), trace: vi.fn(), fatal: vi.fn(),
}));
vi.mock('../../logger', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../logger')>(),
  createLogger: () => diagnosticLog,
}));

vi.mock('../settings-store.desktop', () => ({
  readDeviceLinkSettings: () => deviceLinkSettings.value,
}));
// Observe dispatch's teardown calls without loading the unrelated desktop runtime.
vi.mock('../../remote-desktop', () => ({ remoteDesktop: { stop: vi.fn(), signalingLost: vi.fn() }, requestRemoteDesktop: vi.fn() }));
const sharedTask = vi.hoisted(() => ({ refresh: vi.fn(), capture: vi.fn() }));
vi.mock('../sharedTaskDispatch.js', async (original) => ({
  ...await original<typeof import('../sharedTaskDispatch.js')>(),
  refreshSharedTaskPeer: sharedTask.refresh,
  captureSharedTaskPeer: sharedTask.capture,
}));

import {
  __testing,
  clearControllerDisplayNames,
  getControllerDisplayName,
  setControllerDisplayName,
  setControllerFallbackDisplayName,
  deactivateAllControllers,
  flushRemoteInvokeResultOutboxOnReconnect,
  handleControllerOffline,
  setControllersChangedListener,
  setRemoteInvokeBusyChangedListener,
  setOrdinaryPeerLinkAcceptedListener,
  setDispatchPresenceOfflineCheck,
  setSessionTextSnapshotReader,
  pushSessionActivityToController,
  wireInboundDispatch,
  hasRemoteInvokeWorkForPeer,
} from '../dispatch.desktop';
import { __testing as invokeRegistry } from '../invoke-registry';
import * as subscriptions from '../subscriptions';
import { tapWindowBroadcast, tapRemoteModelCatalogChange } from '../broadcast-tap';
import { remoteDesktop } from '../../remote-desktop';

function mkClient(
  over: Partial<{
    getConnectionEpoch: ReturnType<typeof vi.fn>;
    getPeerLinkGeneration: ReturnType<typeof vi.fn>;
    getStatus: ReturnType<typeof vi.fn>;
    hasOfflineDirectPath: ReturnType<typeof vi.fn>;
    sendInvokeResult: ReturnType<typeof vi.fn>;
    sendLinkAccept: ReturnType<typeof vi.fn>;
  }> = {},
) {
  return {
    getConnectionEpoch: over.getConnectionEpoch ?? vi.fn(() => 1),
    getPeerLinkGeneration: over.getPeerLinkGeneration ?? vi.fn(() => 1),
    getStatus: over.getStatus ?? vi.fn(() => 'online'),
    hasOfflineDirectPath: over.hasOfflineDirectPath ?? vi.fn(() => false),
    sendInvokeResult: over.sendInvokeResult ?? vi.fn(),
    sendLinkAccept: over.sendLinkAccept ?? vi.fn(),
    closeLink: vi.fn(),
    onFrame: vi.fn(),
    onInboundPeerReleased: vi.fn(() => () => {}),
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
    const deliver = () => this.emit('message', { toString: () => JSON.stringify(envelope) });
    if (this.relay.asyncDelivery) queueMicrotask(deliver);
    else deliver();
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

  constructor(readonly asyncDelivery = false) {}

  disconnect(deviceId: string): void {
    this.offline.add(deviceId);
    this.sockets.get(deviceId)?.close(1006, 'test relay loss');
  }

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
    if (envelope.kind === 'ping') { socket.push({ v: PROTOCOL_VERSION, kind: 'pong' }); return; }
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
    const deliver = () => destination.push({ ...envelope, src: senderId });
    if (this.asyncDelivery) queueMicrotask(deliver);
    else deliver();
  }
}

function makeDispatchTestClient(relay: DispatchTestRelay, deviceId: string,
  options: Pick<ConstructorParameters<typeof DeviceLinkClient>[0], 'directRuntime' | 'isPeerBusy' | 'retainDirectPathsOnRelayLoss'> = {}): DeviceLinkClient {
  const continuity = options.retainDirectPathsOnRelayLoss === true;
  return new DeviceLinkClient({
    ...options,
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
      reconnectBaseMs: continuity ? 1_000_000_000 : 5,
      reconnectMaxMs: continuity ? 1_000_000_000 : 20,
      pingIntervalMs: continuity ? 1_000_000_000 : 60_000,
      pongMissLimit: 4,
      requestTimeoutMs: 2_000,
    },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  deviceLinkSettings.value = {
    remoteControlEnabled: true,
    revokedControllers: [],
  };
  __testing.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('[1] link-accept 发送失败的有限重试', () => {
  const backgroundOpen = {
    controllerName: 'background catalog reader', protocolVersion: PROTOCOL_VERSION, appVersion: '1.0.0',
    capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1],
  };
  // #8028 r4429989407 / unit: C sends empty catalog invalidations to B's
  // already-accepted background link, without sessions/control subscriptions.
  it.each(['maker:provider:changed', 'maker:agents:changed'])('notifies background catalog readers of %s without controlling C', async channel => {
    const client = mkClient();
    __testing.setActiveClient(client as never);
    __testing.handleLinkOpen(client as never, 'host-b', 'open-b', backgroundOpen);
    __testing.handleLinkOpen(client as never, 'host-d', 'open-d', backgroundOpen);
    expect(__testing.getActiveControllers()).toEqual([]);
    expect(subscriptions.getControllersForTopic('sessions')).toEqual([]);
    tapWindowBroadcast(channel, { privateSourceDetails: 'must not leave C' });
    expect(client.sendPush.mock.calls).toEqual([
      ['host-b', channel, {}], ['host-d', channel, {}],
    ]);
    client.sendPush.mockClear();
    deviceLinkSettings.value.revokedControllers = ['host-b'];
    tapWindowBroadcast(channel, {});
    expect(client.sendPush.mock.calls).toEqual([['host-d', channel, {}]]);
    client.sendPush.mockClear();
    handleControllerOffline('host-d');
    tapWindowBroadcast(channel, {});
    expect(client.sendPush).not.toHaveBeenCalled();
  });

  it('forwards C invalidation through B once, without source payloads or a C control subscription', () => {
    const client = mkClient();
    __testing.setActiveClient(client as never);
    __testing.handleLinkOpen(client as never, 'controller-a', 'open-a', undefined);
    __testing.handleLinkOpen(client as never, 'source-c', 'open-c', backgroundOpen);
    client.sendPush.mockClear();
    tapRemoteModelCatalogChange('source-c', 'maker:provider:changed', false);
    expect(client.sendPush.mock.calls).toEqual([['controller-a', 'maker:model-catalog:changed', {}]]);
    expect(__testing.getActiveControllers().map(controller => controller.deviceId)).toEqual(['controller-a']);
    client.sendPush.mockClear();
    tapRemoteModelCatalogChange('source-c', 'maker:model-catalog:changed', false);
    tapRemoteModelCatalogChange('source-c', 'maker:agents:changed', true);
    tapRemoteModelCatalogChange(sharedTaskGuestPeer('task', 'guest', 'pc'), 'maker:agents:changed', false);
    expect(client.sendPush).not.toHaveBeenCalled();
    // PR #8814 review: once the minute-by-minute received poll stopped re-announcing
    // catalogs, a same-region share host's real catalog change must reach controllers
    // that read it through B; an inactive or unknown share still does not.
    const shareHost = providerShareHostPeer('share-1', 'owner-pc');
    tapRemoteModelCatalogChange(shareHost, 'maker:provider:changed', false);
    expect(client.sendPush).not.toHaveBeenCalled();
    tapRemoteModelCatalogChange(shareHost, 'maker:provider:changed', false, true);
    expect(client.sendPush.mock.calls).toEqual([['controller-a', 'maker:model-catalog:changed', {}]]);
  });

  it('notifies only the successfully accepted ordinary peer after a failed inbound open', () => {
    const accepted = vi.fn();
    setOrdinaryPeerLinkAcceptedListener(accepted);
    const sendLinkAccept = vi.fn().mockImplementationOnce(() => { throw backpressure(); });
    const client = mkClient({ sendLinkAccept });
    __testing.setActiveClient(client as never);
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-a', undefined);
    expect(accepted).not.toHaveBeenCalled();
    __testing.handleLinkOpen(client as never, 'ctrl-b', 'open-b', undefined);
    expect(accepted.mock.calls).toEqual([['ctrl-b']]);
    accepted.mockClear();
    vi.advanceTimersByTime(500);
    expect(accepted.mock.calls).toEqual([['ctrl-a']]);
    expect(__testing.getActiveControllers().map(c => c.deviceId).sort()).toEqual(['ctrl-a', 'ctrl-b']);
  });

  it('refreshes first-join authority and ignores an older failed open after a newer success', async () => {
    const accepted = vi.fn();
    setOrdinaryPeerLinkAcceptedListener(accepted);
    const client = mkClient();
    __testing.setActiveClient(client as never);
    const peer = sharedTaskGuestPeer('m', 'g', 'd');
    const payload = { controllerName: 'Guest', protocolVersion: PROTOCOL_VERSION, appVersion: '0.0.0-test', capabilities: [SHARED_TASK_CAPABILITY] };
    let rejectOld!: (error: Error) => void;
    sharedTask.capture.mockReturnValue({ author: { displayName: 'Guest' } });
    sharedTask.refresh.mockImplementationOnce(() => new Promise<void>((_resolve, reject) => { rejectOld = reject; })).mockResolvedValue(undefined);
    __testing.handleLinkOpen(client as never, peer, 'old', payload);
    expect(client.sendLinkAccept).not.toHaveBeenCalled();
    __testing.handleLinkOpen(client as never, peer, 'new', payload);
    await Promise.resolve();
    expect(client.sendLinkAccept).toHaveBeenCalledWith(peer, 'new', expect.anything());
    rejectOld(new Error('old network failure'));
    await Promise.resolve(); await Promise.resolve();
    expect(client.closeLink).not.toHaveBeenCalled();
    expect(client.sendLinkAccept).toHaveBeenCalledTimes(1);
    expect(accepted).not.toHaveBeenCalled();
  });
  it('declares history projection support in the host accept, including for legacy controllers', () => {
    const client = mkClient();
    __testing.setActiveClient(client as never);
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-1', undefined);
    expect(client.sendLinkAccept).toHaveBeenCalledWith('ctrl-a', 'open-1', expect.objectContaining({
      capabilities: expect.arrayContaining([DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1]),
    }));
  });

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
  // Unit: a group executor must return completed RPC results over the retained
  // authenticated path; the relay-only case below must still avoid blind sends.
  it('flushes the retained group path while another offline controller stays queued', () => {
    const sendInvokeResult = vi.fn().mockImplementation(() => { throw notConnected(); });
    const client = mkClient({ getStatus: vi.fn(() => 'connecting'), sendInvokeResult,
      hasOfflineDirectPath: vi.fn((id: string) => id === 'group-owner') });
    __testing.setActiveClient(client as never);
    for (const src of ['group-owner', 'offline-controller']) {
      __testing.sendInvokeResultSafe(client as never, src, 'req-' + src,
        { ok: true, result: 'group result' }, 'maker:remote-agent:v1');
    }
    sendInvokeResult.mockImplementation(() => {});
    sendInvokeResult.mockClear();
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult.mock.calls.map(call => call[0])).toEqual(['group-owner']);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);
  });

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
        { ok: true, result: 'PRIVATE_RESPONSE_BODY' },
        'local-db:sessions:list',
      ),
    ).toBe(true);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);
    expect(sendInvokeResult).toHaveBeenCalledTimes(1);
    expect(hasRemoteInvokeWorkForPeer('ctrl-a')).toBe(true);
    expect(hasRemoteInvokeWorkForPeer('ctrl-other')).toBe(false);

    // 离线期间多轮慢扫描:不再尝试发送(无 NOT_CONNECTED 自旋)
    vi.advanceTimersByTime(20_000);
    expect(sendInvokeResult).toHaveBeenCalledTimes(1);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1);

    // 上线事件:立即投递成功
    status = 'online';
    flushRemoteInvokeResultOutboxOnReconnect();
    expect(sendInvokeResult).toHaveBeenCalledTimes(2);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0);
    expect(diagnosticLog.warn).toHaveBeenCalledWith(expect.stringContaining('request=req-1 queueMessages=1'));
    expect(hasRemoteInvokeWorkForPeer('ctrl-a')).toBe(false);
    expect(diagnosticLog.info).toHaveBeenCalledWith(expect.stringContaining('request=req-1 queuedMs=20000'));
    expect(JSON.stringify(diagnosticLog.warn.mock.calls)).not.toContain('PRIVATE_RESPONSE_BODY');
    expect(JSON.stringify(diagnosticLog.info.mock.calls)).not.toContain('PRIVATE_RESPONSE_BODY');
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
  it('锁「预算 ×2」联动:表内 channel 跟随共享表,缺省 30s→60s', () => {
    // 联动语义从共享表推导,不再硬编码结果值——此断言曾在 #1418/#1477 并行开发
    // 时写死 60s(当时表里还没有 listing 条目),两 PR 各自 CI 都绿、先后合入后
    // main 变红。表值本身(12s/300s)在下面单独锁定:它们是产品决策,变更时红在
    // 这里提醒显式确认;而「×2」的联动对表变更免疫。worktree:create 2026-11-16 起
    // 为 300s(Multibox 同步克隆整个工作区),×2 后仍低于全局上限。
    const listingBudget = INVOKE_TIMEOUT_OVERRIDES_MS['local-db:sessions:list'];
    const worktreeBudget = INVOKE_TIMEOUT_OVERRIDES_MS['worktree:create'];
    expect(listingBudget).toBe(12_000);
    expect(worktreeBudget).toBe(300_000);
    expect(__testing.outboxEntryMaxAgeMs('local-db:sessions:list')).toBe(
      Math.min(listingBudget * 2, 120_000),
    );
    expect(__testing.outboxEntryMaxAgeMs(undefined)).toBe(60_000);
    expect(__testing.outboxEntryMaxAgeMs('worktree:create')).toBe(worktreeBudget * 2);
  });

  it('离线慢扫描按逐条 TTL 出清:listing(24s 档)先被丢,长任务 channel 保留到自己的 TTL', () => {
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

    const worktreeTtl = __testing.outboxEntryMaxAgeMs('worktree:create');
    vi.advanceTimersByTime(worktreeTtl - 61_000 - 1_000);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(1); // TTL 前一刻仍保留
    vi.advanceTimersByTime(11_000); // 越过 TTL 且至少经过一次完整的 5s 离线扫描
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(0); // worktree 也到期
  });
});

describe('[5] orphan 截止时间按 channel 收窄', () => {
  // Unit, PR #9153: the orphan result can finish while the actual handler is
  // still running. Existing deadline tests only checked budgets, not diagnostics.
  it('records execution completion only when the handler settles after the orphan deadline', async () => {
    const client = mkClient();
    const busy = vi.fn();
    setRemoteInvokeBusyChangedListener(busy);
    let finish!: (value: unknown) => void;
    const handler = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    invokeRegistry.register('maker:compact-session', handler);
    const requestId = 'abcdef12-0000-0000-0000-000000000000';
    const handling = __testing.handleInvoke(client as never, 'ctrl-a', requestId,
      { channel: 'maker:compact-session', args: ['s1'] });
    const executionLogs = () => diagnosticLog.info.mock.calls
      .filter(([message]) => typeof message === 'string' && message.startsWith('device-link diagnostic '))
      .map(([message]) => JSON.parse(message.slice('device-link diagnostic '.length)))
      .filter(record => record.stage === 'execution' && record.request === 'abcdef12');
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(handler).toHaveBeenCalledOnce();
      expect(busy).toHaveBeenLastCalledWith(true);
      const deadline = __testing.remoteInvokeOrphanTimeoutForChannelMs('maker:compact-session');
      await vi.advanceTimersByTimeAsync(deadline);
      await handling;
      expect(client.sendInvokeResult).toHaveBeenCalledOnce();
      expect(client.sendInvokeResult.mock.calls[0][2]).toMatchObject({ ok: false,
        error: { code: 'IPC_ERROR', message: expect.stringContaining('[TIMEOUT]') } });
      expect(busy).toHaveBeenLastCalledWith(false);
      expect(executionLogs()).toContainEqual(expect.objectContaining({ outcome: 'waiting', activeStage: 'handler' }));
      expect(executionLogs().some(record => record.outcome === 'settled')).toBe(false);

      await vi.advanceTimersByTimeAsync(1_000);
      finish({});
      await vi.advanceTimersByTimeAsync(0);
      expect(executionLogs()).toContainEqual(expect.objectContaining({ outcome: 'settled',
        executionMs: deadline + 1_000, activeStage: null,
        stagesMs: expect.objectContaining({ handler: deadline + 1_000 }) }));
      expect(client.sendInvokeResult).toHaveBeenCalledOnce();
      expect(busy.mock.calls).toEqual([[true], [false]]);
    } finally {
      finish?.({});
      await vi.advanceTimersByTimeAsync(0);
      setRemoteInvokeBusyChangedListener(null);
    }
  });

  it('默认 invoke 保持 60s，只有 compact 使用 22min 长预算', () => {
    const compactBudget = INVOKE_TIMEOUT_OVERRIDES_MS['maker:compact-session'];
    expect(compactBudget).toBe(11 * 60_000);
    expect(__testing.remoteInvokeOrphanTimeoutForChannelMs(undefined)).toBe(60_000);
    expect(__testing.remoteInvokeOrphanTimeoutForChannelMs('maker:list-active')).toBe(60_000);
    expect(__testing.remoteInvokeOrphanTimeoutForChannelMs('maker:compact-session')).toBe(
      compactBudget * 2,
    );
  });

  it('按与控制端相同的动作级预算给任务复制统计留足时间', () => {
    const orphan = (action: string) =>
      __testing.remoteInvokeOrphanTimeoutForChannelMs(TASK_MIGRATION_CHANNEL, [
        { action, sessionId: 's' },
      ]);
    expect(orphan('estimate')).toBe(TASK_MIGRATION_ESTIMATE_TIMEOUT_MS * 2);
    expect(orphan('status')).toBe(60_000);
    // A reply that could not be sent is kept for the same action-specific window.
    const outbox = (action: string) =>
      __testing.outboxEntryMaxAgeMs(TASK_MIGRATION_CHANNEL, [{ action, sessionId: 's' }]);
    expect(outbox('estimate')).toBe(TASK_MIGRATION_ESTIMATE_TIMEOUT_MS * 2);
    expect(outbox('status')).toBe(60_000);
  });

  it('被控端从不早于控制端放弃：orphan 与 outbox 覆盖每个通道与动作的等待预算', () => {
    const calls: Array<[string | undefined, unknown[] | undefined]> = [
      [undefined, undefined],
      ...Object.keys(INVOKE_TIMEOUT_OVERRIDES_MS).map(
        (channel) => [channel, undefined] as [string, undefined],
      ),
      ...['estimate', 'receive', 'status', 'start', 'caps'].map(
        (action) => [TASK_MIGRATION_CHANNEL, [{ action, sessionId: 's' }]] as [string, unknown[]],
      ),
    ];
    for (const [channel, args] of calls) {
      const budget =
        (channel && resolveRemoteInvokeTimeoutMs(channel, args, 'desktop')) || 30_000;
      expect(__testing.remoteInvokeOrphanTimeoutForChannelMs(channel, args)).toBeGreaterThanOrEqual(budget);
      expect(__testing.outboxEntryMaxAgeMs(channel, args)).toBeGreaterThanOrEqual(budget);
    }
  });
});

describe('[6] active controller 生命周期与故障半径', () => {
  // Unit, #8408 idle-retirement contract: transport ACKs do not cover the lifetime
  // of fire-and-forget host execution. Previous RTC tests returned handler promises
  // to transport, hiding this gap. One >5-minute compact, one idle neighbor and one
  // waiter must retire only the idle neighbor; the active result stays on direct.
  it('protects a long-running inbound dispatch while reclaiming an idle neighbor for a waiter', async () => {
    const pairs = new Map<string, Array<{ events: DirectRuntimeEvents; closed: boolean }>>();
    const runtime = (maxPeers = 16): DirectRuntime => {
      const bridge = createDirectRuntimeBridge({ maxPeers });
      const native: DirectRuntime = { create(id, events) {
        const row = { events, closed: false }, pair = pairs.get(id) ?? [];
        pairs.set(id, pair); pair.push(row);
        return { offer: async () => id, accept: async () => id,
          answer: async () => { queueMicrotask(() => pair.forEach(p => { if (!p.closed) p.events.open(); })); },
          send: text => { queueMicrotask(() => { const other = pair.find(p => p !== row && !p.closed); other?.events.message(text); }); },
          bufferedAmount: 0,
          close: () => pair.forEach(p => { if (!p.closed) { p.closed = true; p.events.closed(); } }),
        };
      } };
      const host = createDirectRuntimeHost(native, event => bridge.receive(event));
      const detach = bridge.attach(command => { void host.command(command); });
      return { ...bridge.runtime, suspend() { detach(); host.dispose(); } };
    };
    const relay = new DispatchTestRelay(true), routed = vi.spyOn(relay, 'route');
    const target = makeDispatchTestClient(relay, 'a-target', { directRuntime: runtime(2), isPeerBusy: hasRemoteInvokeWorkForPeer });
    const busy = makeDispatchTestClient(relay, 'b-busy', { directRuntime: runtime() });
    const idle = makeDispatchTestClient(relay, 'c-idle', { directRuntime: runtime() });
    const waiting = makeDispatchTestClient(relay, 'd-waiting', { directRuntime: runtime() });
    const clients = [target, busy, idle, waiting];
    let finish!: (value: unknown) => void;
    const compact = vi.fn(() => new Promise(resolve => { finish = resolve; }));
    invokeRegistry.register('maker:compact-session', compact);
    const unbind = wireInboundDispatch(target);
    const pump = () => vi.advanceTimersByTimeAsync(1);
    const open = async (client: DeviceLinkClient) => {
      const opening = client.openLink('a-target', { controllerName: 'fixture', protocolVersion: 1, appVersion: '1' });
      void opening.catch(() => {});
      await vi.waitFor(() => expect(client.isLinkReady('a-target')).toBe(true));
      await opening; await pump();
    };
    try {
      clients.forEach(client => client.start()); await pump();
      for (const client of [busy, idle]) {
        await open(client);
        await vi.waitFor(() => expect(target.getPeerPath(client.getSelfDeviceId()!)).toBe('direct'));
      }
      expect(target.getPeerPath('b-busy')).toBe('direct');
      expect(target.getPeerPath('c-idle')).toBe('direct');
      const originalBusySessions = [...pairs.values()][0];
      const result = busy.invoke('a-target', { channel: 'maker:compact-session', args: ['fixture-session'] },
        INVOKE_TIMEOUT_OVERRIDES_MS['maker:compact-session']);
      void result.catch(() => {});
      await pump(); expect(compact).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      await open(waiting);
      expect(target.getPeerPath('d-waiting')).toBe('relay');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(originalBusySessions.every(session => !session.closed)).toBe(true);
      expect(target.getPeerPath('b-busy')).toBe('direct');
      expect(target.getPeerPath('c-idle')).toBe('relay');
      expect(target.getPeerPath('d-waiting')).toBe('direct');
      const before = routed.mock.calls.length;
      finish({ compacted: true }); await pump();
      await expect(result).resolves.toMatchObject({ ok: true, result: { compacted: true } });
      expect(routed.mock.calls.slice(before).filter(([src, , env]) => src === 'a-target' && env.dst === 'b-busy' && env.kind === 'invoke-result')).toEqual([]);
      expect(compact).toHaveBeenCalledOnce();
      expect(target.getPeerPath('d-waiting')).toBe('direct');
    } finally { finish?.({ compacted: true }); await pump(); clients.forEach(client => client.stop()); unbind(); invokeRegistry.reset(); }
  });
  // #8480 P1: the old mock omitted canSendPush and hid its relay-online gate.
  // Unit: authenticated real clients + production dispatch must deliver activity,
  // metadata, text batches and congestion-repair snapshots over the retained path.
  it.each(['activity', 'patch', 'text', 'snapshot'] as const)(
    'delivers retained group %s through real push admission while relay is offline', async (kind) => {
      const relay = new DispatchTestRelay(true);
      const target = makeDispatchTestClient(relay, 'executor', { retainDirectPathsOnRelayLoss: true });
      const controller = makeDispatchTestClient(relay, 'group-owner', { retainDirectPathsOnRelayLoss: true });
      const other = makeDispatchTestClient(relay, 'other-owner', { retainDirectPathsOnRelayLoss: true });
      const delivered: Array<{ channel: string; payload: unknown }> = [];
      controller.onFrame(env => {
        if (env.kind === 'push') delivered.push(env.payload as { channel: string; payload: unknown });
      });
      const unwire = wireInboundDispatch(target);
      __testing.setActiveClient(target);
      const offStatus = target.onStatusChange(status => {
        if (status !== 'online') deactivateAllControllers('relay-disconnected', 'same-account',
          id => target.hasOfflineDirectPath(id));
      });
      const pump = () => vi.advanceTimersByTimeAsync(1);
      const handles: Array<ReturnType<DeviceLinkClient['attachDirectPath']>> = [];
      let hold = false;
      const held: string[] = [];
      const capabilities = [CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1, CONTROLLER_CAPABILITY_SESSION_TEXT_SNAPSHOT_V1];
      try {
        target.start(); controller.start(); other.start(); await pump();
        const openings = Promise.all([controller, other].map(c => c.openLink('executor', {
          controllerName: 'Group', protocolVersion: 1, appVersion: '1',
        })));
        await pump(); await openings;
        const subscribing = Promise.all([controller, other].map(c => c.invoke('executor', {
          channel: DL_SUBSCRIBE_CHANNEL,
          args: [{ topics: ['sessions', 'session:s1'], controllerName: 'Group', capabilities }],
        })));
        await pump(); await subscribing;
        handles[0] = target.attachDirectPath('group-owner', {
          send: text => { if (hold) held.push(text); else queueMicrotask(() => handles[1].receive(text)); },
          close: () => { handles[0]?.closed(); handles[1]?.closed(); },
        });
        handles[1] = controller.attachDirectPath('executor', {
          send: text => queueMicrotask(() => handles[0].receive(text)),
          close: () => { handles[0]?.closed(); handles[1]?.closed(); },
        });
        pushSessionActivityToController('group-owner', { sessionId: 's1', isTurnRunning: true });
        await pump();
        expect(delivered).toContainEqual({ channel: 'local-db:sessions:activity', payload: { sessionId: 's1', isTurnRunning: true } });
        delivered.length = 0;
        relay.disconnect('executor');
        expect(target.hasOfflineDirectPath('group-owner')).toBe(true);
        expect(subscriptions.getControllersForTopic('sessions')).toEqual(['group-owner']);
        const delta = { sessionId: 's1', persistId: 'p1', event: {
          type: 'text', source: 'codex', data: { text: 'retained suffix', isFinal: false },
        } };
        const snapshot = { ...delta, event: { ...delta.event, data: {
          text: 'whole retained prefix', isFinal: false, isFullText: true,
        } } };
        setSessionTextSnapshotReader(() => snapshot);
        if (kind === 'activity') pushSessionActivityToController('group-owner', { sessionId: 's1', isTurnRunning: false });
        else if (kind === 'patch') tapWindowBroadcast('local-db:sessions:patched', { sessionId: 's1', patch: { title: 'Retained task' } });
        else {
          if (kind === 'snapshot') {
            // Fill the real reliable window; the skipped suffix must be repaired
            // by a snapshot once ACKs drain it, even without relay recovery.
            hold = true;
            for (let i = 0; i < 2 * __testing.sessionActivityWindowSoftCap; i++) target.sendPush('group-owner', 'test:occupy', { i });
          }
          tapWindowBroadcast('maker:event', delta);
          await vi.advanceTimersByTimeAsync(120); // Existing production text-batch window.
          if (kind === 'snapshot') expect(delivered.some(p => p.channel === MAKER_EVENT_BATCH_CHANNEL)).toBe(false);
          hold = false;
          for (const text of held.splice(0)) handles[1].receive(text);
        }
        await vi.advanceTimersByTimeAsync(500);
        const expected = kind === 'activity'
          ? { channel: 'local-db:sessions:activity', payload: { sessionId: 's1', isTurnRunning: false } }
          : kind === 'patch' ? { channel: 'local-db:sessions:patched', payload: { sessionId: 's1', patch: { title: 'Retained task' } } }
            : kind === 'text' ? { channel: MAKER_EVENT_BATCH_CHANNEL, payload: { sessionId: 's1', events: [delta] } }
              : { channel: SESSION_SYNC_CHANNEL, payload: { ...snapshot, resyncRequired: false } };
        expect(delivered.filter(p => p.channel === expected.channel)).toEqual([expected]);
        expect(__testing.sessionActivityStageSize('group-owner')).toBe(0);
        expect(target.getStatus()).not.toBe('online');
        expect(target.getReliableSendQueueDepth('group-owner')).toBe(0);
      } finally {
        offStatus(); unwire(); target.stop(); controller.stop(); other.stop();
      }
    },
  );

  it('真实双 peer 链路中 A 的 DEVICE_OFFLINE 不清 B，B 的在途请求仍能完成', async () => {
    const lost = vi.spyOn(remoteDesktop, 'signalingLost');
    const stop = vi.spyOn(remoteDesktop, 'stop');
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
    lost.mockClear();
    stop.mockClear();
    target.sendInvokeResult('ctrl-a', 'offline-probe', { ok: true, result: null });

    expect(routeChanges).toContain('ctrl-a:offline');
    expect(lost).toHaveBeenCalledWith('ctrl-a');
    expect(lost).not.toHaveBeenCalledWith('ctrl-b');
    expect(stop).not.toHaveBeenCalledWith('ctrl-b');
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

  // Unit: only already-authenticated direct peers survive the host relay loss.
  // Their catalog invalidations continue; no offline link-open is admitted.
  it('retains the group subscription and background catalog pushes without retaining unrelated controllers', () => {
    let status = 'online';
    const keep = (id: string) => id === 'group-owner';
    const client = mkClient({ getStatus: vi.fn(() => status), hasOfflineDirectPath: vi.fn(keep) });
    __testing.setActiveClient(client as never);
    const payload = { controllerName: 'group', protocolVersion: PROTOCOL_VERSION, appVersion: '1',
      capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1] };
    __testing.handleLinkOpen(client as never, 'group-owner', 'group-open', payload);
    __testing.handleLinkOpen(client as never, 'other', 'other-open', payload);
    subscriptions.subscribe('group-owner', ['session:a'], 'Group', ['cap-a', DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1]);
    subscriptions.subscribe('other', ['session:b'], 'Other', ['cap-b', DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1]);
    status = 'connecting';
    deactivateAllControllers('relay-disconnected', 'same-account', keep);
    expect(__testing.getActiveControllers().map(c => c.deviceId)).toEqual(['group-owner']);
    expect(subscriptions.getControllersForTopic('session:a')).toEqual(['group-owner']);
    expect(subscriptions.getControllersForTopic('session:b')).toEqual([]);
    tapWindowBroadcast('maker:provider:changed', {});
    expect(client.sendPush).toHaveBeenCalledWith('group-owner', 'maker:provider:changed', {});
    expect(client.sendPush.mock.calls.some(call => call[0] === 'other')).toBe(false);
    handleControllerOffline('group-owner');
    expect(__testing.getActiveControllers()).toEqual([]);
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

  // 故障半径:走自建中转时访客在官方连接上,自建中转断开不能让访客静默收不到推送(反之亦然)。
  it('跨账号控制端在独立连接上时,一条连接断开只清这条连接上的控制端', () => {
    const guest = sharedTaskGuestPeer('task-a', 'member-a', 'guest-device');
    const activeIds = () => __testing.getActiveControllers().map((controller) => controller.deviceId);
    subscriptions.subscribe('ctrl-a', ['session:a'], 'A', []);
    subscriptions.subscribe(guest, ['session:b'], 'Guest', []);

    deactivateAllControllers('relay-disconnected', 'same-account');
    expect(activeIds()).toEqual([guest]);

    subscriptions.subscribe('ctrl-a', ['session:a'], 'A', []);
    deactivateAllControllers('cross-account-relay-disconnected', 'cross-account');
    expect(activeIds()).toEqual(['ctrl-a']);
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
      linkGeneration: 1,
    });
    expect(__testing.getActiveControllers().map((controller) => controller.deviceId)).toEqual([
      'ctrl-a',
    ]);

    handleControllerOffline('ctrl-a', {
      deviceId: 'ctrl-a',
      state: 'offline',
      connectionEpoch: 2,
      linkGeneration: 1,
    });
    expect(__testing.getActiveControllers()).toEqual([]);
  });

  it('同一 connection 内旧 link 的 offline 事件不能清掉重新打开后的 controller', () => {
    let linkGeneration = 1;
    const client = mkClient({
      getConnectionEpoch: vi.fn(() => 1),
      getPeerLinkGeneration: vi.fn(() => linkGeneration),
    });
    __testing.setActiveClient(client as never);

    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-old', undefined);
    linkGeneration = 2;
    __testing.handleLinkOpen(client as never, 'ctrl-a', 'open-new', undefined);

    handleControllerOffline('ctrl-a', {
      deviceId: 'ctrl-a',
      state: 'offline',
      connectionEpoch: 1,
      linkGeneration: 1,
    });
    expect(__testing.getActiveControllers().map((controller) => controller.deviceId)).toEqual([
      'ctrl-a',
    ]);

    handleControllerOffline('ctrl-a', {
      deviceId: 'ctrl-a',
      state: 'offline',
      connectionEpoch: 1,
      linkGeneration: 2,
    });
    expect(__testing.getActiveControllers()).toEqual([]);
  });
});

describe('被控浮窗读取控制端展示名', () => {
  afterEach(() => clearControllerDisplayNames());

  it('旧 presence 主机名作为最后一级回退，权威展示名优先', () => {
    setControllerFallbackDisplayName('ctrl-legacy', 'Legacy Mac');
    expect(getControllerDisplayName('ctrl-legacy')).toBe('Legacy Mac');
    setControllerDisplayName('ctrl-legacy', 'Dash 的 MacBook');
    expect(getControllerDisplayName('ctrl-legacy')).toBe('Dash 的 MacBook');
    clearControllerDisplayNames();
    expect(getControllerDisplayName('ctrl-legacy')).toBeUndefined();
  });

  it('权威名被显式清空时同时清掉旧 presence 主机名', () => {
    setControllerFallbackDisplayName('ctrl-legacy', 'Legacy Mac');
    setControllerDisplayName('ctrl-legacy', '');
    expect(getControllerDisplayName('ctrl-legacy')).toBeUndefined();
  });
});

describe('[7] 账号级状态快照不占满卡住对端的可靠窗口', () => {
  // Bug(2026-11-10~14 Mac Studio 日志):手机网络一卡,每帧 ~1 KB 的调度运行诊断与
  // 同账号用量快照逐帧灌进 64 帧可靠窗口,控制端在等的 invoke-result 被拒为
  // `reliable transport buffer is full`(iPhone 345 次)。状态快照只需最新值:卡住时
  // 不再入窗,恢复后每个键只发最新一帧;驱动刷新的调度事件仍逐帧即时转发。
  it('stages runtime-state and usage snapshots latest-wins for the busy peer only', async () => {
    let phoneDepth = 40;
    const sent: Array<{ dst: string; channel: string; payload: unknown }> = [];
    const client = {
      ...mkClient(),
      getReliableSendQueueDepth: vi.fn((dst: string) => (dst === 'phone' ? phoneDepth : 0)),
      sendPush: vi.fn((dst: string, channel: string, payload: unknown) => { sent.push({ dst, channel, payload }); }),
    };
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('phone', ['sessions'], 'phone');
    subscriptions.subscribe('desk', ['sessions'], 'desk');
    const to = (dst: string) => sent.filter((push) => push.dst === dst).map(({ channel, payload }) => ({ channel, payload }));

    for (let i = 0; i < 40; i++) {
      __testing.forwardPush('maker:schedule:event', { type: 'runtime-state', snapshot: { slotsInUse: i } });
    }
    for (let i = 0; i < 13; i++) {
      __testing.forwardPush('usage:codex-provider-account-changed', { providerId: 'p1', snapshot: { used: i } });
    }
    __testing.forwardPush('usage:codex-provider-account-changed', { providerId: 'p2', snapshot: null });
    __testing.forwardPush('maker:schedule:event', { type: 'fired', scheduleId: 's1', runId: 'r1' });

    const fired = { channel: 'maker:schedule:event', payload: { type: 'fired', scheduleId: 's1', runId: 'r1' } };
    const latest = [
      { channel: 'maker:schedule:event', payload: { type: 'runtime-state', snapshot: { slotsInUse: 39 } } },
      { channel: 'usage:codex-provider-account-changed', payload: { providerId: 'p1', snapshot: { used: 12 } } },
      { channel: 'usage:codex-provider-account-changed', payload: { providerId: 'p2', snapshot: null } },
    ];
    // Healthy peers still receive refresh-driving schedule events immediately; congested peers stage them out of the 64-frame window.
    expect(to('desk')).toEqual([fired]);
    expect(to('phone')).toEqual([]);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    // The healthy peer receives one latest frame per key; the busy peer admits none until its send window drains.
    expect(to('desk')).toEqual([fired, ...latest]);
    expect(to('phone')).toEqual([]);
    expect(__testing.latestStatePushStageSize('phone')).toBe(3);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(1);

    phoneDepth = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(to('phone')).toEqual([fired, ...latest]);
    expect(__testing.latestStatePushStageSize('phone')).toBe(0);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(0);
  });

  // 测试价值
  // - 生产入口与可观察结果：forwardPush('maker:schedule:event') + handleInvoke(transfer.retired)。
  //   1) 对端可靠窗口超过软上限时，38 轮心跳（fired + session-bound + silenced + completed + 下一轮 fired）不灌入 64 帧窗口，
  //      silenced 进入 latest-state 覆盖，运行事件按 scheduleId 因果折叠并保留未读终态（completed）与最新运行状态（fired）；
  //   2) 控制端重试捎带 transfer.retired 时立即清理同对端 outbox 中的只读旧回包，保留写操作与其它控制端回包。
  // - Bug／规则依据：64 帧可靠窗口积压事故（pending=64 中 38 帧 maker:schedule:event、6 帧 sessions:list）；remote-and-mobile-adaptation.md。
  // - 现有覆盖缺口：旧测试未覆盖 silenced/notified 整流、拥塞期多轮调度生命周期折叠与 outbox 按 retired 退役。
  // - 最小失败输入：phoneDepth=12 下同一 schedule 连续 38 轮生命周期事件 + 两条排入 outbox 的只读/写结果。
  // - tier：unit（fake timers，<20ms）。
  it('causally folds 38 congested schedule cycles without losing unread completion and retires only own read outbox entries', async () => {
    let phoneDepth = 12;
    const sent: Array<{ dst: string; channel: string; payload: unknown }> = [];
    const failBackpressure = (): void => {
      throw new DeviceLinkError('BACKPRESSURE', 'reliable transport buffer is full');
    };
    const client = {
      ...mkClient(),
      getReliableSendQueueDepth: vi.fn((dst: string) => (dst === 'phone' ? phoneDepth : 0)),
      sendPush: vi.fn((dst: string, channel: string, payload: unknown) => {
        sent.push({ dst, channel, payload });
      }),
      sendInvokeResult: vi.fn(failBackpressure),
    };
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('phone', ['sessions'], 'phone');

    for (let round = 1; round <= 38; round++) {
      __testing.forwardPush('maker:schedule:event', { type: 'fired', scheduleId: 'hb-1', runId: `r-${round}` });
      __testing.forwardPush('maker:schedule:event', { type: 'session-bound', scheduleId: 'hb-1', runId: `r-${round}`, sessionId: 's-hb' });
      __testing.forwardPush('maker:schedule:event', { type: 'silenced', scheduleId: 'hb-1', runId: `r-${round}` });
      if (round < 38) {
        __testing.forwardPush('maker:schedule:event', {
          type: 'completed',
          scheduleId: 'hb-1',
          runId: `r-${round}`,
          sessionId: 's-hb',
        });
      }
    }

    await vi.advanceTimersByTimeAsync(1_000);
    expect(sent).toEqual([]);
    // Only 1 notice key in latestStatePushStage + 2 causal keys (unread completed + latest session-bound) in scheduleEventPushStage!
    expect(__testing.latestStatePushStageSize('phone')).toBe(1);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(2);

    phoneDepth = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(sent.map((item) => item.payload)).toEqual([
      { type: 'completed', scheduleId: 'hb-1', runId: 'r-37', sessionId: 's-hb' },
      { type: 'session-bound', scheduleId: 'hb-1', runId: 'r-38', sessionId: 's-hb' },
      { type: 'silenced', scheduleId: 'hb-1', runId: 'r-38' },
    ]);

    // Queue one read result, one write result for 'phone', and one read result for 'other' into outbox via BACKPRESSURE.
    expect(__testing.sendInvokeResultSafe(client as never, 'phone', 'stale-read', { ok: true, result: ['big'] }, 'local-db:sessions:list', [], 'fp-1')).toBe(true);
    expect(__testing.sendInvokeResultSafe(client as never, 'phone', 'keep-write', { ok: true, result: { ok: 1 } }, 'maker:send', ['s1', 'hi'], 'fp-2')).toBe(true);
    expect(__testing.sendInvokeResultSafe(client as never, 'other', 'other-read', { ok: true, result: ['other'] }, 'local-db:sessions:list', [], 'fp-3')).toBe(true);
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(3);

    client.sendInvokeResult.mockImplementation(() => undefined);
    await __testing.handleInvoke(client as never, 'phone', 'fresh-read', {
      channel: 'device-link:unsubscribe',
      args: [{ topics: ['sessions'] }],
      transfer: { retired: ['stale-read', 'keep-write', 'other-read'] },
    } as never);
    // Only 'phone's own retryable read ('stale-read') was retired; 'keep-write' and 'other-read' stay protected!
    expect(__testing.remoteInvokeResultOutboxSize()).toBe(2);
  });

  it('drops staged snapshots once the controller unsubscribes from sessions', async () => {
    const client = { ...mkClient(), getReliableSendQueueDepth: vi.fn(() => 0) };
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('phone', ['sessions'], 'phone');
    __testing.forwardPush('usage:claude-account-changed', { daily: 1 });
    expect(__testing.latestStatePushStageSize('phone')).toBe(1);
    subscriptions.unsubscribe('phone', ['sessions']);
    await vi.advanceTimersByTimeAsync(250);
    expect(client.sendPush).not.toHaveBeenCalled();
    expect(__testing.latestStatePushStageSize('phone')).toBe(0);
  });

  // 测试价值
  // - 生产入口与可观察结果：forwardPush('maker:schedule:event') 经 ScheduleEventPushStage 输出到对端的序列与接收端投影（projectScheduleEvent）。
  //   1) completed(A) -> read(S)/all-read -> fired(B) 严格按因果顺序输出，绝不把旧完成提升到 read/all-read 之后污染未读红点；
  //   2) session-bound 后接无 sessionId 的 failed，或跨轮绑定不同 sessionId 时，完整保留全部绑定 sessionId 与未读终态；
  //   3) 超过 256 个不同 scheduleId（260 个）在拥塞期排队时，第 257+ 个键绝不静默挤掉前序未读终态。
  // - Bug／规则依据：审阅实测回归 ①（completed->read/all-read->fired 乱序、257th key 丢终态、session-bound/failed 跨轮折叠）；remote-and-mobile-adaptation.md。
  // - 现有覆盖缺口：前序测试仅验证单 schedule 同 sessionId 连续轮次，未覆盖已读屏障夹心、无 sessionId 失败跨轮与 >256 不同键容量边界。
  // - 最小失败输入：completed(A)->read->fired(B)、completed(A)->all-read->fired(B)、两轮 session-bound+failed(无 sessionId)、260 个独立 scheduleId 的 completed。
  // - tier：unit（fake timers + 真实接收端投影对拍，<30ms）。
  it('preserves read/all-read causal order, multi-round session-bound/failed bindings, and >256 distinct schedule terminal states', async () => {
    const applyReceiverOracle = (events: readonly unknown[]) => {
      const unreadSchedules = new Set<string>();
      const boundSessionIds = new Set<string>();
      const lastEventBySchedule = new Map<string, NormalizedSchedulerEvent>();
      let sessionIndexRefreshes = 0;
      for (const raw of events) {
        const proj = projectScheduleEvent(raw);
        const ev = proj.event;
        if (ev.type === 'ready') {
          boundSessionIds.clear();
        }
        if (proj.runPatch.sessionId) {
          boundSessionIds.add(proj.runPatch.sessionId);
        }
        if (proj.refresh.sessionIndex) {
          sessionIndexRefreshes += 1;
        }
        if (proj.unreadImpact === 'may-increase' && 'scheduleId' in ev) {
          unreadSchedules.add(ev.scheduleId);
        } else if (ev.type === 'read') {
          unreadSchedules.delete(ev.scheduleId);
        } else if (ev.type === 'all-read') {
          unreadSchedules.clear();
        }
        if ('scheduleId' in ev) {
          lastEventBySchedule.set(ev.scheduleId, ev);
        }
      }
      return {
        unreadSchedules: [...unreadSchedules].sort(),
        boundSessionIds: [...boundSessionIds].sort(),
        lastEventBySchedule,
        hasSessionIndexRefresh: sessionIndexRefreshes > 0,
      };
    };

    let phoneDepth = 12;
    const sent: unknown[] = [];
    const client = {
      ...mkClient(),
      getReliableSendQueueDepth: vi.fn((dst: string) => (dst === 'phone' ? phoneDepth : 0)),
      sendPush: vi.fn((_dst: string, channel: string, payload: unknown) => {
        if (channel === 'maker:schedule:event') sent.push(payload);
      }),
    };
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('phone', ['sessions'], 'phone');

    // Case 1a: completed(A) -> read -> fired(B) must NEVER output read -> completed(A) -> fired(B).
    const seqRead = [
      { type: 'completed', scheduleId: 's-order-1', runId: 'run-A', sessionId: 'sess-order-1' },
      { type: 'read', scheduleId: 's-order-1' },
      { type: 'fired', scheduleId: 's-order-1', runId: 'run-B' },
    ];
    expect(applyReceiverOracle([seqRead[0]!]).unreadSchedules).toEqual(['s-order-1']);
    for (const ev of seqRead) __testing.forwardPush('maker:schedule:event', ev);
    phoneDepth = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toEqual(seqRead);
    expect(applyReceiverOracle(sent)).toEqual(applyReceiverOracle(seqRead));
    expect(applyReceiverOracle(sent).unreadSchedules).toEqual([]);

    // Case 1b: completed(A) -> all-read -> fired(B) must NEVER output all-read -> completed(A) -> fired(B).
    sent.length = 0;
    phoneDepth = 12;
    const seqAllRead = [
      { type: 'completed', scheduleId: 's-order-2', runId: 'run-A', sessionId: 'sess-order-2' },
      { type: 'all-read' },
      { type: 'fired', scheduleId: 's-order-2', runId: 'run-B' },
    ];
    expect(applyReceiverOracle([seqAllRead[0]!]).unreadSchedules).toEqual(['s-order-2']);
    for (const ev of seqAllRead) __testing.forwardPush('maker:schedule:event', ev);
    phoneDepth = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(sent).toEqual(seqAllRead);
    expect(applyReceiverOracle(sent)).toEqual(applyReceiverOracle(seqAllRead));
    expect(applyReceiverOracle(sent).unreadSchedules).toEqual([]);

    // Case 2: session-bound followed by failed (without sessionId) across two rounds with distinct sessions.
    sent.length = 0;
    phoneDepth = 12;
    const seqCrossRound = [
      { type: 'fired', scheduleId: 's-fail', runId: 'r-1' },
      { type: 'session-bound', scheduleId: 's-fail', runId: 'r-1', sessionId: 'sess-A' },
      { type: 'failed', scheduleId: 's-fail', runId: 'r-1', error: 'boom-1' },
      { type: 'fired', scheduleId: 's-fail', runId: 'r-2' },
      { type: 'session-bound', scheduleId: 's-fail', runId: 'r-2', sessionId: 'sess-B' },
      { type: 'failed', scheduleId: 's-fail', runId: 'r-2', error: 'boom-2' },
    ];
    for (const ev of seqCrossRound) __testing.forwardPush('maker:schedule:event', ev);
    phoneDepth = 0;
    await vi.advanceTimersByTimeAsync(250);
    expect(applyReceiverOracle(sent)).toEqual(applyReceiverOracle(seqCrossRound));
    expect(applyReceiverOracle(sent).boundSessionIds).toEqual(['sess-A', 'sess-B']);
    expect(applyReceiverOracle(sent).unreadSchedules).toEqual(['s-fail']);

    // Case 3: 50 distinct scheduleIds (<= 64 cap) retain exact terminal states; >64 distinct scheduleIds (260) and
    // 200/400/600 rounds of (completed(newSessionId) + changed) stay strictly bounded via authoritative { type: 'resync' }
    // without silent terminal loss and without permanent 125ms wakeups!
    sent.length = 0;
    phoneDepth = 12;
    const withinCapTerminals = Array.from({ length: 50 }, (_, idx) => ({
      type: 'completed',
      scheduleId: `sched-${idx + 1}`,
      runId: `run-${idx + 1}`,
      sessionId: `sess-${idx + 1}`,
    }));
    for (const ev of withinCapTerminals) __testing.forwardPush('maker:schedule:event', ev);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(50);
    phoneDepth = 0;
    await vi.advanceTimersByTimeAsync(10 * 125);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(0);
    expect(sent).toEqual(withinCapTerminals);

    // Case 4: Unwritable peer receiving 200 / 400 / 600 rounds of (completed(newSessionId) + changed) + oversized errors:
    // queue size stays bounded at 3 (instead of 201 / 401 / 601), bytes stay <= 16 KiB, and 1h stall parks the timer (0 spin).
    sent.length = 0;
    phoneDepth = 12;
    let writableChecks = 0;
    client.getReliableSendQueueDepth.mockImplementation((dst: string) => {
      if (dst === 'phone') writableChecks += 1;
      return dst === 'phone' ? phoneDepth : 0;
    });
    const countsAt200400600: number[] = [];
    const bytesAt200400600: number[] = [];
    for (let round = 1; round <= 600; round++) {
      __testing.forwardPush('maker:schedule:event', {
        type: 'completed',
        scheduleId: 'sched-loop',
        runId: `r-${round}`,
        sessionId: `sess-loop-${round}`,
      });
      __testing.forwardPush('maker:schedule:event', {
        type: 'changed',
        scheduleId: 'sched-loop',
      });
      if (round === 200 || round === 400 || round === 600) {
        countsAt200400600.push(__testing.scheduleEventPushStageSize('phone'));
        bytesAt200400600.push(__testing.scheduleEventPushStageBytes('phone'));
      }
    }
    expect(countsAt200400600).toEqual([3, 3, 3]);
    expect(Math.max(...bytesAt200400600)).toBeLessThan(1_024);

    // Also push an oversized failed error (12 KiB) while overflowed: bytes remain compacted and <= 16 KiB.
    __testing.forwardPush('maker:schedule:event', {
      type: 'failed',
      scheduleId: 'sched-loop',
      runId: 'r-601',
      error: 'E'.repeat(12_000),
      sessionId: 'sess-loop-601',
    });
    expect(__testing.scheduleEventPushStageSize('phone')).toBeLessThanOrEqual(4);
    expect(__testing.scheduleEventPushStageBytes('phone')).toBeLessThanOrEqual(2_048);

    // Advance 20s to finish bounded stall backoff, then advance 1 full hour (3_600_000ms): zero 125ms permanent wakeups!
    await vi.advanceTimersByTimeAsync(20_000);
    expect(__testing.scheduleEventPushStageHasActiveTimer('phone')).toBe(false);
    const checksBeforeHour = writableChecks;
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(writableChecks).toBe(checksBeforeHour);

    // Even new events arriving while parked & still unwritable must NOT restart a 125ms timer loop!
    __testing.forwardPush('maker:schedule:event', {
      type: 'completed',
      scheduleId: 'sched-loop',
      runId: 'r-602',
      sessionId: 'sess-loop-602',
    });
    __testing.forwardPush('maker:schedule:event', {
      type: 'changed',
      scheduleId: 'sched-loop',
    });
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(3);
    expect(__testing.scheduleEventPushStageHasActiveTimer('phone')).toBe(false);

    // Peer window drains and progress signal fires: stage wakes immediately and emits authoritative { type: 'resync' } + latest session binding + tail!
    phoneDepth = 0;
    __testing.wakePeerPushStages('phone');
    await vi.advanceTimersByTimeAsync(250);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(0);
    expect(sent).toEqual([
      { type: 'resync' },
      { type: 'completed', scheduleId: 'sched-loop', runId: 'r-602', sessionId: 'sess-loop-602' },
      { type: 'changed', scheduleId: 'sched-loop' },
    ]);
    // Verify receiver projection on { type: 'resync' }: forces authoritative full refresh of runs, scheduleList, sessionIndex & unreadSummary on old and new clients!
    const resyncProj = projectScheduleEvent(sent[0]);
    expect(resyncProj.refresh).toEqual({
      runRefresh: { mode: 'all' },
      scheduleList: true,
      sessionIndex: true,
      unreadSummary: true,
    });
    expect(projectScheduleEvent(sent[1]).runPatch.sessionId).toBe('sess-loop-602');
  });

  // 测试价值
  // - 生产入口与可观察结果：ScheduleEventPushStage.nudge / LatestStatePushStage.nudge 及 wakePeerPushStages 在持续 40ms ACK 唤醒流下的实际送达时刻。
  //   1) 队列已可写时入队 changed / latest-state，每 40ms 触发一次 nudge 持续 520ms，必须在首次 125ms / 250ms 窗口到期时完成发送，绝不能在 520ms 内发 0 条；
  //   2) 处于 4s 长退避定时器的暂存队列一旦恢复可写并收到连续 40ms nudge，首次 nudge 把排期提前到 125ms / 250ms，后续 nudge 绝不把排期重新往后推。
  // - Bug／规则依据：审阅实测回归（两个 stage.nudge 先 clearTimeout 再重设，导致持续 40ms ACK 令已可写队列饥饿 520ms 发送 0 条）。
  // - 现有覆盖缺口：既有测试只调用单次 wakePeerPushStages，未覆盖小于合并窗口（40ms < 125ms/250ms）的连续 ACK 唤醒流。
  // - 最小失败输入：可写队列入 1 条 changed 与 1 条 latest-state，随后每 40ms nudge 共 13 次（520ms）。
  // - tier：unit（fake timers，<20ms）。
  it('delivers staged schedule events and latest-state snapshots on time during continuous 40ms ACK nudges without starvation', async () => {
    // Part 1: Direct exact reproduction on ScheduleEventPushStage (125ms) & LatestStatePushStage (250ms):
    // queue is writable, enqueue 1 changed + 1 latest-state, nudge every 40ms for 520ms -> delivered DURING the 520ms stream!
    const directScheduleSent: unknown[] = [];
    const directLatestSent: unknown[] = [];
    const scheduleStage = new ScheduleEventPushStage(
      undefined,
      () => true,
      async (payload) => { directScheduleSent.push(payload); },
      () => {},
    );
    const latestStage = new LatestStatePushStage(
      undefined,
      () => true,
      async (item) => { directLatestSent.push(item); },
      () => {},
    );
    try {
      scheduleStage.enqueue({ type: 'changed', scheduleId: 's-direct' });
      latestStage.enqueue('usage:claude-account-changed', {
        channel: 'usage:claude-account-changed',
        payload: { daily: 7 },
      });

      let scheduleDeliveredByMs: number | null = null;
      let latestDeliveredByMs: number | null = null;
      for (let elapsed = 40; elapsed <= 520; elapsed += 40) {
        await vi.advanceTimersByTimeAsync(40);
        scheduleStage.nudge();
        latestStage.nudge();
        if (scheduleDeliveredByMs === null && directScheduleSent.length > 0) {
          scheduleDeliveredByMs = elapsed;
        }
        if (latestDeliveredByMs === null && directLatestSent.length > 0) {
          latestDeliveredByMs = elapsed;
        }
      }

      expect(directScheduleSent).toEqual([{ type: 'changed', scheduleId: 's-direct' }]);
      expect(directLatestSent).toEqual([
        { channel: 'usage:claude-account-changed', payload: { daily: 7 } },
      ]);
      expect(scheduleDeliveredByMs).toBe(160); // 125ms timer fired between 120ms and 160ms despite 40ms nudges!
      expect(latestDeliveredByMs).toBe(280); // 250ms timer fired between 240ms and 280ms despite 40ms nudges!
    } finally {
      scheduleStage.dispose();
      latestStage.dispose();
    }

    // Part 2: Production dispatch (forwardPush + wakePeerPushStages) after long backoff (>2s timer):
    // first nudge pulls the long backoff earlier to 125ms/250ms, and continuous 40ms nudges never delay it!
    let phoneDepth = 12;
    const sent: Array<{ channel: string; payload: unknown }> = [];
    const client = {
      ...mkClient(),
      getReliableSendQueueDepth: vi.fn((dst: string) => (dst === 'phone' ? phoneDepth : 0)),
      sendPush: vi.fn((_dst: string, channel: string, payload: unknown) => {
        sent.push({ channel, payload });
      }),
    };
    __testing.setActiveClient(client as never);
    subscriptions.subscribe('phone', ['sessions'], 'phone');

    __testing.forwardPush('maker:schedule:event', { type: 'changed', scheduleId: 's-backoff' });
    __testing.forwardPush('maker:schedule:event', { type: 'runtime-state', snapshot: { slotsInUse: 2 } });
    // Advance 5.5s while congested so both stages sit on multi-second exponential backoff timers (2s / 4s).
    await vi.advanceTimersByTimeAsync(5_500);
    expect(sent).toEqual([]);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(1);
    expect(__testing.latestStatePushStageSize('phone')).toBe(1);

    // Window becomes writable and continuous ACKs arrive at t=0, 40, 80, ..., 520ms:
    phoneDepth = 0;
    __testing.wakePeerPushStages('phone');
    let prodScheduleDeliveredAt: number | null = null;
    let prodLatestDeliveredAt: number | null = null;
    for (let elapsed = 40; elapsed <= 520; elapsed += 40) {
      await vi.advanceTimersByTimeAsync(40);
      __testing.wakePeerPushStages('phone');
      if (prodScheduleDeliveredAt === null && sent.some((x) => (x.payload as { type?: string })?.type === 'changed')) {
        prodScheduleDeliveredAt = elapsed;
      }
      if (prodLatestDeliveredAt === null && sent.some((x) => (x.payload as { type?: string })?.type === 'runtime-state')) {
        prodLatestDeliveredAt = elapsed;
      }
    }
    expect(prodScheduleDeliveredAt).toBe(160);
    expect(prodLatestDeliveredAt).toBe(280);
    expect(__testing.scheduleEventPushStageSize('phone')).toBe(0);
    expect(__testing.latestStatePushStageSize('phone')).toBe(0);
  });

  // 测试价值
  // - 生产入口与可观察结果：wireInboundDispatch(routeSessionPeers(deviceLinkClient, agentNetSessionLinks)) 真实分路组合下，
  //   LatestStatePushStage 与 ScheduleEventPushStage 在 Agent-Net bufferedAmount 积压与排空时的送达行为。
  //   1) 走 Agent-Net 会话且底层带 onDrain 的对端（an-drain）：bufferedAmount 排空触发 onDrain -> routeSessionPeers.onPeerSendProgress 立即唤醒送达最后一项；
  //   2) 走 Agent-Net 会话但底层静默排空（无 onDrain、无新入站帧、无重开链）的对端（an-silent）：超限退避后转入 5s 低频兜底（绝不永久 park），排空后自动送达最后一项并在清空后归零定时器；
  //   3) 同一个 routeSessionPeers 下的 DeviceLinkClient 对端（dl-peer）：超过探测上限后 0 定时器挂起，收到真实 cumulative ACK 时经 routeSessionPeers 转发 onPeerSendProgress 立即恢复送达。
  // - Bug／规则依据：审阅实测风险（routeSessionPeers 未透传 onPeerSendProgress，且 AgentNetSessionLinks 深度来自 bufferedAmount，静默排空无新帧时可能永久 park 丢最后一项）。
  // - 现有覆盖缺口：此前仅对 mock client 测试暂存队列，未走真实 routeSessionPeers + AgentNetSessionLinks + SessionPeer 组合。
  // - 最小失败输入：同一 routeSessionPeers 同时挂载 an-silent、an-drain 与 dl-peer，三者在积压 20s 后分别静默排空 bufferedAmount / 触发 onDrain / 放行 relay ACK。
  // - tier：unit（内存 relay + 真实 SessionPeer + fake timers，<50ms）。
  it('delivers final schedule-event and latest-state items across real routeSessionPeers when Agent-Net bufferedAmount drains silently or via onDrain', async () => {
    const quietLog = { debug() {}, info() {}, warn() {}, error() {} };
    const relay = new DispatchTestRelay();
    const hostDl = new DeviceLinkClient({
      getWsUrl: () => 'ws://test/api/device-link/ws',
      getToken: async () => 'jwt-token',
      getHello: () => ({
        deviceName: 'host-node',
        platform: 'darwin',
        appVersion: '1.0.0',
        remoteControlEnabled: true,
        busy: false,
      }),
      createWebSocket: () => relay.makeWebSocket('host-node') as never,
      timing: {
        reconnectBaseMs: 5,
        reconnectMaxMs: 20,
        pingIntervalMs: 60_000,
        pongMissLimit: 4,
        requestTimeoutMs: 2_000,
        transportRetryIntervalMs: 60_000,
      },
    });
    const dlController = makeDispatchTestClient(relay, 'dl-peer');

    type PeerId = 'an-silent' | 'an-drain';
    const bufferedBytes: Record<PeerId, number> = { 'an-silent': 0, 'an-drain': 0 };
    const drainHooks: Partial<Record<PeerId, () => void>> = {};
    const hostSessions: Partial<Record<PeerId, SessionPeer>> = {};
    const ctrlSessions: Partial<Record<PeerId, SessionPeer>> = {};

    const hostLinks = new AgentNetSessionLinks({
      session: (id) => (id === 'an-silent' || id === 'an-drain' ? hostSessions[id] ?? null : null),
      connectionEpoch: () => 1,
      selfDeviceId: () => 'host-node',
      log: quietLog,
    });

    const makeControllerLinks = (peerId: PeerId, withDrainHook: boolean) => {
      const ctrlLinks = new AgentNetSessionLinks({
        session: (id) => (id === 'host-node' ? ctrlSessions[peerId] ?? null : null),
        connectionEpoch: () => 1,
        selfDeviceId: () => peerId,
        log: quietLog,
      });
      let toHost: ((lane: SessionLane, data: Uint8Array) => void) | null = null;
      let toCtrl: ((lane: SessionLane, data: Uint8Array) => void) | null = null;
      hostSessions[peerId] = new SessionPeer({
        wire: {
          write: (lane, data) => {
            const copy = data.slice();
            queueMicrotask(() => toCtrl?.(lane, copy));
          },
          get bufferedAmount() { return bufferedBytes[peerId]; },
          onData: (cb) => { toHost = cb; },
          ...(withDrainHook ? { onDrain: (cb: () => void) => { drainHooks[peerId] = cb; } } : {}),
        },
        laneFor: agentNetSessionLane,
        ...hostLinks.handlers(peerId),
      });
      ctrlSessions[peerId] = new SessionPeer({
        wire: {
          write: (lane, data) => {
            const copy = data.slice();
            queueMicrotask(() => toHost?.(lane, copy));
          },
          get bufferedAmount() { return 0; },
          onData: (cb) => { toCtrl = cb; },
        },
        laneFor: agentNetSessionLane,
        ...ctrlLinks.handlers('host-node'),
      });
      return ctrlLinks;
    };

    const anSilentCtrl = makeControllerLinks('an-silent', false);
    const anDrainCtrl = makeControllerLinks('an-drain', true);
    const routedHost = routeSessionPeers(hostDl, hostLinks);
    const unbindDispatch = wireInboundDispatch(routedHost);

    const received: Record<'an-silent' | 'an-drain' | 'dl-peer', Array<{ channel: string; payload: unknown }>> = {
      'an-silent': [],
      'an-drain': [],
      'dl-peer': [],
    };
    const recordPush = (peer: 'an-silent' | 'an-drain' | 'dl-peer') => (env: Envelope) => {
      if (env.kind !== 'push') return;
      const p = env.payload as { channel: string; payload: unknown };
      if (p.channel === 'maker:event') return;
      received[peer].push({ channel: p.channel, payload: p.payload });
    };
    anSilentCtrl.onFrame(recordPush('an-silent'));
    anDrainCtrl.onFrame(recordPush('an-drain'));
    dlController.onFrame(recordPush('dl-peer'));

    try {
      hostDl.start();
      dlController.start();
      await vi.advanceTimersByTimeAsync(20);

      const openPayload = {
        controllerName: 'test-ctrl',
        protocolVersion: PROTOCOL_VERSION,
        appVersion: '1.0.0',
        capabilities: ['explicit-subscribe-v1'],
      };
      await Promise.all([
        anSilentCtrl.openLink('host-node', openPayload),
        anDrainCtrl.openLink('host-node', openPayload),
        dlController.openLink('host-node', openPayload),
      ]);
      await Promise.all([
        anSilentCtrl.invoke('host-node', { channel: DL_SUBSCRIBE_CHANNEL, args: [{ topics: ['sessions'] }] }),
        anDrainCtrl.invoke('host-node', { channel: DL_SUBSCRIBE_CHANNEL, args: [{ topics: ['sessions'] }] }),
        dlController.invoke('host-node', { channel: DL_SUBSCRIBE_CHANNEL, args: [{ topics: ['sessions'] }] }),
      ]);
      for (const peer of ['an-silent', 'an-drain', 'dl-peer'] as const) received[peer].length = 0;

      // Verify routing ownership: Agent-Net peers are owned inbound by hostLinks, dl-peer is on DeviceLinkClient.
      expect(hostLinks.ownsInbound('an-silent')).toBe(true);
      expect(hostLinks.ownsInbound('an-drain')).toBe(true);
      expect(hostLinks.ownsInbound('dl-peer')).toBe(false);
      expect(routedHost.hasReliableSendProgress('an-silent')).toBe(false);
      expect(routedHost.hasReliableSendProgress('an-drain')).toBe(false);
      expect(routedHost.hasReliableSendProgress('dl-peer')).toBe(true);

      // Congest all three peers above SESSION_ACTIVITY_WINDOW_SOFT_CAP (8 units = 256 KiB on Agent-Net):
      bufferedBytes['an-silent'] = 512 * 1024;
      bufferedBytes['an-drain'] = 512 * 1024;
      // Hold all return frames (including compact transport-ack-v2) from dl-peer -> host-node and fill 10 unacknowledged pushes on hostDl:
      const heldDlAcks: Envelope[] = [];
      const origRoute = relay.route.bind(relay);
      vi.spyOn(relay, 'route').mockImplementation((senderId, socket, envelope) => {
        if (senderId === 'dl-peer' && envelope.dst === 'host-node') {
          heldDlAcks.push(envelope);
          return;
        }
        origRoute(senderId, socket, envelope);
      });
      for (let i = 0; i < 10; i++) {
        hostDl.sendPush('dl-peer', 'maker:event', { sessionId: 's-fill', idx: i });
      }
      expect(routedHost.getReliableSendQueueDepth('dl-peer')).toBeGreaterThanOrEqual(8);
      expect(routedHost.getReliableSendQueueDepth('an-silent')).toBe(16);
      expect(routedHost.getReliableSendQueueDepth('an-drain')).toBe(16);
      received['dl-peer'].length = 0;

      // Broadcast schedule events + latest-state snapshots (multiple updates -> only latest must deliver!):
      __testing.forwardPush('maker:schedule:event', {
        type: 'completed',
        scheduleId: 's-routed',
        runId: 'r-1',
        sessionId: 'sess-routed-1',
      });
      __testing.forwardPush('maker:schedule:event', { type: 'changed', scheduleId: 's-routed' });
      __testing.forwardPush('usage:claude-account-changed', { daily: 1 });
      __testing.forwardPush('usage:claude-account-changed', { daily: 99 });
      __testing.forwardPush('maker:schedule:event', { type: 'runtime-state', snapshot: { slotsInUse: 4 } });

      // Advance 20s (past STALL_MAX_PROBES = 14):
      await vi.advanceTimersByTimeAsync(20_000);
      expect(received['an-silent']).toEqual([]);
      expect(received['an-drain']).toEqual([]);
      expect(received['dl-peer']).toEqual([]);

      // dl-peer (DeviceLinkClient) parked at 0 timers; Agent-Net peers kept their low-frequency 5s fallback active!
      expect(__testing.scheduleEventPushStageHasActiveTimer('dl-peer')).toBe(false);
      expect(__testing.latestStatePushStageHasActiveTimer('dl-peer')).toBe(false);
      expect(__testing.scheduleEventPushStageHasActiveTimer('an-silent')).toBe(true);
      expect(__testing.latestStatePushStageHasActiveTimer('an-silent')).toBe(true);

      const expectedDelivered = [
        {
          channel: 'maker:schedule:event',
          payload: { type: 'completed', scheduleId: 's-routed', runId: 'r-1', sessionId: 'sess-routed-1' },
        },
        { channel: 'maker:schedule:event', payload: { type: 'changed', scheduleId: 's-routed' } },
        { channel: 'usage:claude-account-changed', payload: { daily: 99 } },
        { channel: 'maker:schedule:event', payload: { type: 'runtime-state', snapshot: { slotsInUse: 4 } } },
      ];

      // 1) an-drain: bufferedAmount drops to 0 and SessionWire.onDrain fires -> wakes immediately via routeSessionPeers.onPeerSendProgress (<300ms)!
      bufferedBytes['an-drain'] = 0;
      drainHooks['an-drain']?.();
      await vi.advanceTimersByTimeAsync(300);
      expect(received['an-drain']).toEqual(expectedDelivered);
      expect(__testing.scheduleEventPushStageHasActiveTimer('an-drain')).toBe(false);
      expect(__testing.latestStatePushStageHasActiveTimer('an-drain')).toBe(false);
      // an-silent is still buffered, so it still received nothing:
      expect(received['an-silent']).toEqual([]);

      // 2) an-silent: bufferedAmount silently drops to 0 with ZERO inbound frames, ZERO onDrain, ZERO link re-open!
      // Low-frequency 5s fallback delivers all final items within 5.5s and then stops all timers!
      bufferedBytes['an-silent'] = 0;
      await vi.advanceTimersByTimeAsync(5_500);
      expect(received['an-silent']).toEqual(expectedDelivered);
      expect(__testing.scheduleEventPushStageSize('an-silent')).toBe(0);
      expect(__testing.latestStatePushStageSize('an-silent')).toBe(0);
      expect(__testing.scheduleEventPushStageHasActiveTimer('an-silent')).toBe(false);
      expect(__testing.latestStatePushStageHasActiveTimer('an-silent')).toBe(false);

      // 3) dl-peer: remains parked until cumulative ACK arrives through relay -> routeSessionPeers.onPeerSendProgress wakes it immediately!
      expect(received['dl-peer']).toEqual([]);
      vi.mocked(relay.route).mockRestore();
      const lastAck = heldDlAcks.at(-1)!;
      relay.route('dl-peer', { push() {} } as never, lastAck);
      await vi.advanceTimersByTimeAsync(300);
      expect(received['dl-peer']).toEqual(expectedDelivered);
      expect(__testing.scheduleEventPushStageHasActiveTimer('dl-peer')).toBe(false);
      expect(__testing.latestStatePushStageHasActiveTimer('dl-peer')).toBe(false);
    } finally {
      unbindDispatch();
      anSilentCtrl.stop();
      anDrainCtrl.stop();
      hostLinks.stop();
      dlController.stop();
      hostDl.stop();
    }
  });

  // 测试价值
  // - 生产入口与可观察结果：ScheduleEventPushStage 拥塞暂存对主线新增 skipped 原位时间补丁与 changed(skippedRunId) 去重字段的语义保持。
  //   1) 真实无条件 `{ type: 'changed', scheduleId }` 排队期间若到达后续空跳派生的 `{ type: 'changed', scheduleId, skippedRunId }`，
  //      合并结果必须保留无条件 `changed`（不带 skippedRunId），防止现代接收端因同次 skipped 已原位打补丁而吞掉更早的真实任务变更；
  //   2) 连续带时间戳的静默 `skipped` 折叠为最新排期，同时保留尚未被恢复刷新覆盖的 `preRunCheckSucceeded: true`，且前序 `fired`
  //      绝不会导致后序终态 `skipped` 在无索引刷新的事件（`deferred`）前被误删。
  // - Bug／规则依据：合入主线 skipped 时间补丁与远程 skip 去重后的拥塞折叠不变量。
  // - 现有覆盖缺口：既有测试覆盖旧版无时间戳 skipped，未覆盖 `changed(skippedRunId)` 与原位可补丁 `skipped` 的跨事件折叠交互。
  // - 最小失败输入：① `changed(sched)` + `skipped(r2)` + `changed(sched, skippedRunId:'r2')`；② `fired(r1)` + `skipped(r1, nextFireAt)` + `deferred(r2)`。
  // - tier：unit（假时钟，<20ms）。
  it('preserves unconditional changed across skippedRunId follow-ups and keeps patchable skipped terminal state intact', async () => {
    vi.useFakeTimers();
    try {
      let writable = false;
      const sent: unknown[] = [];
      const stage = new ScheduleEventPushStage(
        undefined,
        () => writable,
        async (payload) => {
          sent.push(payload);
        },
        () => {},
      );

      // Case 1: Real `changed` + `skipped(r2)` + `changed(skippedRunId: 'r2')` must emit unconditional `changed`!
      stage.enqueue({ type: 'changed', scheduleId: 'sched-edit' });
      stage.enqueue({
        type: 'skipped',
        scheduleId: 'sched-edit',
        runId: 'r2',
        sessionId: '',
        lastFiredAt: 1_000,
        lastFinishedAt: 1_100,
        nextFireAt: 61_100,
      });
      stage.enqueue({ type: 'changed', scheduleId: 'sched-edit', skippedRunId: 'r2' });

      writable = true;
      stage.nudge();
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toEqual([
        {
          type: 'skipped',
          scheduleId: 'sched-edit',
          runId: 'r2',
          sessionId: '',
          lastFiredAt: 1_000,
          lastFinishedAt: 1_100,
          nextFireAt: 61_100,
        },
        { type: 'changed', scheduleId: 'sched-edit' },
      ]);

      // Case 2: Consecutive patchable skips collapse while preserving preRunCheckSucceeded: true,
      // and an earlier `fired` never drops a later terminal patchable `skipped` before `deferred` (`sessionIndex: false`).
      sent.length = 0;
      writable = false;
      stage.enqueue({
        type: 'skipped',
        scheduleId: 'sched-hb',
        runId: 'hb-1',
        sessionId: '',
        lastFinishedAt: 2_000,
        nextFireAt: 12_000,
        preRunCheckSucceeded: true,
      });
      stage.enqueue({
        type: 'skipped',
        scheduleId: 'sched-hb',
        runId: 'hb-2',
        sessionId: '',
        lastFinishedAt: 12_000,
        nextFireAt: 22_000,
      });
      stage.enqueue({
        type: 'skipped',
        scheduleId: 'sched-hb',
        runId: 'hb-3',
        sessionId: '',
        lastFinishedAt: 22_000,
        nextFireAt: 32_000,
      });

      stage.enqueue({ type: 'fired', scheduleId: 'sched-guard', runId: 'g-1' });
      stage.enqueue({
        type: 'skipped',
        scheduleId: 'sched-guard',
        runId: 'g-1',
        sessionId: '',
        lastFinishedAt: 5_000,
        nextFireAt: 65_000,
      });
      stage.enqueue({
        type: 'deferred',
        scheduleId: 'sched-guard',
        runId: 'g-2',
      });

      writable = true;
      stage.nudge();
      await vi.advanceTimersByTimeAsync(200);
      expect(sent).toEqual([
        {
          type: 'skipped',
          scheduleId: 'sched-hb',
          runId: 'hb-1',
          sessionId: '',
          lastFinishedAt: 2_000,
          nextFireAt: 12_000,
          preRunCheckSucceeded: true,
        },
        {
          type: 'skipped',
          scheduleId: 'sched-hb',
          runId: 'hb-3',
          sessionId: '',
          lastFinishedAt: 22_000,
          nextFireAt: 32_000,
        },
        { type: 'fired', scheduleId: 'sched-guard', runId: 'g-1' },
        {
          type: 'skipped',
          scheduleId: 'sched-guard',
          runId: 'g-1',
          sessionId: '',
          lastFinishedAt: 5_000,
          nextFireAt: 65_000,
        },
        {
          type: 'deferred',
          scheduleId: 'sched-guard',
          runId: 'g-2',
        },
      ]);
      stage.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
