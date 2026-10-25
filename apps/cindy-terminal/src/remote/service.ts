import { CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1 } from '@cindy/device-link';
import { createHash } from 'node:crypto';
import { assertBackgroundLinkAccepted } from '@cindy/app-runtime/backgroundLink';
import { createTransportTimeoutReopenLoop, shouldAbortTransportTimeoutReopen } from '@cindy/app-runtime/transportTimeoutReopen';
import { createResponsivenessTracker, isDeviceResponsivenessProbeEligible, OPEN_LINK_OBSERVATION_CHANNEL } from '@cindy/app-runtime/responsivenessTracker';
import { invokeWithClosedLinkRecovery } from '@cindy/app-runtime/linkRecovery';
import { DEVICE_LINK_PUSH } from '@cindy/remote-agent/shared/deviceLinkIpc';
import { createMobileNotificationSender } from '@cindy/app-runtime/mobileNotificationSender';
import {
  DeviceLinkClient, DeviceLinkError, PROTOCOL_VERSION, REMOTE_INVOKE_ALLOWLIST,
  PUSH_FORWARD_ALLOWLIST, DL_SUBSCRIBE_CHANNEL, DL_UNSUBSCRIBE_CHANNEL,
  DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1,
  DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
  CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1, MAKER_EVENT_BATCH_CHANNEL,
  computeAllowlistHash, expandMakerEventBatchPayload, probeSharedTaskHost,
  parseProviderSharePeer, parseSharedTaskPeer, resolveRemoteInvokeTimeoutMs,
  topicForPush, SESSION_ACTIVITY_CHANNEL,
  type DeviceLinkStatus, type DeviceView, type Envelope, type InvokePayload, type InvokeResultPayload,
  type LinkAcceptPayload, type LinkOpenPayload, type PresenceSnapshot, type PushOwnerStamp,
  type Topic,
} from '@cindy/device-link';
import { directoryUrl, readDeviceDirectory } from './directory.js';
import {
  TerminalRemoteError, type TerminalDeviceServiceOptions, type TerminalPeerIdentity,
  type TerminalRemoteContext, type TerminalScopedAuthority,
} from './types.js';

type Guard = () => void;
type Inbound = { controllerCapabilities: readonly string[]; source: TerminalPeerIdentity; topics: Set<Topic>; legacy: boolean; active: boolean; modern: boolean };
type Outbound = {
  id: string; topics: Map<Topic, number>; wanted: boolean; revision: number;
  opening?: Promise<LinkAcceptPayload>; accepted?: LinkAcceptPayload;
};
type Invocation = {
  fingerprint: string;
  peer: string; context: TerminalRemoteContext; abort: AbortController;
  completed: boolean; result?: InvokeResultPayload; bytes: number;
  delivered: boolean; expiresAt: number;
};

const MAX_INBOUND = 128;
const MAX_COMPLETED = 4096;
const MAX_REPLY_BYTES = 32 * 1024 * 1024;
const REPLY_TTL_MS = 15 * 60_000;
const SHARED_TASK_METADATA = new Set(['local-db:sessions:created', 'local-db:sessions:patched', 'local-db:sessions:activity', 'local-db:session:error-persisted', 'usage:session-spend-changed', 'usage:session-tokens-changed']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

function identity(peerId: string): TerminalPeerIdentity {
  const task = parseSharedTaskPeer(peerId);
  if (task) return { kind: 'shared-task', peerId, deviceId: task.deviceId, sharedTaskId: task.sharedTaskId,
    role: task.role, ...(task.role === 'guest' ? { memberId: task.memberId } : {}) };
  const share = parseProviderSharePeer(peerId);
  if (share) return { kind: 'provider-share', peerId, deviceId: share.deviceId, shareId: share.shareId,
    role: share.role, ...(share.role === 'guest' ? { memberId: share.memberId } : {}) };
  if (!peerId || peerId.length > 128 || /[\s\x00-\x1f]/.test(peerId)) {
    throw new TerminalRemoteError('INVALID_PARAMS', 'Invalid remote device');
  }
  return { kind: 'owner', peerId, deviceId: peerId };
}

function topicsOf(value: unknown): Topic[] {
  if (!Array.isArray(value) || value.length > 256) {
    throw new TerminalRemoteError('INVALID_PARAMS', 'Invalid subscription topics');
  }
  const topics = value.filter((topic): topic is Topic => typeof topic === 'string'
    && (topic === 'sessions' || /^(session|fs-watch):[^\x00-\x1f]+$/.test(topic))
    && topic.length <= 8192);
  if (topics.length !== value.length) throw new TerminalRemoteError('INVALID_PARAMS', 'Invalid subscription topic');
  return [...new Set(topics)];
}

function capabilities(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string'
    && item.length > 0 && item.length <= 160).slice(0, 100))];
}

function failed(error: unknown): InvokeResultPayload {
  if (error instanceof TerminalRemoteError) return { ok: false, error: {
    code: 'IPC_ERROR', message: `[${error.code}] ${error.message}`,
  } };
  if (error instanceof DeviceLinkError) return { ok: false, error: { code: error.code, message: error.code } };
  // Neither thrown stack traces nor native file paths or credentials go over the wire.
  return { ok: false, error: { code: 'IPC_ERROR', message: '[INTERNAL] Remote operation failed' } };
}

/** Bidirectional authenticated device-link endpoint with no Electron dependency.
 * This owns transport and subscriptions; business services own command semantics.
 * Closing a UI subscription never terminates the runtime or a task. */
