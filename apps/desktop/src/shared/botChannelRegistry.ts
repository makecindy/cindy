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

export const BOT_CHANNEL_FEATURES = [
  'direct-messages',
  'groups',
  'threads',
  'replies',
  'cards',
  'reactions',
  'attachments',
  'group-history',
  'durable-delivery',
] as const satisfies readonly BotChannelFeature[];

export type BotChannelFeatureAvailability = 'native' | 'degraded' | 'unsupported';

export type BotChannelFeatureDetail = 'feishu-turn-context-only' | 'process-lifetime-delivery';

export interface BotChannelFeatureCapability {
  feature: BotChannelFeature;
  availability: BotChannelFeatureAvailability;
  detail?: BotChannelFeatureDetail;
}

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
  /**
   * Complete, user-visible adapter contract. Older stored mounts may omit it;
   * callers must use `botChannelFeatureCapabilities()` for a normalized view.
   */
  featureCapabilities?: BotChannelFeatureCapability[];
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

type BotChannelPlatform = Exclude<BotRoutePlatform, 'local'>;

type CapabilityProfile = {
  native: readonly BotChannelFeature[];
  degraded?: Partial<Record<BotChannelFeature, BotChannelFeatureDetail>>;
};

const LOCAL_CAPABILITY_PROFILES: Partial<Record<BotChannelPlatform, CapabilityProfile>> = {
  telegram: {
    native: [
      'direct-messages',
      'groups',
      'threads',
      'replies',
      'cards',
      'reactions',
      'attachments',
      'group-history',
    ],
    degraded: { 'durable-delivery': 'process-lifetime-delivery' },
  },
  feishu: {
    native: [
      'direct-messages',
      'groups',
      'threads',
      'replies',
      'cards',
      'reactions',
      'attachments',
    ],
    degraded: {
      'group-history': 'feishu-turn-context-only',
      'durable-delivery': 'process-lifetime-delivery',
    },
  },
  // The personal Discord adapter intentionally accepts owner DMs only. Do
  // not advertise guild/channel/thread capabilities until its inbound router
  // and outbound channel resolver implement those surfaces.
  discord: { native: ['direct-messages', 'cards', 'reactions', 'attachments'] },
  dingtalk: { native: ['direct-messages', 'groups', 'replies', 'cards', 'attachments'] },
  wechat: {
    native: ['direct-messages', 'groups', 'replies', 'attachments', 'durable-delivery'],
  },
  wecom: { native: ['direct-messages', 'groups', 'replies', 'cards', 'attachments'] },
};

const RELAY_CAPABILITY_PROFILES: Partial<Record<BotChannelPlatform, CapabilityProfile>> = {
  telegram: {
    native: [
      'direct-messages',
      'groups',
      'threads',
      'replies',
      'cards',
      'reactions',
      'attachments',
      'group-history',
      'durable-delivery',
    ],
  },
  slack: {
    native: [
      'direct-messages',
      'groups',
      'threads',
      'replies',
      'cards',
      'reactions',
      'attachments',
      'durable-delivery',
    ],
  },
};

function profileFor(
  kind: BotChannelPlatform,
  ownership: BotChannelOwnership,
): CapabilityProfile | undefined {
  return ownership === 'server-relay'
    ? RELAY_CAPABILITY_PROFILES[kind]
    : LOCAL_CAPABILITY_PROFILES[kind];
}

function capabilitiesFromProfile(profile?: CapabilityProfile): BotChannelFeatureCapability[] {
  const native = new Set(profile?.native ?? []);
  return BOT_CHANNEL_FEATURES.map((feature) => {
    if (native.has(feature)) return { feature, availability: 'native' };
    const detail = profile?.degraded?.[feature];
    if (detail) return { feature, availability: 'degraded', detail };
    return { feature, availability: 'unsupported' };
  });
}

/** Complete capability contract for a concrete adapter, including degradations. */
export function botChannelFeatureCapabilities(
  connection: Pick<BotChannelConnection, 'kind' | 'ownership' | 'features' | 'featureCapabilities'>,
): BotChannelFeatureCapability[] {
  if (connection.featureCapabilities?.length === BOT_CHANNEL_FEATURES.length) {
    const byFeature = new Map(connection.featureCapabilities.map((item) => [item.feature, item]));
    if (BOT_CHANNEL_FEATURES.every((feature) => byFeature.has(feature))) {
      return BOT_CHANNEL_FEATURES.map((feature) => byFeature.get(feature)!);
    }
  }
  const profile = profileFor(connection.kind, connection.ownership);
  if (profile) return capabilitiesFromProfile(profile);
  const legacy = new Set(connection.features);
  return BOT_CHANNEL_FEATURES.map((feature) => ({
    feature,
    availability: legacy.has(feature) ? 'native' : 'unsupported',
  }));
}

function advertisedFeatures(
  kind: BotChannelPlatform,
  ownership: BotChannelOwnership,
): readonly BotChannelFeature[] {
  return capabilitiesFromProfile(profileFor(kind, ownership))
    .filter((item) => item.availability !== 'unsupported')
    .map((item) => item.feature);
}

export const LOCAL_BOT_CHANNEL_FEATURES: Partial<
  Record<BotChannelPlatform, readonly BotChannelFeature[]>
> = Object.fromEntries(
  Object.keys(LOCAL_CAPABILITY_PROFILES).map((kind) => [
    kind,
    advertisedFeatures(kind as BotChannelPlatform, 'local-adapter'),
  ]),
);

export const RELAY_BOT_CHANNEL_FEATURES: Partial<
  Record<BotChannelPlatform, readonly BotChannelFeature[]>
> = Object.fromEntries(
  Object.keys(RELAY_CAPABILITY_PROFILES).map((kind) => [
    kind,
    advertisedFeatures(kind as BotChannelPlatform, 'server-relay'),
  ]),
);

export function botChannelFeatureCapabilitiesFor(
  kind: BotChannelPlatform,
  ownership: BotChannelOwnership,
): BotChannelFeatureCapability[] {
  return capabilitiesFromProfile(profileFor(kind, ownership));
}
