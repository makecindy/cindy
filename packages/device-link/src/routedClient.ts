/**
 * 主连接走自建中转时,跨账号 peer(共享任务 / 供应商分享)改走一条专用的官方连接。
 *
 * 自建中转只认一个账号,也不知道共享成员,所以跨账号帧只能经官方中转
 * (docs/self-hosted-relay-plan.md §7)。host 继续只面对一个 client:带 peer 的调用按 peer 路由,
 * 事件从两条连接汇总;官方线路下专用连接不启动,全部调用落回基类,行为不变。
 *
 * 两条连接的故障互不牵连:状态、连接问题与 presence 只反映主连接;host 要看承载某个 peer 的
 * 连接时用 `connectionFor` / `crossAccountConnection`。
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
import {
  isScopedPeer,
  type InvokePayload,
  type InvokeResultPayload,
  type LinkAcceptPayload,
  type LinkClosePayload,
  type PresenceSetPayload,
  type PushOwnerStamp,
} from './protocol.js';

export interface CrossAccountConnectionOptions {
  /** 主连接这一轮是否走自建中转。 */
  active(): boolean;
  /** 官方连接的配置。设备签名与直连只属于自建中转的同账号链路,这里不接受。 */
  options: Omit<DeviceLinkClientOptions, 'scopedPeersOnly' | 'frameAuth' | 'directRuntime'>;
}

export class RoutedDeviceLinkClient extends DeviceLinkClient {
  private readonly crossAccount: DeviceLinkClient | null;
  private readonly crossAccountActive: () => boolean;
  private crossAccountRunning = false;
  private started = false;

  constructor(options: DeviceLinkClientOptions, crossAccount?: CrossAccountConnectionOptions) {
    super(options);
    this.crossAccount = crossAccount
      ? new DeviceLinkClient({ ...crossAccount.options, scopedPeersOnly: true })
      : null;
    this.crossAccountActive = crossAccount ? () => crossAccount.active() : () => false;
    // 账号作用域与中转设置可能在 start 之后才就绪,主连接每轮建连都按实际线路再核对一次;
    // 主连接连不上自建中转时,跨账号连接照常起来。中转移除本设备只停主连接,这里不跟着停。
    this.onStatusChange((status) => {
      if (status !== 'stopped') this.syncCrossAccount();
    });
  }

  private syncCrossAccount(): void {
    const connection = this.crossAccount;
    if (!connection) return;
    const next = this.started && this.crossAccountActive();
    if (next === this.crossAccountRunning) return;
    this.crossAccountRunning = next;
    if (next) connection.start();
    else connection.stop();
  }

  private routed(peer: string): DeviceLinkClient | null {
    return this.crossAccountRunning && isScopedPeer(peer) ? this.crossAccount : null;
  }

  override connectionFor(peer: string): DeviceLinkClient {
    return this.routed(peer) ?? this;
  }

  override crossAccountConnection(): DeviceLinkClient {
    return (this.crossAccountRunning ? this.crossAccount : null) ?? this;
  }

  override onSeparateCrossAccountStatus(cb: (status: DeviceLinkStatus) => void): () => void {
    return this.crossAccount?.onStatusChange(cb) ?? (() => {});
  }

  override onSeparateCrossAccountIssue(cb: (issue: DeviceLinkConnectionIssue | null) => void): () => void {
    return this.crossAccount?.onConnectionIssue(cb) ?? (() => {});
  }

  // ─── 生命周期 ───────────────────────────────────────────────────────────────

  override start(): void {
    this.started = true;
    super.start();
    this.syncCrossAccount();
  }

  override stop(): void {
    this.started = false;
    super.stop();
    this.syncCrossAccount();
  }

  /** stop 之后 host 也可以用它重新拉起主连接(如回到前台)。 */
  override connectNow(reason?: string, opts?: Parameters<DeviceLinkClient['connectNow']>[1]): void {
    this.started = true;
    super.connectNow(reason, opts);
  }

