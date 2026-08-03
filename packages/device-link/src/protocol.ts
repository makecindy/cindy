/**
 * device-link 客户端完整协议(desktop / mobile 共享)。
 *
 * relay 能理解的信封、连接层 payload 与错误码来自 cindy-protocol submodule；
 * 本文件只补充 relay 不解析的端到端隧道 payload、客户端本地错误与 REST 视图。
 */
import {
  MAX_FRAME_BYTES,
  NOTIFY_BODY_MAX_LENGTH,
  NOTIFY_COLLAPSE_ID_MAX_LENGTH,
  NOTIFY_DEEP_LINK_MAX_LENGTH,
  NOTIFY_TITLE_MAX_LENGTH,
  PROTOCOL_VERSION,
  SERVER_CAPABILITY_NOTIFY,
  type DeviceInfo,
  type Envelope,
  type EnvelopeKind,
  type HelloAckPayload,
  type HelloPayload,
  type NotifyCategory,
  type NotifyPayload,
  type PresenceSetPayload,
  type PresenceSnapshot,
  type RelayErrorCode,
  type RelayErrorPayload,
} from '@cindy/device-link-protocol';

export {
  MAX_FRAME_BYTES,
  NOTIFY_BODY_MAX_LENGTH,
  NOTIFY_COLLAPSE_ID_MAX_LENGTH,
  NOTIFY_DEEP_LINK_MAX_LENGTH,
  NOTIFY_TITLE_MAX_LENGTH,
  PROTOCOL_VERSION,
  SERVER_CAPABILITY_NOTIFY,
};
export type {
  DeviceInfo,
  Envelope,
  EnvelopeKind,
  HelloAckPayload,
  HelloPayload,
  NotifyCategory,
  NotifyPayload,
  PresenceSetPayload,
  PresenceSnapshot,
  RelayErrorCode,
  RelayErrorPayload,
};

// ─── 错误码 ───────────────────────────────────────────────────────────────────

/**
 * device-link 全链路错误码。
 * 前 6 个与 server relay 的 RelayErrorCode 对应;后面是 client / 被控端本地产生。
 */
export type DeviceLinkErrorCode = RelayErrorCode
  | 'CHANNEL_NOT_ALLOWED' // channel 不在远程调用白名单
  | 'ACCESS_REVOKED' // 被控端已撤销该控制端的访问权限(逐设备黑名单,被控端本地强制)
  | 'INVOKE_TIMEOUT' // 控制端等待 invoke-result 超时
  | 'LINK_NOT_OPEN' // 控制链路未建立
  | 'NOT_CONNECTED' // 本端尚未连上 relay
  | 'BACKPRESSURE' // 本端可靠传输缓冲已满，拒绝继续制造积压
  | 'MEDIA_FETCH_FAILED' // 入方向媒体取件失败(被控端解析本机媒体 / 上传 OSS 中转出错)
  | 'VOICE_TRANSCRIBE_FAILED' // 出方向手机语音转写失败(被控端下载音频 / ASR 出错)
  | 'VOICE_CREDENTIAL_SYNC_FAILED' // 手机语音云端 ASR/refine 临时 credential 同步失败(历史,新桌面已不再返回)
  | 'VOICE_CREDENTIAL_SYNC_REMOVED' // 穿透 credential 同步能力已下线:手机语音改走 Cindy 官方托管服务,旧手机据此提示升级
  | 'VOICE_DICTIONARY_LEARNING_FAILED' // 手机语音词典学习 evidence 回写失败
  | 'VOICE_DICTIONARY_GET_FAILED'; // 手机拉取被控桌面词典快照失败(读同步状态出错)

/** 带结构化错误码的异常,贯穿 client / host 两层 */
export class DeviceLinkError extends Error {
  /**
   * true = 该错误击中的是一条**已发出**的 in-flight 请求(断连时被 failAllPending
   * 批量 reject):请求帧可能已送达对端,只是响应丢了。控制端的自动重试逻辑必须
   * 区分它与「发送前本地拒绝」(未置位)——对非幂等操作(如 enqueue)盲重前者
   * 会造成对端重复执行。
   */
  inFlight?: boolean;

  constructor(
    public readonly code: DeviceLinkErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DeviceLinkError';
  }
}

/** 判定错误是否击中 in-flight 请求(见 DeviceLinkError.inFlight)。 */
export function isInFlightDeviceLinkError(err: unknown): boolean {
  return err instanceof DeviceLinkError && err.inFlight === true;
}

