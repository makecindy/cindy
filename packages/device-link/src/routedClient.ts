/**
 * 主连接走自建中转时,跨账号 peer(共享任务 / 供应商分享)改走一条专用的官方连接。
 *
 * V1 自建中转只认一个账号,也不知道共享成员,所以旧跨账号帧经官方中转
 * (docs/self-hosted-relay-plan.md §7)。host 继续只面对一个 client:带 peer 的调用按 peer 路由,
 * 事件从两条连接汇总;官方线路下专用连接不启动,全部调用落回基类,行为不变。
 *
 * 已验证的 V2 分享按资源安装独立连接,优先于兼容线路,撤下后也不回落。
 * 各条连接的故障互不牵连:状态与连接问题只反映主连接;同账号 presence 取承载该设备的连接。
 * host 要看承载某个 peer 的连接时用 `connectionFor` / `crossAccountConnection`。
 */
import {
  DeviceLinkClient,
  type DeviceLinkClientOptions,
  type DeviceLinkConnectionIssue,
  type DeviceLinkPeerRouteStateChanged,
  type DeviceLinkPeerTransportReset,
  type DeviceLinkStatus,
  type InboundFrameHandler,
} from './client.js';
import type { DeviceLinkPeerLinkSnapshot } from './directPath.js';
import {
  isScopedPeer,
  parseSharedTaskPeer,
  parseProviderSharePeer,
  type InvokePayload,
  type InvokeResultPayload,
  type LinkAcceptPayload,
  type LinkClosePayload,
  type PresenceSetPayload,
  type PresenceSnapshot,
  type PushOwnerStamp,
  type Envelope,
} from './protocol.js';

export interface ScopedConnectionScope { kind: 'shared-task' | 'provider-share'; resourceId: string; }
interface ScopedConnection { connection: DeviceLinkClient; live: boolean; }
function scopedKey(peer: string): string | null {
  const task = parseSharedTaskPeer(peer);
  if (task) return 'shared-task:' + task.sharedTaskId;
  const provider = parseProviderSharePeer(peer);
  return provider ? 'provider-share:' + provider.shareId : null;
}

export interface CrossAccountConnectionOptions {
  /** 主连接这一轮是否走自建中转。 */
  active(): boolean;
  /** On the official V2 route, old scoped and ordinary peers share the one V1
   * socket. Opening two sockets with the same device identity would kick both. */
  useLegacyConnection?(): boolean;
  /** 官方连接的配置。设备签名与直连只属于自建中转的同账号链路,这里不接受。 */
  options: Omit<DeviceLinkClientOptions, 'scopedPeersOnly' | 'frameAuth' | 'directRuntime'>;
}

/** Optional compatibility path for peers which have not enabled the newer transport. */
export interface LegacyPeerConnectionOptions {
  active(): boolean;
  useForPeer(peer: string): boolean;
  /** Probe only the authenticated link handshake before selecting compatibility for a known newer peer. */
  probeForPeer?(peer: string): boolean;
  primaryCapability?: string;
  /** The host verifies the attestation in the base client before this classifier runs. */
  prefersPrimary?(payload: unknown): boolean;
  /**
   * After a probe found that the peer prefers the main connection, how to re-open it there. Absent: the main connection's own
   * link-open, as before. A host with its own channel to that peer (Agent-Net sessions) may open it there, and calls
   * `primary` otherwise.
   */
  openOnPrimary?(peer: string, payload: unknown, timeoutMs: number | undefined,
    primary: () => Promise<LinkAcceptPayload>): Promise<LinkAcceptPayload>;
  options: DeviceLinkClientOptions;
}

export class RoutedDeviceLinkClient extends DeviceLinkClient {
  private readonly crossAccount: DeviceLinkClient | null;
  private readonly crossAccountActive: () => boolean;
  private readonly crossAccountUsesLegacy: () => boolean;
  private crossAccountRunning = false;
  private started = false;
  private readonly legacy: DeviceLinkClient | null;
  private readonly legacyOptions?: LegacyPeerConnectionOptions;
  private legacyRunning = false;
  private readonly legacyRoutes = new Set<string>();
  private readonly legacyPrefersPrimary = new Set<string>();
  private readonly legacyReplies = new Set<string>();
  private readonly observedLegacyFrames = new WeakSet<Envelope>();
  private readonly blockedLegacyFrames = new WeakSet<Envelope>();
  private readonly scopedConnections = new Map<string, ScopedConnection>();
  private readonly scopedObservers = new Set<{ subscribe(connection: DeviceLinkClient): () => void; off: Map<DeviceLinkClient, () => void> }>();
  private readonly retiredScopedConnection: DeviceLinkClient;
  private primaryScopedPreference: () => boolean = () => false;

