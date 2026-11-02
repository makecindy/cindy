/**
 * Locks the real Electron desktop path for device-link voice channels.
 *
 * Mobile voice credential sync itself is removed (mobile voice input now uses
 * the managed Cindy voice service); the channel stays matched so old mobile
 * builds get a readable rejection. This source guard prevents a future
 * bootstrap refactor from leaving dispatch unreachable from the running
 * desktop DeviceLinkClient.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, Script } from 'node:vm';

import {
  DeviceLinkClient,
  DeviceLinkError,
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
  DEVICE_LINK_CAPABILITY_GITHUB_READ_V1,
  DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1,
  DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM,
  DL_SUBSCRIBE_CHANNEL,
  isProviderSharePeer,
  isSharedTaskPeer,
  parseSharedTaskPeer,
  PROTOCOL_VERSION,
  providerShareGuestPeer,
  providerShareHostPeer,
  sharedTaskGuestPeer,
  sharedTaskHostPeer,
  sharedTaskTopics,
  type Envelope,
  type InvokePayload,
  type InvokeResultPayload,
  type LinkOpenPayload,
  type WsLike,
} from '@cindy/device-link';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { DEVICE_LINK_PUSH } from '../../shared/deviceLinkIpc';
import { requiresSessionLink } from '../device-link/linkRecovery';
import { createSubscriptionReplayScheduler } from '../device-link/subscriptionReplayScheduler';
import type * as SubscriptionRegistry from '../device-link/subscriptions';

const mainRoot = resolve(__dirname, '..');

// Guard contract (engineering-conventions §3.2): execute the real bootstrap
// registration without starting its Electron host. Extract and compile once;
// never reproduce the callback's branch logic in the test harness.
const deviceLinkSource = ts.createSourceFile(
  'device-link/index.ts',
  readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8'),
  ts.ScriptTarget.Latest,
  true,
);
const acceptedRegistrations: string[] = [];
const inboundAcceptedRegistrations: string[] = [];
function findAcceptedRegistration(node: ts.Node): void {
  if (ts.isCallExpression(node)
    && ts.isPropertyAccessExpression(node.expression)
    && node.expression.expression.getText(deviceLinkSource) === 'client'
    && node.expression.name.text === 'onPeerStreamAccepted') {
    acceptedRegistrations.push(node.getText(deviceLinkSource));
  }
  if (ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === 'setOrdinaryPeerLinkAcceptedListener'
    && node.arguments[0] && ts.isArrowFunction(node.arguments[0])) {
    inboundAcceptedRegistrations.push(node.getText(deviceLinkSource));
  }
  ts.forEachChild(node, findAcceptedRegistration);
}
findAcceptedRegistration(deviceLinkSource);
if (acceptedRegistrations.length !== 1) {
  throw new Error(`Expected one peer-accept registration, found ${acceptedRegistrations.length}`);
}
if (inboundAcceptedRegistrations.length !== 1) {
  throw new Error(`Expected one inbound peer-accept registration, found ${inboundAcceptedRegistrations.length}`);
}
const acceptedRegistration = new Script(ts.transpileModule(acceptedRegistrations[0], {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);
const inboundAcceptedRegistration = new Script(ts.transpileModule(inboundAcceptedRegistrations[0], {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText);

function productionFunction(source: ts.SourceFile, name: string): string {
  const declaration = source.statements.find((node): node is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing production function: ${name}`);
  return declaration.getText(source).replace(/^export /, '');
}
const dispatchSource = ts.createSourceFile('dispatch.ts',
  readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
const inboundDispatch = new Script(ts.transpileModule([
  productionFunction(dispatchSource, 'sanitizeControllerCapabilities'),
  productionFunction(dispatchSource, 'handleLinkOpen'),
  'handleLinkOpen;',
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
const remoteSubscribeEntry = new Script(ts.transpileModule(
  `${productionFunction(deviceLinkSource, 'remoteSubscribe')}\nremoteSubscribe;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText);
// Each simulated desktop needs its own module-level registry. Compile the actual
// dependency-free module once, then instantiate separate exports; no resetModules.
const subscriptionRegistry = new Script(ts.transpileModule(
  readFileSync(resolve(mainRoot, 'device-link/subscriptions.ts'), 'utf8'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText);

/** FIFO relay adapter only: production clients perform handshake, ACK and recovery. */
class RecoveryRelay {
  readonly sockets = new Map<string, RecoverySocket>();
  readonly sent: Array<{ sender: string; envelope: Envelope }> = [];
  private readonly queue: Array<() => void> = [];
  constructor(private readonly confirm: boolean) {}