  /**
   * 下面三个入口只由 host 调用,基类内部的重连仍只作用于自己那条连接,
   * 一条线路的故障恢复不会打断另一条。
   */
  override notifyNetworkChanged(options?: { urgent?: boolean }): void {
    super.notifyNetworkChanged(options);
    if (this.crossAccountRunning) this.crossAccount?.notifyNetworkChanged(options);
  }

  override restartConnections(reason?: string): void {
    this.restartConnection(reason);
    if (this.crossAccountRunning) this.crossAccount?.restartConnection(reason);
  }

  override connectAllNow(reason?: string, opts?: Parameters<DeviceLinkClient['connectNow']>[1]): void {
    this.connectNow(reason, opts);
    this.syncCrossAccount();
    if (this.crossAccountRunning) this.crossAccount?.connectNow(reason, opts);
  }

  // ─── 汇总事件 ───────────────────────────────────────────────────────────────

  private both(off: () => void, subscribe?: (connection: DeviceLinkClient) => () => void): () => void {
    const offCrossAccount = this.crossAccount && subscribe ? subscribe(this.crossAccount) : null;
    return () => {
      off();
      offCrossAccount?.();
    };
  }

  override onFrame(cb: InboundFrameHandler): () => void {
    return this.both(super.onFrame(cb), (connection) => connection.onFrame(cb));
  }

  override onPeerStreamAccepted(cb: (peer: string, streamId: string) => void): () => void {
    return this.both(super.onPeerStreamAccepted(cb), (connection) => connection.onPeerStreamAccepted(cb));
  }

  override onPeerRouteStateChanged(cb: (change: DeviceLinkPeerRouteStateChanged) => void): () => void {
    return this.both(super.onPeerRouteStateChanged(cb), (connection) => connection.onPeerRouteStateChanged(cb));
  }

  override onPeerTransportReset(cb: (change: DeviceLinkPeerTransportReset) => void): () => void {
    return this.both(super.onPeerTransportReset(cb), (connection) => connection.onPeerTransportReset(cb));
  }

  override onReliableFrameBeforeLink(cb: (deviceId: string) => unknown): () => void {
    return this.both(super.onReliableFrameBeforeLink(cb), (connection) => connection.onReliableFrameBeforeLink(cb));
  }

  // ─── 按 peer 路由 ───────────────────────────────────────────────────────────

  override sendPresence(patch: PresenceSetPayload): void {
    super.sendPresence(patch);
    // 官方中转按这份 presence 决定是否放行受邀者,开关与 busy 必须同步。
    if (this.crossAccountRunning) this.crossAccount?.sendPresence(patch);
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

  override openLink(dst: string, payload: unknown, timeoutMs?: number): Promise<LinkAcceptPayload> {
    return this.routed(dst)?.openLink(dst, payload, timeoutMs) ?? super.openLink(dst, payload, timeoutMs);
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
    options?: { preSend?: () => void; background?: boolean },
  ): Promise<InvokeResultPayload> {
    return this.routed(dst)?.invoke(dst, payload, timeoutMs, options) ?? super.invoke(dst, payload, timeoutMs, options);
  }

  override sendInvokeResult(dst: string, requestId: string, payload: InvokeResultPayload): void {
    const connection = this.routed(dst);
    if (connection) connection.sendInvokeResult(dst, requestId, payload);
    else super.sendInvokeResult(dst, requestId, payload);
  }

  override sendLinkAccept(dst: string, requestId: string, payload: LinkAcceptPayload): void {
    const connection = this.routed(dst);
    if (connection) connection.sendLinkAccept(dst, requestId, payload);
    else super.sendLinkAccept(dst, requestId, payload);
  }

  override sendPush(dst: string, channel: string, payload: unknown, ownerStamp?: PushOwnerStamp): void {
    const connection = this.routed(dst);
    if (connection) connection.sendPush(dst, channel, payload, ownerStamp);
    else super.sendPush(dst, channel, payload, ownerStamp);
  }
}