  constructor(options: DeviceLinkClientOptions, crossAccount?: CrossAccountConnectionOptions, legacy?: LegacyPeerConnectionOptions) {
    super(options);
    // A retired pin remains an explicit stopped destination. A transient loss
    // must never reroute private business data to an account-wide fallback.
    this.retiredScopedConnection = new DeviceLinkClient({ ...options, scopedPeersOnly: true });
    this.crossAccount = crossAccount
      ? new DeviceLinkClient({ ...crossAccount.options, scopedPeersOnly: true })
      : null;
    this.crossAccountActive = crossAccount ? () => crossAccount.active() : () => false;
    this.crossAccountUsesLegacy = crossAccount?.useLegacyConnection ? () => crossAccount.useLegacyConnection!() : () => false;
    this.legacyOptions = legacy;
    this.legacy = legacy ? new DeviceLinkClient(legacy.options) : null;
    // 账号作用域与中转设置可能在 start 之后才就绪,主连接每轮建连都按实际线路再核对一次;
    // 主连接连不上自建中转时,跨账号连接照常起来。中转移除本设备只停主连接,这里不跟着停。
    this.onStatusChange((status) => {
      if (status !== 'stopped') this.syncCrossAccount();
    });
    // 先于任何 host 订阅登记:快照在交给 host 之前已经记下。
    this.trackPresence(this, (cb) => super.onPresenceChanged(cb));
    if (this.legacy) {
      const legacy = this.legacy;
      this.trackPresence(legacy, (cb) => legacy.onPresenceChanged(cb));
    }
  }

  /** Installed only after the host verifies a resource's pinned network/root.
   * Resource identity remains independent from the currently selected relay.
   * Returning the disposer retires, rather than forgets, that routing decision. */
  registerScopedConnection(scope: ScopedConnectionScope, options: DeviceLinkClientOptions | DeviceLinkClient | 'primary' | 'blocked'): () => void {
    if (!['shared-task', 'provider-share'].includes(scope.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope.resourceId))
      throw new Error('INVALID_SCOPED_CONNECTION');
    const key = scope.kind + ':' + scope.resourceId;
    if (!this.scopedConnections.has(key) && this.scopedConnections.size >= 10_000) throw new Error('SCOPED_CONNECTION_LIMIT');
    const previous = this.scopedConnections.get(key);
    const connection = options === 'primary' ? this : options === 'blocked' ? this.retiredScopedConnection
      : options instanceof DeviceLinkClient ? options : new DeviceLinkClient({ ...options, scopedPeersOnly: true });
    const entry = { connection, live: options !== 'blocked' };
    this.scopedConnections.set(key, entry);
    if (previous?.connection !== connection) this.releaseScopedConnection(previous?.connection);
    if (connection !== this && entry.live) {
      for (const observer of this.scopedObservers) if (!observer.off.has(connection)) observer.off.set(connection, observer.subscribe(connection));
      if (this.started) connection.start();
    }
    return () => {
      if (this.scopedConnections.get(key) !== entry || !entry.live) return;
      entry.live = false;
      this.releaseScopedConnection(connection);
    };
  }

  private extraScopedConnections(): DeviceLinkClient[] {
    return [...new Set([...this.scopedConnections.values()].filter(entry => entry.live && entry.connection !== this).map(entry => entry.connection))];
  }
  override hasOnlineConnection(): boolean {
    return super.hasOnlineConnection() || !!this.crossAccount?.hasOnlineConnection() || !!this.legacy?.hasOnlineConnection()
      || this.extraScopedConnections().some(connection => connection.hasOnlineConnection());
  }

  private releaseScopedConnection(connection?: DeviceLinkClient): void {
    if (!connection || connection === this || this.extraScopedConnections().includes(connection)) return;
    connection.stop();
    for (const observer of this.scopedObservers) { observer.off.get(connection)?.(); observer.off.delete(connection); }
  }

