/**
 * 按对端把业务的链路调用分给 Agent-Net 会话层或原来的 Device Link（docs/agent-net-session-plan.md 第 10.1 节）。
 * index.ts 与 Node Host 一直包着这一层：Agent-Net 关着或对端没有会话时，每个调用原样交给原来的客户端，行为不变。
 * 业务拿到的是 PeerLinks（peerLinks.ts）：每个方法都在这里写明走哪条路，没写到的方法业务用不到，不会悄悄落回 Device Link。
 *
 * 选路按方向锁定，链路中途不换路：
 * - 本机控制对端：和对端的会话可用，Device Link 上这个对端的链路既没就绪、也不等着恢复、也没有待发消息，建链和调用
 *   （包括不需要建链的列表、探测）都走会话；建好的会话链路一直用到本机关链、对端关链或会话断掉。一个对端只走一条路：
 *   2026-11-15 隔离验收时列表与探测先经 Device Link 发出，对端的 Device Link 还记着之前的可靠链路，把结果放进这本机已经
 *   没有的链路里，59 秒后超时、再引发重开。Device Link 上有活着的链路（就绪、等恢复、有待发）时照旧走 Device Link：
 *   那上面已确认的请求只能等它重建后补回结果。
 * - 对端连接刚建好（或换了一条）、会话还没到时，Device Link 上又没有它的链路状态，建链和调用先等会话一小段
 *   （AgentNetSessionLinks.sessionPendingMs）：不等的话这一次会落到 Device Link，之后一直用到那条链路断开。
 *   对方此刻在 Agent-Net 上在线、连接还没建（本机刚启动、连接刚断）时也一样，先连上它再等（sessionWait）。
 * - 对端控制本机：跟着对端选的路。link-open 从会话来，接受、结果、推送和关链都走会话；结果按请求来的那条路回去。
 * - 跨账号对端（供应商分享、共享任务）同样按上面选路；它的会话在它自己的分享连接上，受邀者第一次建链前先连上对方电脑再等会话。
 * 连接本身的（在线状态、通知、代次、起停）和只有 Device Link 传输层才有的（自建中转的直连路径等）交给 Device Link。
 */
import { isScopedPeer, type DeviceLinkClient, type DeviceLinkPeerRouteStateChanged, type Envelope,
  type InvokePayload, type LinkClosePayload } from '@cindy/device-link';
import { isSessionUnlinkedPushChannel, type AgentNetSessionLinks } from './sessionLinks.js';
import {
  PEER_LINK_CONNECTION_METHODS, PEER_LINK_DEVICE_LINK_TRANSPORT_METHODS,
  type PeerLinkConnectionMethod, type PeerLinkDeviceLinkTransportMethod, type PeerLinkMergedMethod, type PeerLinkRoutedMethod, type PeerLinks,
} from './peerLinks.js';

type Routed = Pick<PeerLinks, PeerLinkRoutedMethod>;
type Owned = Pick<PeerLinks, PeerLinkConnectionMethod | PeerLinkDeviceLinkTransportMethod>;

/** 把这些方法原样交给一条连接（调用时才取，测试里的假客户端没有的方法不会被碰到）。 */
function delegate(connection: DeviceLinkClient, names: readonly (PeerLinkConnectionMethod | PeerLinkDeviceLinkTransportMethod)[]): Owned {
  const methods: Record<string, (...args: unknown[]) => unknown> = {};
  for (const name of names)
    methods[name] = (...args: unknown[]) => (connection[name] as (...a: unknown[]) => unknown).apply(connection, args);
  return methods as unknown as Owned;
}

const OWNED_BY_CONNECTION = [...PEER_LINK_CONNECTION_METHODS, ...PEER_LINK_DEVICE_LINK_TRANSPORT_METHODS];

/** Device Link 上没有这个对端活着的链路状态（没就绪、不等恢复、没有待发）。 */
function deviceLinkIdle(target: DeviceLinkClient, dst: string): boolean {
  return !target.isLinkReady(dst) && !target.needsLinkRecovery(dst) && target.getReliableSendQueueDepth(dst) === 0;
}

/**
 * 本机现在发给这个对端的调用走会话：已经开着会话链路，或者会话可用、Device Link 上没有它的活着的链路状态。
 * 文件直传按它决定字节走不走会话（index.ts）：只看「有没有会话」时，Device Link 上还留着链路的对端会把整个文件按块经 Device Link 发。
 */
export function outboundOnSession(target: DeviceLinkClient, links: AgentNetSessionLinks, dst: string): boolean {
  return links.ownsOutbound(dst) || (links.available(dst) && deviceLinkIdle(target, dst));
}

