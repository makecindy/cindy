export const BOT_ROUTE_STATUSES = [
  'active',
  'paused',
  'offline',
  'recovering',
  'error',
  'archived',
] as const;

export type BotRouteStatus = (typeof BOT_ROUTE_STATUSES)[number];

export const BOT_ROUTE_PLATFORMS = [
  'local',
  'telegram',
  'feishu',
  'slack',
  'discord',
  'wechat',
  'dingtalk',
  'wecom',
  'x',
] as const;

export type BotRoutePlatform = (typeof BOT_ROUTE_PLATFORMS)[number];

export interface BotRouteRecord {
  id: string;
  botId: string;
  channelId: string;
  platform: BotRoutePlatform;
  routeKey: string;
  principalKey: string;
  scopeKey: string;
  threadKey?: string;
  currentSessionId?: string;
  projectBindingId?: string;
  capabilities: Record<string, unknown>;
  ownerDeviceId?: string;
  ownerGeneration: number;
  status: BotRouteStatus;
  lastActivityAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface BotRouteSource {
  platform: BotRoutePlatform;
  /** Concrete IM account/app/bot context. Non-local Channels fail closed without it. */
  accountKey?: string;
  /** Server, guild, workspace, tenant, or other platform-level scope. */
  scopeKey?: string;
  /** Chat, group, channel, or DM identifier. */
  principalKey?: string;
  /** Parent chat/channel for thread and forum-post inheritance. */
  parentPrincipalKey?: string;
  /** Thread, topic, or reply-chain identifier. */
  threadKey?: string;
  /**
   * Adapter-owned outbound address. For server relay this is the signed
   * externalKey used by msg.op authorization; it is metadata, never a route
   * matching dimension and never supplied by renderer input.
   */
  deliveryKey?: string;
}

export interface UpsertBotRouteInput {
  id?: string;
  botId: string;
  channelId: string;
  routeKey: string;
  principalKey?: string;
  scopeKey?: string;
  threadKey?: string;
  projectBindingId?: string;
  capabilities?: Record<string, unknown>;
}

export interface ClaimBotRouteInput {
  routeId: string;
  ownerDeviceId: string;
  currentSessionId?: string;
  projectBindingId?: string;
}

export interface UpdateBotRouteSessionInput {
  routeId: string;
  ownerDeviceId: string;
  ownerGeneration: number;
  currentSessionId: string;
}