  private acceptsScopedEvent(connection: DeviceLinkClient, peer: string): boolean {
    const key = scopedKey(peer), owner = key && this.scopedConnections.get(key);
    if (owner) return owner.live && owner.connection === connection;
    return !this.extraScopedConnections().includes(connection);
  }

  private syncCrossAccount(): void {
    const legacyActive = !!this.legacy && this.started && !!this.legacyOptions?.active();
    if (legacyActive !== this.legacyRunning) {
      this.legacyRunning = legacyActive;
      if (legacyActive) this.legacy?.start();
      else { this.legacy?.stop(); this.legacyRoutes.clear(); this.legacyPrefersPrimary.clear(); this.legacyReplies.clear(); }
    }
    const connection = this.crossAccount;
    if (!connection) return;
    const next = this.started && this.crossAccountActive() && !(this.legacyRunning && this.crossAccountUsesLegacy());
    if (next === this.crossAccountRunning) return;
    this.crossAccountRunning = next;
    if (next) connection.start();
    else connection.stop();
  }

  private routed(peer: string): DeviceLinkClient | null {
    const key = scopedKey(peer), scoped = key && this.scopedConnections.get(key);
    if (scoped) return !scoped.live ? this.retiredScopedConnection : scoped.connection === this ? null : scoped.connection;
    if (this.legacyRunning && this.crossAccountUsesLegacy() && isScopedPeer(peer)) return this.legacy;
    if (this.crossAccountRunning && isScopedPeer(peer)) return this.crossAccount;
    if (this.legacyRunning && !isScopedPeer(peer) && !this.legacyPrefersPrimary.has(peer)
      && (this.legacyRoutes.has(peer) || this.legacyOptions?.useForPeer(peer) || this.legacy?.hasPendingRequestsTo(peer))) return this.legacy;
    return null;
  }

  override connectionFor(peer: string): DeviceLinkClient {
    return this.routed(peer) ?? this;
  }

  /**
   * The compatibility connection while it runs (the newer transport is the main connection and older connections are
   * allowed); null otherwise. For what only it reaches, such as phones that never registered on the newer transport.
   */
  legacyConnection(): DeviceLinkClient | null {
    return this.legacyRunning ? this.legacy : null;
  }

  /**
   * The compatibility connection's own connection problems (a rejected token there, for example); the main connection's go to
   * onConnectionIssue. A host without a separate cross-account connection watches this, or a token rejected on the
   * compatibility connection is never refreshed and the devices only it reaches stay away (2026-11-17: Node Host).
   */
  onLegacyConnectionIssue(cb: (issue: DeviceLinkConnectionIssue | null) => void): () => void {
    return this.legacy?.onConnectionIssue(cb) ?? (() => undefined);
  }

  override crossAccountConnection(): DeviceLinkClient {
    if (this.primaryScopedPreference()) return this;
    if (this.legacyRunning && this.crossAccountUsesLegacy()) return this.legacy!;
    return (this.crossAccountRunning ? this.crossAccount : null) ?? this;
  }

  preferPrimaryScopedConnection(check: () => boolean): () => void {
    this.primaryScopedPreference = check;
    return () => { if (this.primaryScopedPreference === check) this.primaryScopedPreference = () => false; };
  }

  /** Includes connections registered after this observer; the source identifies
   * which peers need recovery without coupling independent resource relays. */
  onScopedConnectionStatus(cb: (connection: DeviceLinkClient, status: DeviceLinkStatus) => void): () => void {
    return this.both(super.onStatusChange(status => cb(this, status)),
      connection => connection.onStatusChange(status => cb(connection, status)));
  }

  override onSeparateCrossAccountStatus(cb: (status: DeviceLinkStatus) => void): () => void {
    const a = this.crossAccount?.onStatusChange(cb);
    const b = this.legacy?.onStatusChange(status => { if (this.crossAccountUsesLegacy()) cb(status); });
    return () => { a?.(); b?.(); };
  }