export class TerminalDeviceService {
  readonly client: DeviceLinkClient;
  readonly notifications: ReturnType<typeof createMobileNotificationSender>;
  private running = false;
  private generation = 0;
  private ownerScope: string | null = null;
  private readonly inbound = new Map<string, Inbound>();
  private readonly outbound = new Map<string, Outbound>();
  private readonly invocations = new Map<string, Invocation>();
  private readonly subscriptionQueues = new Map<string, Promise<unknown>>();
  private readonly presence = new Map<string, PresenceSnapshot>();
  private readonly statusListeners = new Set<(status: DeviceLinkStatus) => void>();
  private readonly presenceListeners = new Set<(device: PresenceSnapshot) => void>();
  private directoryReader?: () => Promise<DeviceView[]>;
  private readonly recovery;
  private readonly responsiveness;
  private readonly pendingOutbound = new Map<string, Set<symbol>>();
  private readonly revokedByRemote = new Set<string>();
  private probeTimer?: ReturnType<typeof setInterval>;

  constructor(private readonly options: TerminalDeviceServiceOptions) {
    this.client = new DeviceLinkClient({
      getToken: async () => {
        if (!this.current()) return null;
        const check = this.guard();
        const token = await options.getToken();
        try { check(); return token; } catch { return null; }
      },
      getHello: () => options.getHello(), getWsUrl: options.getWsUrl,
      authorizationScheme: options.authorizationScheme,
      createWebSocket: options.createWebSocket, logger: options.logger,
      directRuntime: options.directRuntime, transferCodec: options.transferCodec,
      timing: options.timing, peerResetReadRetry: true,
    });
    this.notifications = createMobileNotificationSender({
      getClient: () => this.current() ? this.client : null, getGeneration: () => this.generation,
      getControllersForTopic: topic => [...this.inbound.values()].filter(entry => entry.active && entry.source.kind === 'owner' && entry.topics.has(topic as Topic)),
      getSessionNotificationBody: kind => options.notificationBody?.(kind) ?? kind,
      log: { debug: message => options.logger?.debug(message) },
    });
    this.recovery = createTransportTimeoutReopenLoop({
      shouldAbort: id => shouldAbortTransportTimeoutReopen({ clientOnline: this.client.getStatus() === 'online', isOwner: this.current(),
        controlDisabledLocally: options.isControlTargetDisabled?.(id) === true || this.revokedByRemote.has(id),
        hasOutboundControlIntent: this.outbound.get(id)?.wanted === true && (Boolean(this.outbound.get(id)?.topics.size) || Boolean(this.pendingOutbound.get(id)?.size)) }),
      reopen: id => this.connect(id),
      onReset: deviceId => options.onLocalPush?.(DEVICE_LINK_PUSH.PEER_LINK_RESET, { deviceId }),
      onReopened: deviceId => options.onLocalPush?.(DEVICE_LINK_PUSH.PEER_LINK_REOPENED, { deviceId }),
      log: { info: message => options.logger?.info(message), warn: message => options.logger?.warn(message) },
    });
    this.responsiveness = createResponsivenessTracker({
      probeInvoke: async (id, channel, args) => {
        const check = this.guard();
        const target = this.outbound.get(id), revision = target?.revision;
        const current = () => { check();
          if (this.revokedByRemote.has(id) || options.isControlTargetDisabled?.(id)) throw new DeviceLinkError('ACCESS_REVOKED', 'Device probe access changed');
          if (this.outbound.get(id) !== target || target?.revision !== revision) throw new DeviceLinkError('NOT_CONNECTED', 'Device probe superseded');
        };
        const open = async () => { current(); await this.connect(id, { observed: false, replaySubscriptions: false }); current(); };
        const invoke = (probeChannel: string, probeArgs: unknown[]) => { current(); return this.client.invoke(id, { channel: probeChannel, args: probeArgs }, resolveRemoteInvokeTimeoutMs(probeChannel, probeArgs), { preSend: current }); };
        if (parseSharedTaskPeer(id)) return probeSharedTaskHost(id, {
          isCurrent: () => { try { current(); return true; } catch { return false; } },
          get: async task => { if (!options.readSharedTaskForProbe) throw new DeviceLinkError('ACCESS_REVOKED', 'Shared task unavailable'); return options.readSharedTaskForProbe(task); },
          openLink: open, invoke,
        });
        await open(); return invoke(channel, args);
      },
      isProbeEligible: id => isDeviceResponsivenessProbeEligible({ relayOnline: this.client.getStatus() === 'online', ownsRelay: this.current(),
        presenceAvailable: this.presence.get(identity(id).deviceId)?.online, revoked: this.revokedByRemote.has(id), locallyDisabled: options.isControlTargetDisabled?.(id) === true }),
      recoverLink: async id => {
        if (this.revokedByRemote.has(id) || options.isControlTargetDisabled?.(id)) throw new DeviceLinkError('ACCESS_REVOKED', 'Device recovery access changed');
        const entry = this.outbound.get(id); if (entry) entry.accepted = undefined;
        return this.connect(id, { observed: false, replaySubscriptions: false });
      },
      onUnresponsiveChanged: (deviceId, unresponsive, recovered) => {
        options.onLocalPush?.(DEVICE_LINK_PUSH.RESPONSIVENESS_CHANGED, { deviceId, unresponsive, recovered });
        const entry = this.outbound.get(deviceId);
        if (recovered && this.current() && entry?.wanted) { entry.accepted = undefined; this.scheduleRecovery(entry); }
      },
    });
    this.client.onFrame((envelope) => {
      // Register the request synchronously before yielding, then return so a slow
      // business operation cannot block transport ACKs, stop, or steering.
      if (!this.current()) return;
      try { options.onEnvelope?.(envelope); } catch { options.logger?.warn('Remote observer failed'); }
      if (envelope.kind === 'invoke') this.receiveInvoke(envelope);
      else void this.receiveControl(envelope).catch(() => options.logger?.warn('Remote control frame rejected'));
    });
    this.client.onStatusChange((status) => {
      if (status !== 'online') {
        this.recovery.dispose();
        for (const entry of this.inbound.values()) entry.active = false;
        for (const entry of this.outbound.values()) entry.accepted = undefined;
      } else if (this.current()) {
        for (const entry of this.outbound.values()) if (entry.wanted) this.scheduleRecovery(entry);
      }
      for (const listener of this.statusListeners) {
        try { listener(status); } catch { options.logger?.warn('Remote observer failed'); }
      }
    });
    this.client.onPresenceChanged((snapshot) => {
      if (!this.current()) return;
      this.presence.set(snapshot.deviceId, snapshot);
      if (!snapshot.online) this.responsiveness.clearDevice(snapshot.deviceId);
      for (const listener of this.presenceListeners) {
        try { listener(snapshot); } catch { options.logger?.warn('Remote observer failed'); }
      }
      const entry = this.outbound.get(snapshot.deviceId);
      // Presence loss can mean the remote process exited. Its old handshake is
      // no longer evidence that the next process knows our reliable stream or
      // subscriptions. Keep recovery intent and the shared relay intact; the
      // existing link-open handshake reconciles transport state on return.
      if (!snapshot.online && entry) entry.accepted = undefined;
      if (snapshot.online && entry?.wanted) this.scheduleRecovery(entry);
    });
    this.client.onPeerTransportReset(({ deviceId }) => {
      const entry = this.outbound.get(deviceId);
      if (entry?.wanted) this.scheduleRecovery(entry);
    });
    this.client.onReliableFrameBeforeLink((peer) => {
      const entry = this.outbound.get(peer);
      if (!entry?.wanted) return false;
      this.scheduleRecovery(entry);
      return true;
    });
  }

