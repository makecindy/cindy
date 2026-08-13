/**
 * === device-link 中继层协议(单一权威来源)===
 *
 * 本包是 device-link「relay 中继层」协议的唯一权威定义,由两侧共同引用:
 *  - relay server(device-link-server):哑中继,只解析 envelope 的路由头
 *    (v / kind / id / src / dst)与连接层 payload;隧道层 payload(invoke 的
 *    channel/args、push 的事件内容等)对 relay 完全不透明。
 *  - 客户端完整协议包(desktop / mobile 共享的 device-link 包):在本包基础上
 *    extend 隧道层 payload 类型(LinkOpen / Invoke / Push / DeviceView 等)与
 *    客户端本地错误码(DeviceLinkErrorCode = RelayErrorCode | 客户端局部码)。
 *
 * 准入边界:只有 relay 需要解析/校验的部分才进本包;纯客户端之间端到端、
 * 对 relay 不透明的类型留在客户端协议包里。
 *
 * 本包只承载类型与常量:relay 侧的帧校验由消费方按本定义实现,客户端包在
 * 本包基础上 extend 隧道层类型 —— PROTOCOL_VERSION 只此一处,两侧共同引用。
 */

/** 协议版本:整数,只升不降;不兼容改动 +1。 */
export const PROTOCOL_VERSION = 1;

/** 单帧最大字节数(超过即回 PAYLOAD_TOO_LARGE 并丢弃,不断连;发送方应先行拒绝/裁剪) */
export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/** ws 库层面的硬上限兜底(超过直接断连),留余量给协议层先行优雅拒绝 */
export const WS_MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;

export type EnvelopeKind =
  // —— 连接层(client ↔ server)——
  | 'hello' // client→server: 上线注册 { deviceName, platform, appVersion, remoteControlEnabled, busy, deviceInfo? }
  | 'hello-ack' // server→client: { serverProtocolVersion, deviceId, userId, capabilities? }
  | 'presence-set' // client→server: 部分更新 { remoteControlEnabled?, busy? }
  | 'presence-changed' // server→同账号在线设备广播: 单设备 presence 快照
  | 'ping' // client→server: 应用层心跳(20s),server 借此刷 lastSeenAt / route TTL
  | 'pong' // server→client
  | 'notify' // client→server: 请求给本账号已注册推送 token 的移动设备发系统推送(server 消费,不转发)
  // —— 隧道层(controller ↔ target,server 只转发)——
  | 'link-open'
  | 'link-accept'
  | 'link-close'
  | 'invoke'
  | 'invoke-result'
  | 'push'
  // —— 错误(server→发送方)——
  | 'relay-error';

/** 所有帧的统一信封。src 由 server 填(client 传入值会被覆盖,防伪造)。 */
export interface Envelope {
  v: number;
  kind: EnvelopeKind;
  /** requestId(req/resp 配对;relay-error 回带原帧 id) */
  id?: string;
  /** 源 deviceId(server 在转发时填) */
  src?: string;
  /** 目标 deviceId(隧道层帧必填) */
  dst?: string;
  payload?: unknown;
}

/** 需要 server 按 dst 转发的帧 */
export const ROUTED_KINDS: ReadonlySet<EnvelopeKind> = new Set([
  'link-open',
  'link-accept',
  'link-close',
  'invoke',
  'invoke-result',
  'push',
]);

/**
 * 「发起控制」语义的帧:转发前 server 必须校验目标设备 remoteControlEnabled=true。
 * link-accept / invoke-result / push 是被控端→控制端的回程帧,link-close 是双向解除,
 * 这三类不受被控开关限制(开关关掉后回程帧仍需送达以收尾)。
 */
export const CONTROL_KINDS: ReadonlySet<EnvelopeKind> = new Set(['link-open', 'invoke']);

/**
 * relay-error 的错误码(relay 自身产生的错误)。
 * 客户端协议包的 DeviceLinkErrorCode 是本类型的超集
 * (追加 CHANNEL_NOT_ALLOWED / INVOKE_TIMEOUT 等客户端本地码)。
 */
