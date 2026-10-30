/**
 * Device Link 直连优先、中继兜底的选路契约。
 *
 * relay 仍是控制面：登录、在线状态、link-open / link-accept / link-close 与
 * 授权都只走 relay。直连通道(例如局域网内的 WebRTC DataChannel)只承载已建立
 * 可靠链路上的数据面帧：reliable-transport-v1 包装的 invoke / invoke-result /
 * push，以及它们的累计 ACK。可靠层按 seq 去重、按序交付，所以同一条消息在
 * 两条路径上各到一次也只会执行一次；直连失效时未确认的帧原样改走 relay 重发。
 *
 * 平台(Desktop / Mobile)负责经已授权的信令建立通道，再交给
 * `DeviceLinkClient.attachDirectPath`。跨账号供应商分享只在 relay 已建立链路、
 * 双端声明支持且本地 30 分钟许可有效时可走直连；共享任务仍只走 relay。
 */

/** 平台提供的一条直连通道。 */
export interface DeviceLinkDirectChannel {
  /**
   * 发送一条完整的 JSON 文本。实现必须保序；无法交付时应关闭通道而不是静默丢弃。
   * 单条最多 MAX_FRAME_BYTES，超过底层消息上限时由实现自行分片。不可写时抛错。
   */
  send(text: string): void;
  /** 本地已排队、尚未交给网络的字节数(如 RTCDataChannel.bufferedAmount)；缺省视为 0。 */
  readonly bufferedAmount?: number;
  /** 释放通道。客户端切回 relay、对端下线、链路关闭或停止时调用；可重复调用。 */
  close(reason: DeviceLinkDirectCloseReason): void;
}

/** 客户端结束直连的原因(仅本地诊断，不上 wire)。 */
export type DeviceLinkDirectCloseReason =
  /** 同一设备接入了新的直连通道。 */
  | 'replaced'
  /** 平台报告通道已断开(对端关闭、ICE 失败等)。 */
  | 'channel-closed'
  /** 写入通道失败。 */
  | 'send-failed'
  /** 经直连发出的帧过了重发期限仍未确认。 */
  | 'ack-timeout'
  /** 直连发送缓冲持续无进展，尚未写出的帧也改走 relay。 */
  | 'buffer-timeout'
  /** relay 报告对端已离线；在线状态以 relay 为准。 */
  | 'peer-offline'
  /** 控制链路被显式关闭或撤权。 */
  | 'link-closed'
  /** 客户端停止(登出、切换账号、设备被移除)。 */
  | 'stopped'
  /** 不允许直连的对象(跨账号范围、本机或客户端未运行)。 */
  | 'not-eligible';

/** 平台持有的句柄：把通道上的事件交回客户端。 */
export interface DeviceLinkDirectPathHandle {
  /** 交付通道上收到的一条完整消息。 */
  receive(text: string): void;
  /** 通道发送缓冲回落，可继续发送排队中的帧。 */
  drained(): void;
  /** 通道已结束；未确认的帧改走 relay。 */
  closed(): void;
  /** 该通道是否仍是此设备当前的直连路线。 */
  isActive(): boolean;
}

export type DeviceLinkPeerPath = 'direct' | 'relay';

export interface DeviceLinkPeerPathChanged {
  deviceId: string;
  path: DeviceLinkPeerPath;
  /** 切回 relay 的原因；切到直连时缺省。 */
  reason?: DeviceLinkDirectCloseReason;
  /** 切回 relay 时需要经 relay 重发的未确认消息数。 */
  resent?: number;
}

/** 直连发送缓冲软上限：暂留可靠队列等 `drained()`，持续无进展则回退 relay。 */
export const DIRECT_PATH_HIGH_WATER_BYTES = 1024 * 1024;
/** An established provider-share direct path may outlive the relay only for this long. */
export const PROVIDER_SHARE_DIRECT_LEASE_MS = 30 * 60_000;