  start(): void {
    if (this.running) { this.guard()(); return; }
    const scope = this.options.getOwnerScope();
    if (!scope) throw new TerminalRemoteError('AUTH_REQUIRED', 'Sign in before starting remote connections');
    this.ownerScope = scope;
    this.running = true;
    this.generation++;
    this.client.start();
    this.probeTimer = setInterval(() => { if (this.current()) this.responsiveness.probeTick(); }, 5_000);
    this.probeTimer.unref();
  }

  stop(): void {
    if (!this.running) return;
    // Revoke local state before closing the socket: late completions cannot be
    // delivered into a new account even if the underlying task ignores abort.
    this.running = false;
    this.generation++;
    for (const invocation of this.invocations.values()) invocation.abort.abort();
    clearInterval(this.probeTimer); this.recovery.dispose(); this.responsiveness.resetAll();
    this.pendingOutbound.clear(); this.revokedByRemote.clear();
    for (const entry of this.inbound.values()) { this.peerClosed(entry.source.peerId, false); this.closeSubscriptionResources(entry.source); }
    this.inbound.clear(); this.outbound.clear(); this.invocations.clear(); this.presence.clear(); this.subscriptionQueues.clear();
    this.client.stop();
    this.ownerScope = null;
  }

  getStatus(): DeviceLinkStatus { return this.client.getStatus(); }
  getNotificationGeneration(): number { return this.generation; }
  getSelfDeviceId(): string | null { return this.current() ? this.client.getSelfDeviceId() : null; }
  getConnectionIssue() { return this.client.getConnectionIssue(); }
  onStatusChange(listener: (status: DeviceLinkStatus) => void): () => void {
    this.statusListeners.add(listener); return () => this.statusListeners.delete(listener);
  }
  onPresenceChanged(listener: (device: PresenceSnapshot) => void): () => void {
    this.presenceListeners.add(listener); return () => this.presenceListeners.delete(listener);
  }
  notifyNetworkChanged(): void { if (this.current()) this.client.notifyNetworkChanged({ urgent: true }); }
  refreshPresence(): void { this.guard()(); this.client.sendPresence(this.options.getHello()); }
  configureDirectoryReader(read: () => Promise<DeviceView[]>) { this.directoryReader = read; }
  directoryPresence() { return this.presence; }
  directoryPeerAvailable(id: string) {
    const entry = this.outbound.get(id);
    if (entry?.wanted) this.scheduleRecovery(entry);
  }
  getUnresponsiveDeviceIds() { return this.responsiveness.getUnresponsiveDeviceIds(); }
  clearDeviceResponsiveness(id: string) { this.responsiveness.clearDevice(id); }
  activeControllers() {
    return [...this.inbound.values()].filter(entry => entry.active && entry.source.kind === 'owner' && (entry.legacy || entry.topics.size > 0))
      .map(entry => ({ deviceId: entry.source.deviceId, name: this.presence.get(entry.source.deviceId)?.deviceName || entry.source.deviceId.slice(0, 8) }));
  }
  disconnectControllers() {
    for (const entry of [...this.inbound.values()]) if (entry.source.kind === 'owner') this.revoke(entry.source.peerId, 'user');
  }