  connect(id: string): RecoverySocket {
    const socket = new RecoverySocket(this, id);
    this.sockets.set(id, socket);
    this.queue.push(() => socket.emit('open'));
    return socket;
  }
  route(sender: string, envelope: Envelope): void {
    if (envelope.kind === 'hello') {
      this.queue.push(() => this.sockets.get(sender)?.push({
        v: PROTOCOL_VERSION, kind: 'hello-ack', payload: {
          serverProtocolVersion: PROTOCOL_VERSION, deviceId: sender, userId: 'same-owner',
        },
      }));
      return;
    }
    if (!envelope.dst) return;
    // Compatibility cell: a peer with reliable transport but no confirmation capability.
    if (!this.confirm && envelope.kind === 'link-open') {
      const payload = envelope.payload as LinkOpenPayload;
      envelope = { ...envelope, payload: { ...payload,
        capabilities: payload.capabilities?.filter((item) => item !== DEVICE_LINK_CAPABILITY_RELIABLE_LINK_CONFIRM),
      } };
    }
    this.sent.push({ sender, envelope });
    const destination = this.sockets.get(envelope.dst!);
    if (destination) this.queue.push(() => {
      if (this.sockets.get(envelope.dst!) === destination) destination.push({ ...envelope, src: sender });
    });
  }
  async flush(): Promise<void> {
    for (let steps = 0, idle = 0; steps < 1_000; steps += 1) {
      const deliver = this.queue.shift();
      if (deliver) { idle = 0; deliver(); }
      await vi.advanceTimersByTimeAsync(0);
      if (!deliver && ++idle === 3) return;
    }
    throw new Error('Recovery relay did not become idle');
  }
}

class RecoverySocket implements WsLike {
  readonly bufferedAmount = 0;
  private readonly handlers = new Map<string, Array<(...args: never[]) => void>>();
  constructor(private readonly relay: RecoveryRelay, private readonly id: string) {}
  send(data: string): void { this.relay.route(this.id, JSON.parse(data) as Envelope); }
  on(event: string, callback: (...args: never[]) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const callback of this.handlers.get(event) ?? []) callback(...args as never[]);
  }
  push(envelope: Envelope): void { this.emit('message', { toString: () => JSON.stringify(envelope) }); }
  close(): void {
    if (this.relay.sockets.get(this.id) === this) this.relay.sockets.delete(this.id);
    this.emit('close', 1006, 'test relay disconnect');
  }
}