export type RelayErrorCode =
  | 'DEVICE_OFFLINE' // 目标设备不在线(或不属于本账号)
  | 'REMOTE_DISABLED' // 目标设备「允许被控」开关关闭
  | 'VERSION_MISMATCH' // 协议版本不一致
  | 'PAYLOAD_TOO_LARGE' // 单帧超限
  | 'RATE_LIMITED' // notify 频控命中。只会发给已声明 notify capability 的 server 的对话方——旧客户端不发 notify,不会收到本码
  | 'BAD_REQUEST' // 帧格式非法
  | 'INTERNAL'; // 中继内部错误

export interface RelayErrorPayload {
  code: RelayErrorCode;
  message: string;
  /** 路由失败时回带目标设备,便于控制端定位 */
  dst?: string;
}

// ─── 连接层 payload(relay 需要解析) ─────────────────────────────────────────

/** hello 帧 payload(client→server) */
export interface HelloPayload {
  deviceName: string;
  platform: string;
  appVersion: string;
  remoteControlEnabled: boolean;
  busy: boolean;
  deviceInfo?: DeviceInfo;
}

/** hello-ack 帧 payload(server→client) */
export interface HelloAckPayload {
  serverProtocolVersion: number;
  deviceId: string;
  userId: string;
  /**
   * server 支持的可选能力集(append-only)。旧 server 缺省 = 空集;
   * 客户端只有在能力集包含对应项时才发起该能力的帧(如 'notify'),
   * 避免旧 server 对未知 kind 静默丢弃造成黑洞。
   */
  capabilities?: string[];
}

/** hello-ack.capabilities:server 支持 notify 帧(移动推送)。 */
export const SERVER_CAPABILITY_NOTIFY = 'notify';

/** presence-set 帧 payload(client→server,部分更新) */
export interface PresenceSetPayload {
  remoteControlEnabled?: boolean;
  busy?: boolean;
}

// ─── notify(移动推送)────────────────────────────────────────────────────────

/** notify 事件类别(会话终态语义,与桌面通知的 kind 对齐)。 */
export type NotifyCategory = 'session-done' | 'session-error' | 'session-needs-reply';

/** notify payload 的字段长度上限(server 超限即整帧 BAD_REQUEST,不静默截断)。 */
export const NOTIFY_TITLE_MAX_LENGTH = 120;
export const NOTIFY_BODY_MAX_LENGTH = 240;
export const NOTIFY_DEEP_LINK_MAX_LENGTH = 512;
export const NOTIFY_COLLAPSE_ID_MAX_LENGTH = 128;

/**
 * notify 帧 payload(client→server;server 消费,不转发)。
 * server 查本账号已注册的推送 token(排除发送方自己),经 APNs/FCM 下发系统推送。
 * 发送门槛:hello-ack.capabilities 含 SERVER_CAPABILITY_NOTIFY 才可发;
 * 旧 server 收到未知 kind 会静默丢弃(黑洞),没有该能力声明时客户端不得发送。
 * fire-and-forget:成功无响应;失败回 relay-error(RATE_LIMITED / BAD_REQUEST / INTERNAL)。
 */
export interface NotifyPayload {
  category: NotifyCategory;
  /** 通知标题(建议:会话标题) */
  title: string;
  /**
   * 通知正文,可缺省。发送端可放内容摘要(如最近一条 assistant 回复)——
   * 体验优先的产品决策;注意正文经 APNs/FCM 第三方通道,发送端自行裁剪长度
   * 与敏感度,server 不落盘通知内容。
   */
  body?: string;
  /** 点击通知的跳转深链,如 cindy://devices/<deviceId>/sessions/<sessionId> */
  deepLink: string;
  /** 系统层合并键(APNs collapse-id / thread-id):同键新通知顶替旧通知 */
  collapseId: string;
  /** 只推给指定设备;缺省 = 本账号全部已注册推送 token 的设备(不含发送方) */
  targetDeviceId?: string;
}

/** 设备识别用的轻量硬件 / 系统信息。所有字段 best-effort,可缺省。 */
export interface DeviceInfo {
  cpuLabel?: string;
  memoryGb?: number;
  osVersion?: string;
  modelLabel?: string;
}

/** presence-changed 广播 / REST 设备列表共用的设备快照 */
export interface PresenceSnapshot {
  deviceId: string;
  online: boolean;
  deviceName: string;
  selfName?: string | null;
  deviceInfo?: DeviceInfo | null;
  platform: string;
  appVersion: string;
  /** unix ms */
  lastSeenAt: number;
  remoteControlEnabled: boolean;
  busy: boolean;
}