  async sourceDevice(deviceId:string):Promise<import('@cindy/maker-shared/message-source').MessageSourceDevice|undefined> {
    const check=this.guard();check();
    if(!this.presence.has(deviceId))await this.listDevices().catch(()=>undefined);
    check();const device=this.presence.get(deviceId);if(!device)return;
    const platform=['ios','android','mobile'].includes(device.platform.toLowerCase())?'mobile':['darwin','macos','windows','win32','linux','desktop'].includes(device.platform.toLowerCase())?'desktop':undefined;
    if(!platform)return;
    return {deviceId,platform,...(device.deviceName?{name:device.deviceName}:{})};
  }

  async listDevices(): Promise<DeviceView[]> {
    if (this.directoryReader) return this.directoryReader();
    const devices = readDeviceDirectory(await this.requestDevicesApi('/api/device-link/devices'));
    this.presence.clear();
    for (const device of devices) this.presence.set(device.deviceId, {
      ...device, deviceName: device.name, platform: device.platform ?? '', appVersion: device.appVersion ?? '',
      lastSeenAt: device.lastSeenAt === null ? 0 : Date.parse(device.lastSeenAt),
    });
    return devices;
  }

  /** Same authenticated management endpoint as Desktop, fenced to this owner. */
  async requestDevicesApi<T>(route: string, options?: { method?: string; body?: unknown }): Promise<T> {
    const check = this.guard(); check();
    if (this.options.authorizationScheme === 'ProviderShareGuest') {
      throw new TerminalRemoteError('CHANNEL_NOT_ALLOWED', 'Shared-provider credentials cannot list account devices');
    }
    const endpoint = new URL(this.options.getDevicesUrl?.() ?? directoryUrl(this.options.getWsUrl()));
    if (!/^\/api\/device-link\/devices(?:\/[^/?#]+)?$/.test(route)) throw new TerminalRemoteError('INVALID_PARAMS', 'Invalid device management request');
    endpoint.pathname += route.slice('/api/device-link/devices'.length);
    if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password) {
      throw new TerminalRemoteError('INVALID_ENDPOINT', 'Invalid device directory endpoint');
    }
    const token = await this.options.getToken(); check();
    if (!token) throw new TerminalRemoteError('AUTH_REQUIRED', 'Sign in to list devices');
    const response = await (this.options.fetch ?? fetch)(endpoint, {
      method: options?.method ?? 'GET',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      ...(options?.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      redirect: 'error', signal: AbortSignal.timeout(15_000),
    });
    check();
    if (!response.ok) throw new TerminalRemoteError(({ 401: 'AUTH_REQUIRED', 404: 'NOT_FOUND', 409: 'ALREADY_EXISTS', 400: 'INVALID_PARAMS' } as Record<number, string>)[response.status] ?? 'DEVICE_LINK_UNAVAILABLE', 'Device management request failed');
    const value = await response.json() as T; check(); return value;
  }

  async connect(peerId: string, options?: { observed?: boolean; replaySubscriptions?: boolean }): Promise<LinkAcceptPayload> {
    identity(peerId);
    const check = this.guard(); check();
    if (this.options.isControlTargetDisabled?.(peerId)) throw new TerminalRemoteError('DEVICE_LINK_CONTROL_DISABLED', 'Device control is disabled locally');
    if (peerId === this.client.getSelfDeviceId()) throw new TerminalRemoteError('INVALID_PARAMS', 'Cannot connect a device to itself');
    let entry = this.outbound.get(peerId);
    if (!entry) {
      entry = { id: peerId, topics: new Map(), wanted: true, revision: 0 };
      this.outbound.set(peerId, entry);
    }
    entry.wanted = true;
    if (entry.opening) return entry.opening;
    if (entry.accepted && this.client.isLinkReady(peerId)) return entry.accepted;
    const target = entry;
    const revision = target.revision;
    const assertTarget = () => {
      check();
      if (this.outbound.get(peerId) !== target || !target.wanted || target.revision !== revision) {
        throw new TerminalRemoteError('LINK_NOT_OPEN', 'Remote connection was closed');
      }
      if (this.options.isControlTargetDisabled?.(peerId)) throw new TerminalRemoteError('DEVICE_LINK_CONTROL_DISABLED', 'Device control is disabled locally');
    };
    const open = async () => {
      await this.client.waitUntilOnline(); assertTarget();
      const hello = this.options.getHello();
      const accepted = await this.client.openLink(peerId, {
        controllerName: hello.deviceName, protocolVersion: PROTOCOL_VERSION, appVersion: hello.appVersion,
        capabilities: this.controllerCapabilities(),
      } satisfies LinkOpenPayload);
      assertTarget();
      target.accepted = accepted; this.revokedByRemote.delete(peerId);
      if (options?.replaySubscriptions !== false && target.topics.size) await this.sendSubscriptions(target, [...target.topics.keys()], true, assertTarget);
      assertTarget();
      return accepted;
    };
    target.opening = (options?.observed === false ? open() : this.responsiveness.guardInvoke(peerId, OPEN_LINK_OBSERVATION_CHANNEL, open))
      .finally(() => { if (this.outbound.get(peerId) === target) target.opening = undefined; });
    return target.opening;
  }

  /** Deliberate disconnect revokes all local subscriptions and recovery intent. */
  disconnect(peerId: string): void {
    const entry = this.outbound.get(peerId);
    this.recovery.cancel(peerId); this.responsiveness.clearDevice(peerId);
    if (entry) { entry.wanted = false; entry.revision++; this.outbound.delete(peerId); }
    this.client.closeLink(peerId, 'user', 'outbound');
  }

  /** Called after persisted revocation changes, without restarting other peers. */
  revoke(peerId: string, reason: 'revoked' | 'user' = 'revoked'): void {
    this.peerClosed(peerId, false);
    const entry = this.inbound.get(peerId);
    if (entry) this.closeSubscriptionResources(entry.source);
    this.inbound.delete(peerId);
    for (const invocation of this.invocations.values()) if (invocation.peer === peerId) invocation.abort.abort();
    this.client.closeLink(peerId, reason, 'inbound');
    // A permanent close makes the peer retire its shared reliable stream. Keep
    // our reverse-control intent/pending traffic, but negotiate again before a
    // new outbound call; its previous accept no longer describes the peer.
    const outbound = this.outbound.get(peerId);
    if (outbound) outbound.accepted = undefined;
  }

  /** File/attachment data-channel RPC must re-enter the same authorization
   * boundary as relay RPC, using its captured authenticated connection context. */
  async dispatchLocal(channel: string, args: unknown[], context: TerminalRemoteContext): Promise<unknown> {
    context.assertCurrent();
    if (!REMOTE_INVOKE_ALLOWLIST.has(channel)) throw new TerminalRemoteError('CHANNEL_NOT_ALLOWED', 'Remote channel is not allowed');
    await this.authorize(context.source, channel); context.assertCurrent();
    const result = await this.options.invokeLocal(channel, args, context);
    context.assertCurrent();
    return result;
  }

  async invoke(peerId: string, channel: string, args: unknown[] = [], options?: { background?: boolean; preSend?: () => void }): Promise<unknown> {
    const result=await this.invokeResult(peerId,channel,args,options);
    if(!result.ok)throw new TerminalRemoteError(result.error.code,result.error.message);
    return result.result;
  }
  /** Original helper adapters need the response envelope and transport errors
   * separately to distinguish a rejected write from an unknown outcome. */
  async invokeResult(peerId: string, channel: string, args: unknown[] = [], options?: { background?: boolean; preSend?: () => void }): Promise<InvokeResultPayload> {
    const calls = this.pendingOutbound.get(peerId) ?? new Set<symbol>();
    const call = Symbol(); calls.add(call); this.pendingOutbound.set(peerId, calls);
    try {
      const result = await this.responsiveness.guardInvoke(peerId, channel, () => this.invokeCore(peerId, channel, args, options));
      return result;
    }
    finally { calls.delete(call); if (!calls.size && this.pendingOutbound.get(peerId) === calls) this.pendingOutbound.delete(peerId); }
  }
  private async invokeCore(peerId: string, channel: string, args: unknown[], options?: { background?: boolean; preSend?: () => void }): Promise<InvokeResultPayload> {
    if (!REMOTE_INVOKE_ALLOWLIST.has(channel)) throw new TerminalRemoteError('CHANNEL_NOT_ALLOWED', 'Remote channel is not allowed');
    if (!Array.isArray(args)) throw new TerminalRemoteError('INVALID_PARAMS', 'Remote arguments must be an array');
    const check = this.guard(); check();
    options?.preSend?.();
    const accepted = await this.connect(peerId, { observed: false }); check();
    const assertBackground = () => { if (options?.background) assertBackgroundLinkAccepted(this.outbound.get(peerId)?.accepted ?? accepted, { hasOutboundSubscriptions: () => Boolean(this.outbound.get(peerId)?.topics.size), closeLink: () => this.disconnect(peerId) }); };
    assertBackground();
    const entry = this.outbound.get(peerId)!;
    const revision = entry.revision;
    const beforeSend = () => {
      check();
      options?.preSend?.(); assertBackground();
      if (this.outbound.get(peerId) !== entry || !entry.wanted || entry.revision !== revision) throw new TerminalRemoteError('LINK_NOT_OPEN', 'Remote connection was closed');
      if (this.options.isControlTargetDisabled?.(peerId)) throw new TerminalRemoteError('DEVICE_LINK_CONTROL_DISABLED', 'Device control is disabled locally');
    };
    const call = () => this.client.invoke(peerId, { channel, args }, resolveRemoteInvokeTimeoutMs(channel, args), { preSend: beforeSend, background: options?.background });
    const result = await invokeWithClosedLinkRecovery(call, async () => { beforeSend(); entry.accepted = undefined; await this.connect(peerId, { observed: false }); }, beforeSend);
    beforeSend();
    return result;
  }

  /** Refcounted subscription. Awaiting its disposer stops only this observer. */
  async subscribe(peerId: string, values: readonly Topic[]): Promise<() => Promise<void>> {
    const topics = topicsOf([...values]);
    const check = this.guard(); check();
    let entry = this.outbound.get(peerId);
    if (!entry) {
      identity(peerId);
      entry = { id: peerId, topics: new Map(), wanted: true, revision: 0 };
      this.outbound.set(peerId, entry);
    }
    const target = entry;
    for (const topic of topics) target.topics.set(topic, (target.topics.get(topic) ?? 0) + 1);
    let disposed = false;
    const dispose = async () => {
      if (disposed) return;
      disposed = true;
      if (this.outbound.get(peerId) !== target) return;
      const removed: Topic[] = [];
      for (const topic of topics) {
        const count = target.topics.get(topic) ?? 0;
        if (count <= 1) { target.topics.delete(topic); removed.push(topic); }
        else target.topics.set(topic, count - 1);
      }
      if (removed.length && this.current() && this.client.isLinkReady(peerId)) {
        await this.sendSubscriptions(target, removed, false, check);
      }
    };
    try {
      await this.connect(peerId); check();
      await this.sendSubscriptions(target, topics, true, check);
      return dispose;
    } catch (error) { await dispose().catch(() => {}); throw error; }
  }

  /** Host event fanout is scoped by authoritative subscriptions, never args. */
  async publish(channel: string, payload: unknown, ownerStamp?: PushOwnerStamp, targetPeerId?: string): Promise<void> {
    const check = this.guard(); check();
    if (!PUSH_FORWARD_ALLOWLIST.has(channel) && !this.options.extraPushChannels?.has(channel)) return;
    const regularTopic = topicForPush(channel, payload);
    for (const [peer, entry] of this.inbound) {
      if (targetPeerId !== undefined && peer !== targetPeerId) continue;
      const sessionId = record(payload) && typeof payload.sessionId === 'string' ? payload.sessionId : null;
      const topic: Topic | null = entry.source.kind === 'shared-task' && SHARED_TASK_METADATA.has(channel) && sessionId
        ? `session:${sessionId}` : regularTopic;
      if (!entry.active || (!entry.legacy && (!topic || !entry.topics.has(topic)))) continue;
      try {
        const authority = await this.authorize(entry.source, undefined, topic ?? undefined); check();
        if (authority && (!authority.allowedPushChannels?.has(channel) || authority.acceptsPush?.(channel, payload) === false)) continue;
        if (this.inbound.get(peer) !== entry || !entry.active
          || (!entry.legacy && (!topic || !entry.topics.has(topic)))) continue;
        this.client.sendPush(peer, channel, payload, ownerStamp);
      } catch { this.options.logger?.debug('Remote push withheld'); }
    }
  }

  private current(): boolean {
    return this.running && this.ownerScope !== null && this.options.getOwnerScope() === this.ownerScope;
  }
  private guard(): Guard {
    const generation = this.generation, scope = this.ownerScope;
    return () => {
      if (!this.current() || generation !== this.generation || scope !== this.ownerScope) {
        throw new TerminalRemoteError('OWNER_CHANGED', 'Remote account changed');
      }
    };
  }
  private controllerCapabilities(): string[] {
    return capabilities([
      DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, DEVICE_LINK_CAPABILITY_TRANSPORT_TIMEOUT_CLOSE,
      CONTROLLER_CAPABILITY_MAKER_EVENT_BATCH_V1, CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1, ...this.options.controllerCapabilities ?? [],
    ]);
  }
  private async authorize(source: TerminalPeerIdentity, channel?: string, topic?: Topic): Promise<TerminalScopedAuthority | null> {
    const check = this.guard(); check();
    if (this.options.isPeerRevoked?.(source.deviceId)) throw new TerminalRemoteError('ACCESS_REVOKED', 'Remote device access was revoked');
    if (source.kind === 'owner') {
      if (!this.options.getHello().remoteControlEnabled) throw new DeviceLinkError('REMOTE_DISABLED', 'Remote control disabled');
      return null;
    }
    const authority = await this.options.resolveScopedAuthority?.(source); check();
    if (!authority) throw new TerminalRemoteError('ACCESS_REVOKED', 'Remote membership is not active');
    authority.assertCurrent();
    if (channel && !authority.allowedChannels.has(channel)) throw new TerminalRemoteError('CHANNEL_NOT_ALLOWED', 'Channel not permitted in this membership');
    if (topic && !authority.allowedTopics.has(topic)) throw new TerminalRemoteError('ACCESS_REVOKED', 'Topic not permitted in this membership');
    return authority;
  }

  private context(source: TerminalPeerIdentity, requestId: string, abort: AbortController,
    authority?: TerminalScopedAuthority | null): TerminalRemoteContext {
    const check = this.guard();
    return Object.freeze({ source: Object.freeze(source), controllerDeviceId: source.peerId,
      sourceDeviceId: source.deviceId, controllerCapabilities: Object.freeze([...(this.inbound.get(source.peerId)?.controllerCapabilities??[])]), requestId, ownerScope: this.ownerScope!, signal: abort.signal,
      assertCurrent: () => {
        check();
        if (abort.signal.aborted || this.options.isPeerRevoked?.(source.deviceId)) throw new TerminalRemoteError('ACCESS_REVOKED', 'Remote request expired');
        if (source.kind === 'owner' && !this.options.getHello().remoteControlEnabled) throw new DeviceLinkError('REMOTE_DISABLED', 'Remote control disabled');
        authority?.assertCurrent();
      },
    });
  }

  private async receiveControl(env: Envelope): Promise<void> {
    if (!env.src) return;
    const source = identity(env.src);
    if (env.kind === 'link-open' && env.id) {
      if (!record(env.payload) || env.payload.protocolVersion !== PROTOCOL_VERSION) return;
      const check = this.guard();
      try { await this.authorize(source); check(); }
      catch { this.revoke(source.peerId); return; }
      const modern = capabilities(env.payload.capabilities).includes(DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1);
      const previous = this.inbound.get(source.peerId);
      const entry: Inbound = { source, active: true, controllerCapabilities: capabilities(env.payload.capabilities), topics: previous?.topics ?? new Set(),
        modern: modern || previous?.modern === true,
        legacy: source.kind === 'owner' && !modern && !previous?.modern };
      this.client.sendLinkAccept(source.peerId, env.id, { appVersion: this.options.getHello().appVersion,
        allowlistHash: computeAllowlistHash(), capabilities: capabilities([
          DEVICE_LINK_CAPABILITY_BACKGROUND_LINK_V1, ...this.options.hostCapabilities ?? [],
        ]) });
      this.inbound.set(source.peerId, entry);
      for (const invocation of this.invocations.values()) if (invocation.peer === source.peerId && invocation.completed && !invocation.delivered) void this.deliver(invocation, env.id);
    } else if (env.kind === 'link-close') {
      this.peerClosed(source.peerId, (env.payload as { reason?: unknown })?.reason === 'transport-timeout');
      if ((env.payload as { reason?: unknown })?.reason === 'transport-timeout') {
        const entry = this.outbound.get(source.peerId);
        if (entry?.wanted) { entry.accepted = undefined; this.scheduleRecovery(entry); }
      } else {
        const inbound = this.inbound.get(source.peerId);
        if (inbound) this.closeSubscriptionResources(inbound.source);
        this.inbound.delete(source.peerId);
        for (const invocation of this.invocations.values()) if (invocation.peer === source.peerId) invocation.abort.abort();
        // A remote permanent close is not permission to silently reopen it.
        const entry = this.outbound.get(source.peerId);
        this.recovery.cancel(source.peerId); this.responsiveness.clearDevice(source.peerId);
        if ((env.payload as { reason?: unknown })?.reason === 'revoked') this.revokedByRemote.add(source.peerId);
        if (entry) { entry.wanted = false; entry.accepted = undefined; entry.revision++; }
      }
    } else if (env.kind === 'push') {
      const entry = this.outbound.get(source.peerId);
      if (!entry?.wanted || !entry.accepted || !record(env.payload) || typeof env.payload.channel !== 'string') return;
      if (this.options.isControlTargetDisabled?.(source.peerId)) return;
      const { channel, payload, ownerStamp } = env.payload;
      if (!PUSH_FORWARD_ALLOWLIST.has(channel) && !this.options.extraPushChannels?.has(channel)) return;
      const topic = topicForPush(channel, payload);
      if (!topic || !entry.topics.has(topic)) return;
      const emit = (name: string, value: unknown) => this.options.onPush?.({ deviceId: source.peerId, source,
        channel: name, payload: value, ...(record(ownerStamp) ? { ownerStamp: ownerStamp as unknown as PushOwnerStamp } : {}) });
      if (channel === MAKER_EVENT_BATCH_CHANNEL) for (const event of expandMakerEventBatchPayload(payload)) emit('maker:event', event);
      else emit(channel, payload);
    }
  }

  private receiveInvoke(env: Envelope): void {
    if (!env.src || !env.id || !record(env.payload) || typeof env.payload.channel !== 'string' || !Array.isArray(env.payload.args)) return;
    const key = `${env.src}\0${env.id}`;
    const fingerprint = createHash('sha256').update(JSON.stringify(env.payload)).digest('hex');
    const existing = this.invocations.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        this.client.sendInvokeResult(env.src, env.id, failed(new TerminalRemoteError('INVALID_PARAMS', 'Request identifier was reused')));
      } else if (existing.completed) void this.deliver(existing, env.id);
      return;
    }
    this.trimReplies();
    if (this.invocations.size >= MAX_COMPLETED || [...this.invocations.values()].filter((call) => !call.completed).length >= MAX_INBOUND) {
      this.client.sendInvokeResult(env.src, env.id, { ok: false, error: { code: 'BACKPRESSURE', message: 'Remote host is busy' } }); return;
    }
    let source: TerminalPeerIdentity;
    try { source = identity(env.src); } catch { return; }
    const abort = new AbortController();
    const invocation: Invocation = { fingerprint, peer: env.src, context: this.context(source, env.id, abort), abort,
      completed: false, bytes: 0, delivered: false, expiresAt: Date.now() + REPLY_TTL_MS };
    this.invocations.set(key, invocation);
    const payload = env.payload as unknown as InvokePayload;
    void (async () => {
      try {
        if (!REMOTE_INVOKE_ALLOWLIST.has(payload.channel)) throw new TerminalRemoteError('CHANNEL_NOT_ALLOWED', 'Remote channel is not allowed');
        const authority = await this.authorize(source, payload.channel);
        invocation.context = this.context(source, env.id!, abort, authority); invocation.context.assertCurrent();
        const result = payload.channel === DL_SUBSCRIBE_CHANNEL || payload.channel === DL_UNSUBSCRIBE_CHANNEL
          ? await this.queueInboundSubscription(source, payload, invocation.context)
          : await this.options.invokeLocal(payload.channel, payload.args, invocation.context);
        invocation.context.assertCurrent();
        invocation.result = { ok: true, result };
      } catch (error) { invocation.result = failed(error); }
      invocation.completed = true;
      try { invocation.bytes = JSON.stringify(invocation.result).length * 2; }
      catch { invocation.result = failed(new TerminalRemoteError('INVALID_RESPONSE', 'Remote operation returned an invalid result')); }
      this.trimReplies();
      await this.deliver(invocation, env.id!);
    })().catch(() => this.options.logger?.warn('Remote invocation delivery failed'));
  }

  private async deliver(invocation: Invocation, requestId: string): Promise<void> {
    if (!this.current() || this.client.getStatus() !== 'online') return;
    try {
      const check = this.guard();
      let result = invocation.result ?? failed(new TerminalRemoteError('RESULT_EXPIRED', 'Remote result is no longer retained; check the operation state'));
      try {
        invocation.context.assertCurrent();
        await this.authorize(invocation.context.source); invocation.context.assertCurrent();
      } catch (error) {
        // An authorization failure must produce an answer, never expose an old
        // successful result and never turn a denied command into a timeout.
        if (error instanceof TerminalRemoteError && error.code === 'OWNER_CHANGED') return;
        check(); result = failed(error);
      }
      check();
      this.client.sendInvokeResult(invocation.peer, invocation.context.requestId || requestId,
        result);
      invocation.delivered = true;
    } catch { this.options.logger?.debug('Remote reply retained or withheld'); }
  }

  private closeSubscriptionResources(source: TerminalPeerIdentity): void {
    try { this.options.onSubscriptionsClosed?.(source); }
    catch { this.options.logger?.warn('Remote subscription cleanup failed'); }
  }
  private peerClosed(peer: string, transient: boolean): void {
    try { this.options.onPeerClosed?.(peer, transient); }
    catch { this.options.logger?.warn('Desktop peer cleanup failed'); }
  }

  private queueInboundSubscription(source: TerminalPeerIdentity, payload: InvokePayload,
    context: TerminalRemoteContext): Promise<{ ok: true }> {
    const previous = this.subscriptionQueues.get(source.peerId) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => {
      context.assertCurrent();
      return this.changeInboundSubscription(source, payload, context);
    });
    this.subscriptionQueues.set(source.peerId, operation);
    void operation.finally(() => {
      if (this.subscriptionQueues.get(source.peerId) === operation) this.subscriptionQueues.delete(source.peerId);
    }).catch(() => {});
    return operation;
  }