// ─── 连接层 payload ───────────────────────────────────────────────────────────

// ─── 隧道层 payload ───────────────────────────────────────────────────────────

export interface LinkOpenPayload {
  controllerName: string;
  protocolVersion: number;
  appVersion: string;
  /**
   * 控制端支持的端到端可选能力（append-only）。旧控制端缺省为空集；
   * 被控端只有在能力明确声明时才发送对应的新 wire 字段。
   */
  capabilities?: string[];
  /** reliable-transport-v1 下，本端发往对端的 stream generation。 */
  transportStreamId?: string;
  /** 本端当前仍可能发送的最小 seq；对端重启丢失 ACK 内存时从这里恢复。 */
  transportBaseSeq?: number;
}

/** 控制端能安全消费完整 ProviderLogoKind（含 #527 新增品牌）的 maker:provider:list 投影。 */
export const CONTROLLER_CAPABILITY_PROVIDER_LOGO_KINDS_V2 = 'provider-logo-kinds-v2';

/** 控制端能区分 set-model 中显式 providerId:null 与 JSON optional 占位。 */
export const CONTROLLER_CAPABILITY_SET_MODEL_EXPLICIT_PROVIDER_NULL_V1 =
  'set-model-explicit-provider-null-v1';

export interface LinkAcceptPayload {
  appVersion: string;
  /** 被控端 allowlist 的指纹,便于控制端探测版本差异 */
  allowlistHash: string;
  /**
   * 被控端支持的端到端可选能力。旧被控端缺省为空集，控制端只有在
   * 看到能力后才启用可靠传输与大消息分片。
   */
  capabilities?: string[];
  /** reliable-transport-v1 下，本端发往控制端的 stream generation。 */
  transportStreamId?: string;
  /** 本端当前仍可能发送的最小 seq；对端重启丢失 ACK 内存时从这里恢复。 */
  transportBaseSeq?: number;
}

/**
 * link-close 的关闭原因。
 *
 * wire 语义分两档:
 * - **永久关闭**(user/toggle-off/shutdown/revoked 及存量客户端眼中的一切未知
 *   reason):接收方拆可靠层、拒在途请求,不自动重建;只特判 `'revoked'`
 *   额外标记撤权。新增枚举值对存量客户端 fail-generic 到这一档——因此
 *   **任何可恢复语义的新 reason 都必须经能力协商后才可发送**。
 * - **可恢复瞬时重置**(`transport-timeout`):被控端对该 peer 的可靠重试
 *   耗尽,单独重置这条 link(不拆 relay 连接)。**仅当控制端在 link-open 声明
 *   了 `transport-timeout-close-v1` 能力时才会收到**(见 transport.ts);未声明
 *   的旧控制端走整连接重连的兼容恢复路径。理解该 reason 的接收端按瞬时
 *   重置处理:保留可靠层 stream/pending/在途请求,立即重新 link-open(或触发
 *   rehydrate);重建后按 reconnect-continuity 语义同 seq 续传。
 */
export type LinkCloseReason = 'user' | 'toggle-off' | 'shutdown' | 'revoked' | 'transport-timeout';

export interface LinkClosePayload {
  reason: LinkCloseReason;
}

/** 控制端 → 被控端:执行一次 IPC invoke */
export interface InvokePayload {
  channel: string;
  args: unknown[];
}

/**
 * 被控端 → 控制端:invoke 执行结果。
 * error.message 透传被控端 throwIpcError 的 `[CODE] message` 编码,
 * 控制端 renderer 继续用现有 extractIpcError 解码,错误协议全链路免改。
 */
export type InvokeResultPayload =
  | { ok: true; result: unknown }
  | {
      ok: false;
      error: { code: DeviceLinkErrorCode | 'IPC_ERROR'; message: string };
    };

/** 被控端 → 控制端:广播转发(MAKER_PUSH.* / local-db 推送) */
export interface PushPayload {
  channel: string;
  payload: unknown;
}

// ─── REST 管理面(GET /api/device-link/devices)────────────────────────────────

/** server REST 返回的设备视图(apps/server/src/routes/deviceLink.ts 对应) */
export interface DeviceView {
  deviceId: string;
  name: string;
  selfName?: string | null;
  deviceInfo?: DeviceInfo | null;
  platform: string | null;
  appVersion: string | null;
  /** ISO 字符串;从未上线过的离线设备可能为 null */
  lastSeenAt: string | null;
  online: boolean;
  busy: boolean;
  remoteControlEnabled: boolean;
  isSelf: boolean;
}