function recoveryDesktop(relay: RecoveryRelay, id: string) {
  const exports = {} as typeof SubscriptionRegistry;
  subscriptionRegistry.runInNewContext({ exports });
  const registry = exports;
  const diagnostic = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const client = new DeviceLinkClient({
    getWsUrl: () => 'ws://memory.invalid/device-link', getToken: async () => 'test-token',
    getHello: () => ({ deviceName: id, platform: 'darwin', appVersion: 'test', remoteControlEnabled: true, busy: false }),
    createWebSocket: () => relay.connect(id), logger: diagnostic,
    timing: { reconnectBaseMs: 1, reconnectMaxMs: 1, pingIntervalMs: 60_000, requestTimeoutMs: 2_000 },
  });
  const noOp = () => {};
  const context = createContext({
    client, subscriptions: registry, isProviderSharePeer, isSharedTaskPeer,
    cancelLinkAcceptRetry: noOp, readDeviceLinkSettings: () => ({ remoteControlEnabled: true }),
    isControllerRevoked: () => false, resolveControllerName: (_peer: string, name: string) => name,
    MAX_CONTROLLER_CAPABILITIES: 32, MAX_CONTROLLER_CAPABILITY_LEN: 80,
    topicSubscriptionControllers: new Set(), acceptedLinkControllers: new Set(),
    DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, DEVICE_LINK_CAPABILITY_GITHUB_READ_V1,
    DEVICE_LINK_CAPABILITY_HISTORY_VIEW_V1,
    app: { getVersion: () => 'test' }, computeAllowlistHash: () => 'test', LEGACY_TOPIC: registry.LEGACY_TOPIC,
    markControllerLinkActive: noOp, syncForwarding: noOp, flushRemoteInvokeResultOutbox: noOp,
    flushMakerEventBatchesFor: noOp, drainOfflinePushQueueTo: noOp,
    scheduleLinkAcceptRetry: () => { throw new Error('Unexpected failed link accept'); },
    onOrdinaryPeerLinkAccepted: undefined,
    setOrdinaryPeerLinkAcceptedListener: (listener: (peer: string) => void) => { context.onOrdinaryPeerLinkAccepted = listener; },
    log: diagnostic, shortId: (peer: string) => peer.slice(0, 8),
  });
  const accept = inboundDispatch.runInContext(context) as
    (client: DeviceLinkClient, src: string, requestId: string, payload: LinkOpenPayload) => void;
  const subscribed = vi.fn();
  const pushes: unknown[] = [];
  client.onFrame((frame) => {
    if (frame.kind === 'link-open') accept(client, frame.src!, frame.id!, frame.payload as LinkOpenPayload);
    if (frame.kind === 'invoke' && (frame.payload as InvokePayload).channel === DL_SUBSCRIBE_CHANNEL) {
      const [request] = (frame.payload as InvokePayload).args as [{ topics: string[]; controllerName: string; capabilities: string[] }];
      registry.subscribe(frame.src!, request.topics, request.controllerName, request.capabilities);
      subscribed(frame.src, request.topics);
      client.sendInvokeResult(frame.src!, frame.id!, { ok: true, result: null });
    }
    if (frame.kind === 'push') pushes.push(frame.payload);
  });
  // Fault injection uses the real registry cleanup primitive, preserving remembered
  // topics exactly as transient signaling loss does; unrelated host cleanup is excluded.
  client.onStatusChange((status) => {
    if (status !== 'online') for (const peer of registry.getControllerIds()) registry.clearController(peer);
  });
  return { client, context, registry, subscribed, pushes, diagnostic };
}