export function routeSessionPeers(target: DeviceLinkClient, links: AgentNetSessionLinks,
  log?: { debug(message: string): void }): PeerLinks {
  // Presence 仍走 Device Link；会话层据此和 Device Link 一样在本机先挡住「对端关了允许被控」的调用。
  target.onPresenceChanged((snapshot) => links.notePresence(snapshot));
  const outboundBySession = (dst: string) => outboundOnSession(target, links, dst);
  /**
   * 选路；会话多半还在路上时先等它，等到或到时都再选一次。不用等时同步选，不多一次异步（AgentNetSessionLinks.sessionWait）。
   * 同账号：对端刚连上时等一小段；对方在线、还没连上时先连上再等。跨账号：受邀者这边先连上对方电脑再等，分享连接是用到时才拨的。
   */
  const routed = <R>(dst: string, choose: (useSession: boolean) => Promise<R>): Promise<R> => {
    if (links.ownsOutbound(dst) || links.available(dst) || !deviceLinkIdle(target, dst)) return choose(outboundBySession(dst));
    const wait = links.sessionWait(dst);
    if (!wait) return choose(outboundBySession(dst));
    const startedAt = performance.now();
    return wait.then(() => {
      const useSession = outboundBySession(dst);
      log?.debug(`agent-net session route waited peer=${dst.slice(0, 24)} ms=${Math.round(performance.now() - startedAt)} session=${useSession}`);
      return choose(useSession);
    });
  };
  const both = (first: () => () => void, second: () => () => void) => {
    const off = [first(), second()];
    return () => { for (const unsubscribe of off) unsubscribe(); };
  };
  const perPeer: Routed = {
    openLink: (dst, payload, timeoutMs) => routed(dst, (useSession) => {
      // Agent-Net 关着、对端和它无关时不记：和原来的 Device Link 一样（2026-11-17 review）。
      if (useSession || links.involves(dst)) log?.debug(`agent-net session route openLink peer=${dst.slice(0, 24)} session=${useSession} owned=${links.ownsOutbound(dst)}`
        + ` available=${links.available(dst)} deviceLinkReady=${target.isLinkReady(dst)} deviceLinkRecovery=${target.needsLinkRecovery(dst)}`
        + ` deviceLinkQueue=${target.getReliableSendQueueDepth(dst)}`);
      if (useSession) return links.openLink(dst, payload, timeoutMs);
      links.noteDeviceLinkLink(dst, 'outbound');
      return target.openLink(dst, payload, timeoutMs);
    }),
    closeLink: (dst: string, reason: LinkClosePayload['reason'], direction: 'outbound' | 'inbound' = 'outbound') => {
      const session = direction === 'inbound' ? links.ownsInbound(dst) : links.ownsOutbound(dst) || links.needsLinkRecovery(dst);
      if (session) links.closeLink(dst, reason, direction); else target.closeLink(dst, reason, direction);
    },
    invoke: (dst: string, payload: InvokePayload, timeoutMs?: number, options?: Parameters<DeviceLinkClient['invoke']>[3]) =>
      routed(dst, (useSession) => (useSession ? links.invoke(dst, payload, timeoutMs, options) : target.invoke(dst, payload, timeoutMs, options))),
    isLinkReady: (dst) => (links.ownsOutbound(dst) ? links.isLinkReady(dst) : target.isLinkReady(dst)),
    // 控制方向的恢复与显式关闭只看出站：对端经会话控制本机时，本机经 Device Link 那条的状态照旧由 Device Link 报。
    needsLinkRecovery: (dst) => (links.knowsOutbound(dst) ? links.needsLinkRecovery(dst) : target.needsLinkRecovery(dst)),
    hasPendingRequestsTo: (dst) => links.hasPendingRequestsTo(dst) || target.hasPendingRequestsTo(dst),
    isOutboundExplicitlyClosed: (dst) => (links.knowsOutbound(dst) ? links.isOutboundExplicitlyClosed(dst) : target.isOutboundExplicitlyClosed(dst)),
    getPeerLinkGeneration: (dst) => (links.ownsGeneration(dst) ? links.getPeerLinkGeneration(dst) : target.getPeerLinkGeneration(dst)),
    getReliableSendQueueDepth: (dst) => (links.ownsInbound(dst) ? links.getReliableSendQueueDepth(dst) : target.getReliableSendQueueDepth(dst)),
    canSendPush: (dst) => (links.ownsInbound(dst) ? links.canSendPush(dst) : target.canSendPush(dst)),
    sendLinkAccept: (dst, requestId, payload) => {
      if (links.ownsLinkOpen(dst, requestId)) return links.sendLinkAccept(dst, requestId, payload);
      links.noteDeviceLinkLink(dst, 'inbound');
      return target.sendLinkAccept(dst, requestId, payload);
    },
    sendInvokeResult: (dst, requestId, payload) =>
      (links.ownsRequest(dst, requestId) ? links.sendInvokeResult(dst, requestId, payload) : target.sendInvokeResult(dst, requestId, payload)),
    // 不需要链路的同账号请求与同步（允许被控请求、插件同步、词典）：有会话就走会话，否则照旧 Device Link 的无链路推送。
    sendPush: (dst, channel, payload, ownerStamp) =>
      (links.ownsInbound(dst) || (isSessionUnlinkedPushChannel(channel) && links.available(dst))
        ? links.sendPush(dst, channel, payload, ownerStamp) : target.sendPush(dst, channel, payload, ownerStamp)),
  };
  const merged: Pick<PeerLinks, PeerLinkMergedMethod> = {
    onFrame: (cb: (env: Envelope) => unknown) => both(() => target.onFrame(cb), () => links.onFrame(cb)),
    onPeerRouteStateChanged: (cb: (change: DeviceLinkPeerRouteStateChanged) => void) =>
      both(() => target.onPeerRouteStateChanged(cb), () => links.onPeerRouteStateChanged(cb)),
    onPeerStreamAccepted: (cb: (peer: string, streamId: string) => void) =>
      both(() => target.onPeerStreamAccepted(cb), () => links.onPeerStreamAccepted(cb)),
    onInboundPeerReleased: (cb: (peer: string) => void) => both(() => target.onInboundPeerReleased(cb), () => links.onInboundPeerReleased(cb)),
    noteRemoteControlDisabled: (deviceId) => { links.noteRemoteControlDisabled(deviceId); target.noteRemoteControlDisabled(deviceId); },
    noteRemoteControlEnabled: (deviceId) => { links.noteRemoteControlEnabled(deviceId); target.noteRemoteControlEnabled(deviceId); },
    getPeerLinkSnapshots: () => {
      const sessions = links.getPeerLinkSnapshots();
      const seen = new Set(sessions.map((snapshot) => snapshot.deviceId));
      return [...sessions, ...target.getPeerLinkSnapshots().filter((snapshot) => !seen.has(snapshot.deviceId))];
    },
    start: () => { links.start(); return target.start(); },
    stop: (options) => { links.stop(options); return target.stop(options); },
  };
  /** 业务拿到的连接要是这一层：入口里有不少「connectionFor(peer) === client」这样的身份比较，client 是这一层。 */
  const own = (connection: DeviceLinkClient): PeerLinks => ((connection as unknown) === target ? router : connection);
  const router: PeerLinks = {
    ...delegate(target, OWNED_BY_CONNECTION),
    ...perPeer,
    ...merged,
    // 走会话的同账号对端，按对端取连接时拿到的仍是这一层：它的链路状态在会话上，连接状态与代次跟主连接一致（会话就在主连接上）。
    // 跨账号对端的会话在它自己的分享连接上：拿到那条连接（状态、代次、上线都看它），只是链路状态换成会话上的（scopedView）。
    connectionFor: (dst) => {
      const connection = target.connectionFor(dst);
      if ((connection as unknown) === target) return router;
      // 最近一次链路在会话上时（含会话刚断、离线事件正在发），代次和连接都按这一层的给：会话断开时先清链路状态，按原连接比
      // 会拿 Device Link 的代次去比会话的离线事件（2026-11-17 review）。
      if (!links.knows(dst) && !links.ownsGeneration(dst)) return connection;
      return isScopedPeer(dst) ? scopedView(connection) : router;
    },
    crossAccountConnection: () => own(target.crossAccountConnection()),
  };
  /**
   * 一条跨账号分享连接的视图：按对端的收发与链路状态用这一层的（会话在就走会话，否则交回原客户端，它照样分到这条连接），
   * 其余（状态、代次、等上线、能力、事件）都是这条连接自己的。业务拿 connectionFor(peer) 比代次、看 isLinkReady 时，和同账号一样看到会话上的链路。
   */
  const views = new WeakMap<DeviceLinkClient, PeerLinks>();
  const scopedView = (connection: DeviceLinkClient): PeerLinks => {
    let view = views.get(connection);
    if (!view) {
      view = {
        ...delegate(connection, OWNED_BY_CONNECTION),
        onFrame: (cb) => connection.onFrame(cb),
        onPeerRouteStateChanged: (cb) => connection.onPeerRouteStateChanged(cb),
        onPeerStreamAccepted: (cb) => connection.onPeerStreamAccepted(cb),
        onInboundPeerReleased: (cb) => connection.onInboundPeerReleased(cb),
        noteRemoteControlDisabled: (deviceId) => connection.noteRemoteControlDisabled(deviceId),
        noteRemoteControlEnabled: (deviceId) => connection.noteRemoteControlEnabled(deviceId),
        getPeerLinkSnapshots: () => connection.getPeerLinkSnapshots(),
        start: () => connection.start(),
        stop: (options) => connection.stop(options),
        ...perPeer,
        connectionFor: (dst) => connection.connectionFor(dst),
        crossAccountConnection: () => connection.crossAccountConnection(),
      };
      views.set(connection, view);
    }
    return view;
  };
  return router;
}
