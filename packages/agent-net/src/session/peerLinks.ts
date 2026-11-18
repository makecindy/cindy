/**
 * 业务代码看到的链路客户端：按对端走 Agent-Net 会话或 Device Link（docs/agent-net-session-plan.md 第 10 节「④ 接口外壳」）。
 *
 * 业务（index.ts、dispatch.ts、Node Host）只拿这个类型，不拿 Device Link 客户端本身。每个方法都明确归到下面一组里，
 * 选路层（sessionRouting.ts）逐个实现，没有「没写到就落回 Device Link」：Device Link 客户端以后多了方法，
 * 要先在这里归组、在选路层写上怎么走，业务才用得到。Device Link 客户端本身也满足这个类型（Agent-Net 关着时它就是全部）。
 * 消息形状（Envelope、InvokePayload 等）是两条路共用的业务协议，会话层原样承载。
 */
import type { DeviceLinkClient, InvokePayload } from '@cindy/device-link';

/** Local marker set by the session adapter. Device Link frames cannot supply it. */
export const SESSION_INVOKE_REPLAY = Symbol('session invoke replay');
export type PeerInvokePayload = InvokePayload & { [SESSION_INVOKE_REPLAY]?: true };

/** 按对端、按方向选路的方法：会话层（AgentNetSessionLinks）都有一份。 */
export const PEER_LINK_ROUTED_METHODS = ['openLink', 'closeLink', 'invoke', 'isLinkReady', 'needsLinkRecovery',
  'hasPendingRequestsTo', 'isOutboundExplicitlyClosed', 'getPeerLinkGeneration', 'getReliableSendQueueDepth', 'canSendPush',
  'sendLinkAccept', 'sendInvokeResult', 'sendPush'] as const;

/** 两条路的事件合在一起交给业务；控制本机的提醒两条路都要知道。 */
export const PEER_LINK_MERGED_METHODS = ['onFrame', 'onPeerRouteStateChanged', 'onPeerStreamAccepted', 'onInboundPeerReleased',
  'noteRemoteControlDisabled', 'noteRemoteControlEnabled', 'getPeerLinkSnapshots', 'start', 'stop'] as const;

/**
 * 连接本身的：状态、代次、身份、在线状态、通知、服务端能力、起停与重连。会话就在主连接上，这些都以主连接为准
 * （在线状态由路由客户端合并主连接与兼容连接）。
 */
export const PEER_LINK_CONNECTION_METHODS = ['connectNow', 'restartConnection', 'restartConnections', 'suspendConnectionsForSystemSleep', 'connectAllNow',
  'notifyNetworkChanged', 'waitUntilOnline', 'getStatus', 'hasOnlineConnection', 'onStatusChange', 'getConnectionEpoch',
  'getConnectionIssue', 'onConnectionIssue', 'onPresenceChanged', 'sendPresence', 'hasServerCapability', 'getSelfDeviceId',
  'sendNotify', 'onSeparateCrossAccountStatus', 'onSeparateCrossAccountIssue'] as const;

/**
 * 只有 Device Link 传输层才有的：自建中转的直连路径、中转往返、链路建好前到的可靠帧、传输重置、中转超时确认。
 * 对走会话的对端它们照实报 Device Link 上的情况（没有直连路径、没有重置），会话自己的状态在上面两组里。
 */
export const PEER_LINK_DEVICE_LINK_TRANSPORT_METHODS = ['attachDirectPath', 'getPeerPath', 'hasOfflineDirectPath',
  'peekOfflineDirectPath', 'onPeerPathChanged', 'getRelayRttMs', 'onReliableFrameBeforeLink', 'onPeerTransportReset',
  'confirmRelayForPeerTimeout'] as const;

export type PeerLinkRoutedMethod = typeof PEER_LINK_ROUTED_METHODS[number];
export type PeerLinkMergedMethod = typeof PEER_LINK_MERGED_METHODS[number];
export type PeerLinkConnectionMethod = typeof PEER_LINK_CONNECTION_METHODS[number];
export type PeerLinkDeviceLinkTransportMethod = typeof PEER_LINK_DEVICE_LINK_TRANSPORT_METHODS[number];

export type PeerLinks = Pick<DeviceLinkClient,
  PeerLinkRoutedMethod | PeerLinkMergedMethod | PeerLinkConnectionMethod | PeerLinkDeviceLinkTransportMethod> & {
  /** 按对端拿连接：同账号对端拿到这一层；跨账号对端拿到它那条分享连接（链路状态换成这一层的）。 */
  connectionFor(peer: string): PeerLinks;
  /** 跨账号用的那条连接（官方中转上就是主连接）。 */
  crossAccountConnection(): PeerLinks;
};
