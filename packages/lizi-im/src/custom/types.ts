/**
 * custom/types.ts — 自定义渠道(HTTP)的线上契约。
 *
 * 一条自定义连接 = 一个本机回环端点 + 一个出站回调地址。外部系统(自研服务、自动化
 * 脚本)把消息 POST 到端点, Cindy 按 conversationId 分会话跑一轮, 再把终稿 POST 回
 * 回调地址。没有平台侧账号, 也没有群/卡片语义。
 */

/** 入站请求体。 */
export interface CustomInboundMessage {
  /** 外部系统的会话标识; 同一个 id 复用同一间 Cindy 会话。 */
  conversationId: string;
  /** 发言人标识(可选, 缺省按 conversationId 的 owner 处理)。 */
  userId?: string;
  /** 发言人显示名(可选, 只用于上下文)。 */
  userName?: string;
  text: string;
  /** 附件: 本机绝对路径(调用方与本机同侧, 不做 base64 搬运)。 */
  attachments?: CustomInboundAttachment[];
  /**
   * 只对这一条消息生效的回调地址; 缺省用连接配置的回调地址。
   * 终端客户端每次起临时端口时用它, 不必改连接配置。
   */
  callbackUrl?: string;
}

export interface CustomInboundAttachment {
  absPath: string;
  name?: string;
  mimeType?: string;
}

/** 出站回调体。 */
export interface CustomOutboundMessage {
  conversationId: string;
  text: string;
  terminal: 'done' | 'aborted' | 'error';
  attachments: CustomOutboundAttachment[];
  errorCode?: string;
}

export interface CustomOutboundAttachment {
  absPath: string;
  name: string;
}

export const CUSTOM_INBOUND_PATH_PREFIX = '/im/custom/';
export const CUSTOM_INBOUND_PATH_SUFFIX = '/inbound';