describe('mobile voice credential sync desktop bootstrap path', () => {
  it('starts device-link service from Electron bootstrap', () => {
    const bootstrap = readFileSync(resolve(mainRoot, 'bootstrap-electron.ts'), 'utf8');

    expect(bootstrap).toMatch(/import \{[^}]*\binitDeviceLinkService\b[^}]*\} from '\.\/device-link';/);
    const serviceInit = bootstrap.search(/\binitDeviceLinkService\s*\(\s*\{/);
    const ipcRegistration = bootstrap.search(/\bregisterDeviceLinkIpc\s*\(\s*\)\s*;/);
    expect(serviceInit).toBeGreaterThanOrEqual(0);
    expect(ipcRegistration).toBeGreaterThanOrEqual(0);
    expect(serviceInit).toBeLessThan(ipcRegistration);
  });

  it('wires the DeviceLinkClient inbound frames into controlled-desktop dispatch', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('wireInboundDispatch,');
    const listenerRegistration = deviceLinkHost.search(
      /\bsetControllersChangedListener\s*\(\s*\(\s*controllers\s*,\s*updateRelaunchControllers\s*\)\s*=>/,
    );
    const inboundWiring = deviceLinkHost.search(/\bwireInboundDispatch\s*\(\s*client\s*\)\s*;/);
    expect(listenerRegistration).toBeGreaterThanOrEqual(0);
    expect(inboundWiring).toBeGreaterThanOrEqual(0);
    expect(listenerRegistration).toBeLessThan(inboundWiring);
  });

  it('replays desktop subscriptions when a remote device becomes controllable again', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    expect(deviceLinkHost).toContain('const available = snap.online && snap.remoteControlEnabled;');
    // `!== true` 而非 `=== false`:断线时 availability 视图整体清空,重连后首帧
    // presence(wasAvailable=undefined)同样必须触发重放,接续 DEVICE_OFFLINE
    // 结束的恢复轮次(#1520 review P1)。
    expect(deviceLinkHost).toContain('if (available && wasAvailable !== true)');
    expect(deviceLinkHost).toContain('replayActiveSubscriptions(`presence-online:${snap.deviceId.slice(0, 8)}`, snap.deviceId);');
    expect(deviceLinkHost).toContain('createSubscriptionReplayScheduler({');
    // Preserve unknown after reconnect; only explicit unavailability stops retries.
    expect(deviceLinkHost).toContain(
      'getPresenceAvailability: (deviceId) => presenceAvailableByDevice.get(deviceId)',
    );
    expect(deviceLinkHost).toContain('?? (presenceOnlineByDevice.get(deviceId) === false ? false : undefined)');
    expect(deviceLinkHost).toContain("replayActiveSubscriptions('directory-online', deviceId);");
    expect(deviceLinkHost).toContain('isPermanentSubscriptionReplayError(error, presenceAvailableByDevice.get(deviceId))');
  });

  it.each([
    { label: 'ordinary device', peer: 'remote-device', replay: true },
    { label: 'provider-share host', peer: providerShareHostPeer('share', 'remote-device'), replay: false },
    { label: 'provider-share guest', peer: providerShareGuestPeer('share', 'member', 'remote-device'), replay: false },
    { label: 'shared-task host / new stream', peer: sharedTaskHostPeer('task', 'remote-device'), replay: true },
    { label: 'shared-task host / same stream', peer: sharedTaskHostPeer('task', 'remote-device'), replay: true, sameStream: true },
    { label: 'shared-task guest', peer: sharedTaskGuestPeer('task', 'member', 'remote-device'), replay: true },
  ])('出站 link 接受后按 peer 重放订阅，排除 provider-share：$label', ({ peer, replay, sameStream }) => {
    // 失效后果(2026-10-20 线上事故):被控端 relay 探活超时 3s 重连,deactivateAllControllers
    // 清掉它那边本机的活跃订阅注册;本机 relay/presence/熔断全程无感知,传输层 link 经
    // replay 透明恢复,既有的 ws-online/presence/熔断恢复触发器一个都不 firing——push 驱动的
    // 列表 running 转圈与完成未读绿点永久冻结在旧值,新运行的远程任务不显示状态,
    // 而 invoke 与 session 事件流完全正常。onPeerStreamAccepted 是出站握手已验证、
    // 对端恢复业务帧投递之前的恢复入口;反向入站握手另由下面的回归覆盖。provider-share
    // peer 只轮询不订阅(协议契约),是唯一被排除的类型。旧 indexOf 顺序断言在
    // replay 移出排除条件块后仍通过(#6572 review);这里执行实际注册的回调,
    // 验证恢复事件是否交给该 peer 的调度器。不是双机故障恢复的端到端验收。
    const callbacks: Array<(peer: string, streamId: string) => void> = [];
    const replayActiveSubscriptions = vi.fn();
    const sharedHostStreams = new Map<string, { streamId: string; epoch: number }>();
    if (sameStream) sharedHostStreams.set(peer, { streamId: 'accepted-stream', epoch: 1 });
    acceptedRegistration.runInNewContext({
      client: { onPeerStreamAccepted: (callback: typeof callbacks[number]) => callbacks.push(callback) },
      isProviderSharePeer,
      parseSharedTaskPeer,
      replayActiveSubscriptions,
      sharedHostStreams,
      sharedHostSourceEpoch: 1,
    });
    expect(callbacks).toHaveLength(1);
    expect(replayActiveSubscriptions).not.toHaveBeenCalled();

    callbacks[0](peer, 'accepted-stream');

    // Exact target matters: losing the peer argument would replay healthy peers.
    // Ordinary/guest peers and an unchanged shared-host stream must still replay
    // before the callback's existing early return; provider-share must never do so.
    expect(replayActiveSubscriptions.mock.calls).toEqual(
      replay ? [[`link-accepted:${peer.slice(0, 8)}`, peer]] : [],
    );
  });

  it.each([false, true])('互控设备 B 先反向重连时恢复 A→B 订阅，不扰动健康 C（确认能力=%s）', async (confirm) => {
    // #6572 Codex review: B relay reconnect drops A's active subscriptions; B's
    // inbound handshake can restore A's bidirectional transport without any A
    // outbound-accept event. Exercise real clients, handleLinkOpen, remoteSubscribe,
    // replay scheduler and registry. This guard isolates Electron side effects;
    // its observable result is a topic-gated push reaching A again, not a spy call.
    vi.useFakeTimers();
    const relay = new RecoveryRelay(confirm);
    const a = recoveryDesktop(relay, 'desktop-a');
    const b = recoveryDesktop(relay, 'desktop-b');
    const c = recoveryDesktop(relay, 'desktop-c');
    const refs = [
      { deviceId: 'desktop-b', topics: ['session:remote-b'] },
      { deviceId: 'desktop-c', topics: ['session:healthy-c'] },
    ];
    const open = (client: DeviceLinkClient, peer: string) => client.openLink(peer, {
      controllerName: 'Test desktop', protocolVersion: PROTOCOL_VERSION, appVersion: 'test',
      capabilities: [DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1],
    });
    Object.assign(a.context, {
      sharedTaskTopics, assertNotStandby: () => {}, assertRemoteControlTargetEnabled: () => {},
      assertRemoteControlTargetEnabledAfterReopen: () => {},
      snapshotSubscriptions: (peer?: string) => refs.filter((ref) => !peer || ref.deviceId === peer),
      openLinkCloseEpochs: new Map(), ensureOnlineForRequest: async () => {},
      requiresSessionLink, openRemoteLink: (peer: string) => open(a.client, peer),
      DeviceLinkError, DL_SUBSCRIBE_CHANNEL, deviceName: () => 'Desktop A',
      CONTROLLER_CAPABILITIES: [], responsivenessTracker: null,
    });
    const remoteSubscribe = remoteSubscribeEntry.runInContext(a.context) as
      (peer: string, topics: string[]) => Promise<InvokeResultPayload>;
    const scheduler = createSubscriptionReplayScheduler({
      snapshotSubscriptions: a.context.snapshotSubscriptions, remoteSubscribe,
      isLinkTornDown: () => false, isRelayOnline: () => a.client.getStatus() === 'online',
      isDeviceUnresponsive: () => false, getPresenceAvailability: () => true,
      isPermanentError: () => true, log: a.diagnostic,
    });
    try {
      for (const desktop of [a, b, c]) desktop.client.start();
      await relay.flush();
      for (const [client, peer] of [[a.client, 'desktop-b'], [b.client, 'desktop-a'], [a.client, 'desktop-c']] as const) {
        const opened = open(client, peer); await relay.flush(); await opened;
      }
      const seeded = Promise.all([
        ...refs.map((ref) => remoteSubscribe(ref.deviceId, ref.topics)),
        b.client.invoke('desktop-a', { channel: DL_SUBSCRIBE_CHANNEL, args: [{
          topics: ['session:remote-a'], controllerName: 'Desktop B', capabilities: [],
        }] }),
      ]);
      await relay.flush(); await seeded;
      expect(b.registry.getControllersForTopic('session:remote-b')).toEqual(['desktop-a']);
      expect(a.registry.getControllersForTopic('session:remote-a')).toEqual(['desktop-b']);
      expect(c.registry.getControllersForTopic('session:healthy-c')).toEqual(['desktop-a']);

      Object.assign(a.context, {
        replayActiveSubscriptions: scheduler.replay, DEVICE_LINK_PUSH, broadcast: vi.fn(),
        parseSharedTaskPeer, sharedHostStreams: new Map(), sharedHostSourceEpoch: 0,
      });
      inboundAcceptedRegistration.runInContext(a.context);
      acceptedRegistration.runInContext(a.context);
      const outboundAccepted = vi.fn();
      a.client.onPeerStreamAccepted(outboundAccepted);
      const healthySocket = relay.sockets.get('desktop-c');
      const aSocket = relay.sockets.get('desktop-a');
      const recoveryStart = relay.sent.length;
      b.subscribed.mockClear(); c.subscribed.mockClear();

      relay.sockets.get('desktop-b')!.close();
      expect(b.registry.getControllersForTopic('session:remote-b')).toEqual([]);
      expect(b.registry.getKnownControllersForTopic('session:remote-b')).toEqual(['desktop-a']);
      await vi.advanceTimersByTimeAsync(10); await relay.flush();
      const reopened = open(b.client, 'desktop-a'); // B recovers first; A receives no reconnect/presence trigger.
      await relay.flush(); await reopened;

      expect(a.client.isLinkReady('desktop-b')).toBe(true);
      // Legacy reliable peer proves the missing edge with no outbound callback at A.
      // Confirmation-aware peers may need one existing readiness-driven reciprocal open.
      expect(outboundAccepted.mock.calls.length).toBeLessThanOrEqual(confirm ? 1 : 0);
      expect(relay.sent.slice(recoveryStart).filter(({ sender, envelope }) =>
        sender === 'desktop-a' && envelope.kind === 'link-open')).toHaveLength(outboundAccepted.mock.calls.length);
      expect(b.registry.getControllersForTopic('session:remote-b')).toEqual(['desktop-a']);
      expect(b.subscribed).toHaveBeenCalledWith('desktop-a', ['session:remote-b']);
      expect(c.subscribed).not.toHaveBeenCalled();
      expect(c.registry.getControllersForTopic('session:healthy-c')).toEqual(['desktop-a']);
      expect(a.client.isLinkReady('desktop-c')).toBe(true);
      expect(relay.sockets.get('desktop-c')).toBe(healthySocket);
      expect(relay.sockets.get('desktop-a')).toBe(aSocket);
      expect(relay.sent.slice(recoveryStart).some(({ envelope }) => envelope.dst === 'desktop-c')).toBe(false);

      for (const peer of b.registry.getControllersForTopic('session:remote-b')) {
        b.client.sendPush(peer, 'maker:event', { recovered: true });
      }
      await relay.flush();
      expect(a.pushes).toContainEqual({ channel: 'maker:event', payload: { recovered: true } });
      expect(a.diagnostic.error).not.toHaveBeenCalled();
    } finally {
      scheduler.teardown();
      for (const desktop of [a, b, c]) { desktop.client.stop(); desktop.registry.clearAll(); }
      vi.useRealTimers();
    }
  });

  it('每个 relay 连接代上线时从设备目录补齐展示名与已在线桌面', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8');

    // 自建中转必须经统一路由，避免目录刷新把 Cindy 账号 token 发给用户服务器。
    expect(deviceLinkHost).toContain("deviceLinkApiFetch<DeviceDirectoryResponse>('/api/device-link/devices'");
    const onlineBranch = deviceLinkHost.indexOf("if (status === 'online') {");
    const seedCachedNames = deviceLinkHost.indexOf(
      'seedControllerDisplayNamesFromLastKnown();',
      onlineBranch,
    );
    const refreshDirectory = deviceLinkHost.indexOf(
      'void refreshControllerDisplayNamesFromDirectory(displayNameGeneration);',
      onlineBranch,
    );
    const replaySubscriptions = deviceLinkHost.indexOf(
      "replayActiveSubscriptions('ws-online');",
      onlineBranch,
    );
    expect(onlineBranch).toBeGreaterThanOrEqual(0);
    expect(seedCachedNames).toBeGreaterThan(onlineBranch);
    expect(refreshDirectory).toBeGreaterThan(seedCachedNames);
    expect(replaySubscriptions).toBeGreaterThan(refreshDirectory);
    expect(deviceLinkHost).toContain(
      'generation !== controllerDisplayNameRefreshGeneration',
    );
    expect(deviceLinkHost).toContain(
      'const directoryRequestSequence = beginControllerDisplayNameDirectoryRefresh();',
    );
    expect(deviceLinkHost).toContain(
      '!isLatestControllerDisplayNameDirectoryRefresh(directoryRequestSequence)',
    );
    expect(deviceLinkHost).toContain(
      'latestControllerDisplayNameDirectoryRefresh = {',
    );
    expect(deviceLinkHost).toContain(
      'const displayNameRequestEpoch = controllerDisplayNameFreshness.epoch;',
    );
    expect(deviceLinkHost).toContain(
      'const presenceRequestEpoch = controllerPresenceFreshness.epoch;',
    );
    expect(deviceLinkHost).toContain(
      'applyControllerDisplayNamePresence({',
    );
    expect(deviceLinkHost).toContain(
      "Object.prototype.hasOwnProperty.call(snap, 'selfName')",
    );
    expect(deviceLinkHost).toContain('applyControllerDisplayNameDirectorySnapshot({');
    expect(deviceLinkHost).toContain('applyControllerPresenceListSnapshot(result.devices ?? [], presenceRequestEpoch);');
    expect(deviceLinkHost).toContain(
      'markControllerPresenceFresh(controllerPresenceFreshness, snap.deviceId);',
    );
    expect(deviceLinkHost).toContain(
      'if (isMobilePlatform(platform)) handleMobilePeerOnline(deviceId);',
    );
  });

  it('presence 展示名统一走协调器，无有效权威名时保留 dispatch 回退链', () => {
    const deviceLinkHost = readFileSync(resolve(mainRoot, 'device-link/index.ts'), 'utf8')
      .replace(/\r\n/g, '\n');
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8')
      .replace(/\r\n/g, '\n');

    const presenceHandler = deviceLinkHost.indexOf('client.onPresenceChanged');
    const applyPresenceName = deviceLinkHost.indexOf(
      'applyControllerDisplayNamePresence({',
      presenceHandler,
    );
    expect(presenceHandler).toBeGreaterThanOrEqual(0);
    expect(applyPresenceName).toBeGreaterThan(presenceHandler);

    // guard 不写缓存时，dispatch 继续按「数据库名 → 自报名 → 短 ID」回退。
    expect(dispatch).toContain(
      'return controllerDisplayNameByDevice.get(deviceId)\n    ?? normalizedReportedName\n    ?? reportedControllerNameByDevice.get(deviceId);',
    );
    expect(dispatch).toContain(
      'const displayName = normalized\n    ?? reportedControllerNameByDevice.get(deviceId)\n    ?? deviceId.slice(0, 8);',
    );
  });

  it('keeps device-link:voice:credential-sync matched but rejected (feature removed, readable error for old mobile)', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_CREDENTIAL_SYNC_CHANNEL');
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_CREDENTIAL_SYNC_CHANNEL)');
    expect(dispatch).toContain("code: 'VOICE_CREDENTIAL_SYNC_REMOVED'");
    expect(dispatch).not.toContain('syncMobileVoiceCredential');
  });

  it('routes device-link:voice:dictionary-learning to desktop dictionary learning', () => {
    const dispatch = readFileSync(resolve(mainRoot, 'device-link/dispatch.ts'), 'utf8');

    expect(dispatch).toContain('DL_VOICE_DICTIONARY_LEARNING_CHANNEL');
    expect(dispatch).toContain("import { adviseAndRecordVoiceInputDictionaryLearning } from '../voice-input/index.js';");
    expect(dispatch).toContain('if (payload.channel === DL_VOICE_DICTIONARY_LEARNING_CHANNEL)');
    expect(dispatch).toContain('handleMobileVoiceDictionaryLearning(src, (payload.args ?? [])[0])');
  });
});