  private trimReplies(): void {
    let bytes = 0;
    for (const [key, call] of this.invocations) {
      if (call.completed && call.expiresAt < Date.now()) this.invocations.delete(key);
      else bytes += call.bytes;
    }
    for (const call of this.invocations.values()) {
      if (bytes <= MAX_REPLY_BYTES) break;
      if (!call.completed || !call.result) continue;
      bytes -= call.bytes; call.bytes = 0; call.result = undefined;
      // Keep its request-id tombstone so eviction cannot replay a write.
    }
  }

  private async changeInboundSubscription(source: TerminalPeerIdentity, payload: InvokePayload,
    context: TerminalRemoteContext): Promise<{ ok: true }> {
    if (source.kind === 'provider-share') throw new TerminalRemoteError('CHANNEL_NOT_ALLOWED', 'Provider shares do not subscribe to host data');
    const topics = topicsOf(record(payload.args[0]) ? payload.args[0].topics : undefined);
    for (const topic of topics) await this.authorize(source, payload.channel, topic);
    context.assertCurrent();
    const previous = this.inbound.get(source.peerId);
    const advertised = record(payload.args[0]) ? payload.args[0].capabilities : undefined;
    const entry: Inbound = { source, active: true, controllerCapabilities: advertised === undefined ? previous?.controllerCapabilities??[] : capabilities(advertised), topics: new Set(previous?.topics), modern: true, legacy: false };
    for (const topic of topics) {
      if (payload.channel === DL_SUBSCRIBE_CHANNEL) entry.topics.add(topic);
      else entry.topics.delete(topic);
    }
    if (previous?.modern && previous.active && previous.controllerCapabilities.length === entry.controllerCapabilities.length
      && previous.controllerCapabilities.every(capability => entry.controllerCapabilities.includes(capability)) && previous.topics.size === entry.topics.size
      && [...entry.topics].every(topic => previous.topics.has(topic))) return { ok: true };
    await this.options.onSubscriptionsChanged?.(source, [...entry.topics], context);
    context.assertCurrent();
    this.inbound.set(source.peerId, entry);
    if (source.kind === 'owner' && entry.topics.has('sessions') && !previous?.topics.has('sessions')) {
      this.options.replaySessionActivity?.(payload => {
        context.assertCurrent();
        void this.publish(SESSION_ACTIVITY_CHANNEL, payload, undefined, source.peerId)
          .catch(() => this.options.logger?.debug('Session activity replay withheld'));
      });
    }
    return { ok: true };
  }

  private async sendSubscriptions(entry: Outbound, topics: Topic[], subscribe: boolean, check: Guard): Promise<void> {
    check();
    if (this.outbound.get(entry.id) !== entry || !entry.wanted) return;
    const live = topics.filter((topic) => subscribe ? entry.topics.has(topic) : !entry.topics.has(topic));
    if (!live.length) return;
    const channel = subscribe ? DL_SUBSCRIBE_CHANNEL : DL_UNSUBSCRIBE_CHANNEL;
    const result = await this.responsiveness.guardInvoke(entry.id, channel, () => this.client.invoke(entry.id, { channel,
      args: [{ topics: live, controllerName: this.options.getHello().deviceName, capabilities: this.controllerCapabilities() }] }, undefined,
    { preSend: () => {
      check();
      if (this.outbound.get(entry.id) !== entry || !entry.wanted) throw new TerminalRemoteError('LINK_NOT_OPEN', 'Remote connection was closed');
    } }));
    check();
    if (!result.ok) throw new TerminalRemoteError(result.error.code, result.error.message);
  }

  private scheduleRecovery(entry: Outbound): void {
    if (this.current() && entry.wanted && this.outbound.get(entry.id) === entry) this.recovery.trigger(entry.id);
  }
}