  override onSeparateCrossAccountIssue(cb: (issue: DeviceLinkConnectionIssue | null) => void): () => void {
    const a = this.crossAccount?.onConnectionIssue(cb);
    const b = this.legacy?.onConnectionIssue(issue => { if (this.crossAccountUsesLegacy()) cb(issue); });
    return () => { a?.(); b?.(); };
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  override start(): void {
    this.started = true;
    super.start();
    this.syncCrossAccount();
    for (const connection of this.extraScopedConnections()) connection.start();
  }

  override stop(options?: Parameters<DeviceLinkClient['stop']>[0]): void {
    this.started = false;
    super.stop(options);
    this.syncCrossAccount();
    for (const connection of this.extraScopedConnections()) connection.stop();
  }

  /** stop 之后 host 也可以用它重新拉起主连接(如回到前台)。 */
  override connectNow(reason?: string, opts?: Parameters<DeviceLinkClient['connectNow']>[1]): void {
    const wasStarted = this.started;
    this.started = true;
    super.connectNow(reason, opts);
    this.syncCrossAccount();
    if (!wasStarted) for (const connection of this.extraScopedConnections()) connection.start();
  }

  /**
   * 下面三个入口只由 host 调用,基类内部的重连仍只作用于自己那条连接,
   * 一条线路的故障恢复不会打断另一条。
   */
  override notifyNetworkChanged(options?: { urgent?: boolean }): void {
    super.notifyNetworkChanged(options);
    if (this.crossAccountRunning) this.crossAccount?.notifyNetworkChanged(options);
    if (this.legacyRunning) this.legacy?.notifyNetworkChanged(options);
    for (const connection of this.extraScopedConnections()) connection.notifyNetworkChanged(options);
  }

  override restartConnections(reason?: string): void {
    this.restartConnection(reason);
    if (this.crossAccountRunning) this.crossAccount?.restartConnection(reason);
    if (this.legacyRunning) this.legacy?.restartConnection(reason);
    for (const connection of this.extraScopedConnections()) connection.restartConnection(reason);
  }

  override suspendConnectionsForSystemSleep(reason?: string): void {
    this.suspendForSystemSleep(reason);
    if (this.crossAccountRunning) this.crossAccount?.suspendForSystemSleep(reason);
    if (this.legacyRunning) this.legacy?.suspendForSystemSleep(reason);
    for (const connection of this.extraScopedConnections()) connection.suspendForSystemSleep(reason);
  }

  override connectAllNow(reason?: string, opts?: Parameters<DeviceLinkClient['connectNow']>[1]): void {
    this.connectNow(reason, opts);
    this.syncCrossAccount();
    if (this.crossAccountRunning) this.crossAccount?.connectNow(reason, opts);
    if (this.legacyRunning) this.legacy?.connectNow(reason, opts);
    for (const connection of this.extraScopedConnections()) connection.connectNow(reason, opts);
  }

  // ─── 汇总事件 ───────────────────────────────────────────────────────────────

  private both(off: () => void, subscribe?: (connection: DeviceLinkClient) => () => void): () => void {
    const offCrossAccount = this.crossAccount && subscribe ? subscribe(this.crossAccount) : null;
    const offLegacy = this.legacy && subscribe ? subscribe(this.legacy) : null;
    const observer = subscribe ? { subscribe, off: new Map(this.extraScopedConnections().map(connection => [connection, subscribe(connection)])) } : null;
    if (observer) this.scopedObservers.add(observer);
    return () => {
      off();
      offCrossAccount?.();
      offLegacy?.();
      if (observer) { this.scopedObservers.delete(observer); for (const dispose of observer.off.values()) dispose(); observer.off.clear(); }
    };
  }

  /**
   * 同账号设备的在线状态只取承载它的那条连接:走兼容连接的设备用兼容连接上的 presence,
   * 主连接对它的看法(例如新协议连接重建时对尚未建立通道的设备报的离线)不作数;反之亦然。
   * 2026-11-17:兼容连接设备的真实 presence 被丢弃,host 只能靠一次唤醒时恰好失败的目录读取
   * 判断它在线,界面因此误报离线 40 多分钟。
   * 共享任务 / 供应商分享等范围化 peer 维持原语义,只看主连接。兼容连接未运行时一切照旧。
   */
  override onPresenceChanged(cb: (snap: PresenceSnapshot) => void): () => void {
    // 范围化 peer:只看主连接,原样转交。
    const offScoped = super.onPresenceChanged((snap) => { if (isScopedPeer(snap.deviceId)) cb(snap); });
    const subscriber = { cb, delivered: new Map<string, PresenceSnapshot>() };
    this.presenceSubscribers.add(subscriber);
    return () => { offScoped(); this.presenceSubscribers.delete(subscriber); };
  }

  /**
   * 每条连接各自记下同账号 peer 最近一次 presence。承载连接可能晚于 presence 才确定或之后切换
   * (兼容连接先就绪、Agent-Net 名单晚到;入站 link-open / 出站探测改变路由),所以不在到达时
   * 一次性决定取舍,而是每当 presence、连接状态或路由变化时,把承载连接上的最新快照交给 host;
   * 已交过的同一份快照不重复。连接离线时它的快照作废,不会在之后被当作在线补发。
   */
  private readonly presenceByConnection = new Map<DeviceLinkClient, Map<string, PresenceSnapshot>>();
  private readonly presenceSubscribers = new Set<{ cb: (snap: PresenceSnapshot) => void; delivered: Map<string, PresenceSnapshot> }>();

  private trackPresence(connection: DeviceLinkClient, onPresence: (cb: (snap: PresenceSnapshot) => void) => () => void): void {
    const cache = new Map<string, PresenceSnapshot>();
    this.presenceByConnection.set(connection, cache);
    onPresence((snap) => {
      if (isScopedPeer(snap.deviceId)) return;
      cache.set(snap.deviceId, snap);
      this.routePresence(snap.deviceId);
    });
    connection.onStatusChange((status) => {
      if (status !== 'online') {
        const lost = connection === this ? [] : [...cache.values()];
        cache.clear();
        // The host clears its online view when the primary disconnects. Replay any still-valid legacy snapshots on reconnect.
        if (connection === this) for (const subscriber of this.presenceSubscribers) subscriber.delivered.clear();
        if (this.started) for (const snap of lost) this.routePresence(snap.deviceId, snap);
        return;
      }
      for (const peer of this.presencePeers()) this.routePresence(peer);
    });
  }

  private presencePeers(): Set<string> {
    const peers = new Set<string>();
    for (const cache of this.presenceByConnection.values()) for (const peer of cache.keys()) peers.add(peer);
    return peers;
  }

  /** 把承载该 peer 的连接上的最新快照交给 host;承载连接还没有快照时不猜测。 */
  private routePresence(peer: string, lost?: PresenceSnapshot): void {
    const carrier = this.connectionFor(peer);
    const current = this.presenceByConnection.get(carrier)?.get(peer);
    const offline = lost?.online ? { ...lost, online: false, busy: false, remoteControlEnabled: false } : undefined;
    for (const subscriber of this.presenceSubscribers) {
      const delivered = subscriber.delivered.get(peer);
      const snap = current ?? (delivered === lost ? offline : undefined);
      if (!snap || delivered === snap) continue;
      subscriber.delivered.set(peer, snap);
      try {
        subscriber.cb(snap);
      } catch {
        // 与基类一致:一个订阅方抛错不影响其它订阅方。
      }
    }
  }

  override onFrame(cb: InboundFrameHandler): () => void {
    return this.both(super.onFrame(frame => {
      if (!frame.src || this.acceptsScopedEvent(this, frame.src)) cb(frame);
    }), (connection) => connection.onFrame((frame) => {
      if (frame.src ? !this.acceptsScopedEvent(connection, frame.src) : this.extraScopedConnections().includes(connection)) return;
      if (connection === this.legacy && this.blockedLegacyFrames.has(frame)) return;
      if (connection === this.legacy && frame.src && !isScopedPeer(frame.src) && !this.observedLegacyFrames.has(frame)) {
        this.observedLegacyFrames.add(frame);
        if (frame.kind === 'link-open') {
          const caps = (frame.payload as { capabilities?: string[] } | undefined)?.capabilities;
          if (this.legacyOptions?.prefersPrimary?.(frame.payload) ?? (this.legacyOptions?.primaryCapability && caps?.includes(this.legacyOptions.primaryCapability))) {
            this.legacyPrefersPrimary.add(frame.src); this.legacyRoutes.delete(frame.src);
          } else { this.legacyPrefersPrimary.delete(frame.src); this.legacyRoutes.add(frame.src); }
          this.routePresence(frame.src);
        }
        if (frame.kind === 'invoke' && this.legacyPrefersPrimary.has(frame.src)) {
          this.blockedLegacyFrames.add(frame);
          if (frame.id) connection.sendInvokeResult(frame.src, frame.id, { ok: false, error: { code: 'CHANNEL_NOT_ALLOWED', message: 'Encrypted transport required' } });
          return;
        }
        if (frame.kind === 'push' && this.legacyPrefersPrimary.has(frame.src)) { this.blockedLegacyFrames.add(frame); return; }
        if (frame.id && (frame.kind === 'link-open' || frame.kind === 'invoke')) {
          if (this.legacyReplies.size >= 10_000) {
            this.blockedLegacyFrames.add(frame);
            if (frame.kind === 'invoke') connection.sendInvokeResult(frame.src, frame.id, { ok: false, error: { code: 'BACKPRESSURE', message: 'Too many pending requests' } });
            else connection.closeLink(frame.src, 'transport-timeout');
            return;
          }
          this.legacyReplies.add(frame.src + '\0' + frame.id);
        }
        if (!this.legacyPrefersPrimary.has(frame.src) && !this.legacyRoutes.has(frame.src)) {
          this.legacyRoutes.add(frame.src);
          this.routePresence(frame.src);
        }
      }
      cb(frame);
    }));
  }

  override onPeerStreamAccepted(cb: (peer: string, streamId: string) => void): () => void {
    return this.both(super.onPeerStreamAccepted((peer, streamId) => { if (this.acceptsScopedEvent(this, peer)) cb(peer, streamId); }),
      connection => connection.onPeerStreamAccepted((peer, streamId) => { if (this.acceptsScopedEvent(connection, peer)) cb(peer, streamId); }));
  }

  override onPeerRouteStateChanged(cb: (change: DeviceLinkPeerRouteStateChanged) => void): () => void {
    return this.both(super.onPeerRouteStateChanged(change => { if (this.acceptsScopedEvent(this, change.deviceId)) cb(change); }),
      connection => connection.onPeerRouteStateChanged(change => { if (this.acceptsScopedEvent(connection, change.deviceId)) cb(change); }));
  }

  override onPeerTransportReset(cb: (change: DeviceLinkPeerTransportReset) => void): () => void {
    return this.both(super.onPeerTransportReset(change => { if (this.acceptsScopedEvent(this, change.deviceId)) cb(change); }),
      connection => connection.onPeerTransportReset(change => { if (this.acceptsScopedEvent(connection, change.deviceId)) cb(change); }));
  }

  override onInboundPeerReleased(cb: (peer: string) => void): () => void {
    return this.both(super.onInboundPeerReleased(peer => { if (this.acceptsScopedEvent(this, peer)) cb(peer); }),
      connection => connection.onInboundPeerReleased(peer => { if (this.acceptsScopedEvent(connection, peer)) cb(peer); }));
  }

  override onReliableFrameBeforeLink(cb: (deviceId: string) => unknown): () => void {
    return this.both(super.onReliableFrameBeforeLink(peer => this.acceptsScopedEvent(this, peer) ? cb(peer) : undefined),
      connection => connection.onReliableFrameBeforeLink(peer => this.acceptsScopedEvent(connection, peer) ? cb(peer) : undefined));
  }

  // ─── 按 peer 路由 ───────────────────────────────────────────────────────────

  override sendPresence(patch: PresenceSetPayload): void {
    super.sendPresence(patch);
    // 官方中转按这份 presence 决定是否放行受邀者,开关与 busy 必须同步。
    if (this.crossAccountRunning) this.crossAccount?.sendPresence(patch);
    if (this.legacyRunning) this.legacy?.sendPresence(patch);
    for (const connection of this.extraScopedConnections()) connection.sendPresence(patch);
  }

  override isLinkReady(dst: string): boolean {
    return this.routed(dst)?.isLinkReady(dst) ?? super.isLinkReady(dst);
  }

  override needsLinkRecovery(dst: string): boolean {
    return this.routed(dst)?.needsLinkRecovery(dst) ?? super.needsLinkRecovery(dst);
  }

  override canSendPush(dst: string): boolean {
    return this.routed(dst)?.canSendPush(dst) ?? super.canSendPush(dst);
  }

  override hasPendingRequestsTo(dst: string): boolean {
    return this.routed(dst)?.hasPendingRequestsTo(dst) ?? super.hasPendingRequestsTo(dst);
  }

  override isOutboundExplicitlyClosed(dst: string): boolean {
    return this.routed(dst)?.isOutboundExplicitlyClosed(dst) ?? super.isOutboundExplicitlyClosed(dst);
  }

  override getPeerLinkGeneration(deviceId: string): number {
    return this.routed(deviceId)?.getPeerLinkGeneration(deviceId) ?? super.getPeerLinkGeneration(deviceId);
  }

  override getReliableSendQueueDepth(dst: string): number {
    return this.routed(dst)?.getReliableSendQueueDepth(dst) ?? super.getReliableSendQueueDepth(dst);
  }

  /** 两条连接上的链路合在一起；跨账号 peer 只在专用连接上。relay 往返不覆盖：它是主连接的。 */
  override getPeerLinkSnapshots(): DeviceLinkPeerLinkSnapshot[] {
    const own = super.getPeerLinkSnapshots().filter((s) => this.routed(s.deviceId) === null);
    const combined = this.crossAccountRunning && this.crossAccount ? own.concat(this.crossAccount.getPeerLinkSnapshots().filter(s => this.routed(s.deviceId) === this.crossAccount)) : own;
    const compatible = this.legacyRunning && this.legacy
      ? combined.concat(this.legacy.getPeerLinkSnapshots().filter((s) => this.routed(s.deviceId) === this.legacy)) : combined;
    return compatible.concat(...this.extraScopedConnections().map(connection => connection.getPeerLinkSnapshots().filter(s => this.routed(s.deviceId) === connection)));
  }

  override openLink(dst: string, payload: unknown, timeoutMs?: number): Promise<LinkAcceptPayload> {
    const route = this.routed(dst);
    if (this.legacyRunning && this.legacy && !isScopedPeer(dst)
      && (route === this.legacy || this.legacyOptions?.probeForPeer?.(dst))) {
      return this.legacy.openLink(dst, payload, timeoutMs).then((accepted) => {
        if (this.legacyOptions?.prefersPrimary?.(accepted) ?? (this.legacyOptions?.primaryCapability && accepted.capabilities?.includes(this.legacyOptions.primaryCapability))) {
          this.legacyRoutes.delete(dst); this.legacyPrefersPrimary.add(dst);
          this.routePresence(dst);
          const primary = () => super.openLink(dst, payload, timeoutMs);
          return this.legacyOptions?.openOnPrimary ? this.legacyOptions.openOnPrimary(dst, payload, timeoutMs, primary) : primary();
        }
        this.legacyPrefersPrimary.delete(dst); this.legacyRoutes.add(dst);
        this.routePresence(dst);
        return accepted;
      });
    }
    return route?.openLink(dst, payload, timeoutMs) ?? super.openLink(dst, payload, timeoutMs);
  }

  override closeLink(dst: string, reason: LinkClosePayload['reason'], direction?: 'outbound' | 'inbound'): void {
    const connection = this.routed(dst);
    if (connection) connection.closeLink(dst, reason, direction);
    else super.closeLink(dst, reason, direction);
  }

  override invoke(
    dst: string,
    payload: InvokePayload,
    timeoutMs?: number,
    options?: { preSend?: () => void; noResultCache?: boolean; background?: boolean },
  ): Promise<InvokeResultPayload> {
    return this.routed(dst)?.invoke(dst, payload, timeoutMs, options) ?? super.invoke(dst, payload, timeoutMs, options);
  }

  override sendInvokeResult(dst: string, requestId: string, payload: InvokeResultPayload): void {
    const connection = this.legacyReplies.delete(dst + '\0' + requestId) ? this.legacy : this.routed(dst);
    if (connection) connection.sendInvokeResult(dst, requestId, payload);
    else super.sendInvokeResult(dst, requestId, payload);
  }

  override sendLinkAccept(dst: string, requestId: string, payload: LinkAcceptPayload): void {
    const connection = this.legacyReplies.delete(dst + '\0' + requestId) ? this.legacy : this.routed(dst);
    if (connection) connection.sendLinkAccept(dst, requestId, payload);
    else super.sendLinkAccept(dst, requestId, payload);
  }

  override sendPush(dst: string, channel: string, payload: unknown, ownerStamp?: PushOwnerStamp): void {
    const connection = this.routed(dst);
    if (connection) connection.sendPush(dst, channel, payload, ownerStamp);
    else super.sendPush(dst, channel, payload, ownerStamp);
  }
}
