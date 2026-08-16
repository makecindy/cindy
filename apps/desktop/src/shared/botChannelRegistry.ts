import type { BotRoutePlatform } from './botRoute';

export type BotChannelOwnership = 'local-adapter' | 'server-relay';

export type BotChannelFeature =
  | 'direct-messages'
  | 'groups'
  | 'threads'
  | 'replies'
  | 'cards'
  | 'reactions'
  | 'attachments'
  | 'group-history'
  | 'durable-delivery';

/**
 * A concrete, already configured IM identity that can be mounted on a Bot.
 * `accountKey` is the exact identity consumed by Bot Route matching; display
 * names and connection ids never participate in routing.
 */
export interface BotChannelConnection {
  id: string;
  kind: Exclude<BotRoutePlatform, 'local'>;
  ownership: BotChannelOwnership;
  status: string;
  connected: boolean;
  accountKey: string | null;
  accountName: string | null;
  scopeKey: string | null;
  routable: boolean;
  features: BotChannelFeature[];
}

export interface BotChannelMountIdentity {
  kind: Exclude<BotRoutePlatform, 'local'>;
  ownership: BotChannelOwnership;
  accountKey: string;
}

/**
 * Normalize the durable identity used to claim one concrete IM account.
 * Display names and connection ids are intentionally excluded: they may
 * change without changing which account owns incoming messages.
 */
export function botChannelMountIdentity(
  kind: BotRoutePlatform,
  config: Record<string, unknown>,
): BotChannelMountIdentity | null {
  if (kind === 'local') return null;
  const accountKey = typeof config.accountKey === 'string' ? config.accountKey.trim() : '';
  const ownership = config.ownership;
  if (!accountKey || (ownership !== 'local-adapter' && ownership !== 'server-relay')) return null;
  return { kind, ownership, accountKey };
}

export function sameBotChannelMountIdentity(
  left: BotChannelMountIdentity | null,
  right: BotChannelMountIdentity | null,
): boolean {
  return Boolean(
    left &&
    right &&
    left.kind === right.kind &&
    left.ownership === right.ownership &&
    left.accountKey === right.accountKey,
  );
}

export const LOCAL_BOT_CHANNEL_FEATURES: Partial<
  Record<Exclude<BotRoutePlatform, 'local'>, readonly BotChannelFeature[]>
> = {
  telegram: [
    'direct-messages',
    'groups',
    'threads',
    'replies',
    'cards',
    'reactions',
    'attachments',
    'group-history',
  ],
  feishu: [
    'direct-messages',
    'groups',
    'threads',
    'replies',
    'cards',
    'reactions',
    'attachments',
  ],
  // The personal Discord adapter intentionally accepts owner DMs only.  Do
  // not advertise guild/channel/thread capabilities until its inbound router
  // and outbound channel resolver implement those surfaces.
  discord: ['direct-messages', 'cards', 'reactions', 'attachments'],
  dingtalk: ['direct-messages', 'groups', 'replies', 'cards', 'attachments'],
  wechat: ['direct-messages', 'groups', 'replies', 'attachments', 'durable-delivery'],
  wecom: ['direct-messages', 'groups', 'replies', 'cards', 'attachments'],
};

export const RELAY_BOT_CHANNEL_FEATURES: Partial<
  Record<Exclude<BotRoutePlatform, 'local'>, readonly BotChannelFeature[]>
> = {
  telegram: [
    'direct-messages',
    'groups',
    'threads',
    'replies',
    'reactions',
    'attachments',
    'group-history',
    'durable-delivery',
  ],
  slack: [
    'direct-messages',
    'groups',
    'threads',
    'replies',
    'cards',
    'reactions',
    'attachments',
    'durable-delivery',
  ],
};
