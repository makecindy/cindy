/**
 * discord/lane.ts — 服务器频道的 lane 编码与白名单判定。
 * ---------------------------------------------------------------------------
 * 编排层只认一个 `userId` 字符串来路由会话与出站目标。私聊的 userId 就是 Discord
 * 数字 user id；服务器频道用 lane id：
 *   - `g/{guildId}/{channelId}`            文字频道（同频道共享一个会话）
 *   - `g/{guildId}/{channelId}/{threadId}` 频道里已存在的 thread（thread 独立一个会话）
 * 私聊 id 全是数字，与 `g/` 前缀无歧义。白名单只认父频道，thread 沿用父频道的准入。
 */

const LANE_PREFIX = 'g/';
const SNOWFLAKE = /^\d{1,25}$/;

export interface DiscordLane {
  guildId: string;
  /** 文字频道 id；thread 里是它的父频道。 */
  channelId: string;
  /** thread id；频道主流为空串。 */
  threadId: string;
}

export function encodeDiscordLaneUserId(lane: DiscordLane): string {
  const parts = [lane.guildId, lane.channelId, ...(lane.threadId ? [lane.threadId] : [])];
  if (!parts.every((part) => SNOWFLAKE.test(part))) throw new Error('invalid discord lane id part');
  return `${LANE_PREFIX}${parts.join('/')}`;
}

/** 非 lane id（私聊 user id）返回 null。 */
export function decodeDiscordLaneUserId(userId: string): DiscordLane | null {
  if (!userId.startsWith(LANE_PREFIX)) return null;
  const parts = userId.slice(LANE_PREFIX.length).split('/');
  if (parts.length < 2 || parts.length > 3) return null;
  if (!parts.every((part) => SNOWFLAKE.test(part))) return null;
  return { guildId: parts[0], channelId: parts[1], threadId: parts[2] ?? '' };
}

// discord.js ChannelType: AnnouncementThread=10 / PublicThread=11 / PrivateThread=12。
const THREAD_CHANNEL_TYPES: ReadonlySet<number> = new Set([10, 11, 12]);

/**
 * 由消息 / 交互所在的 channel 推出 lane。thread 必须带父频道 id（白名单只认父频道），
 * 认不出父频道时返回 null，由调用方丢弃，不能退化成按 thread id 当频道用。
 */
export function discordLaneOfChannel(
  guildId: string | null | undefined,
  channelId: string,
  channel: { type?: number; parentId?: string | null } | null | undefined,
): DiscordLane | null {
  if (!guildId || !channelId) return null;
  const lane: DiscordLane =
    channel?.type !== undefined && THREAD_CHANNEL_TYPES.has(channel.type)
      ? { guildId, channelId: channel.parentId ?? '', threadId: channelId }
      : { guildId, channelId, threadId: '' };
  return [lane.guildId, lane.channelId, ...(lane.threadId ? [lane.threadId] : [])].every((part) => SNOWFLAKE.test(part))
    ? lane
    : null;
}

/** 这条 lane 实际要收发消息的 Discord channel id（thread 就是它自己）。 */
export function discordLaneTargetChannelId(lane: DiscordLane): string {
  return lane.threadId || lane.channelId;
}

/** 显式选择的频道；`allowMembers` 缺省 = 只有主人能在该频道召唤。 */
export interface DiscordChannelAccessEntry {
  guildId: string;
  channelId: string;
  allowMembers?: boolean;
}

/** 服务器级准入的覆盖范围：整个服务器的文字频道（含之后新增的）/ 只有 `channels` 里选中的。 */
export type DiscordGuildMode = 'all' | 'selected';

/**
 * 一个服务器的准入设置。没有这一项的服务器：`channels` 里有它的频道 = 「已开启 + 仅指定频道」（存量配置的含义，
 * 升级后不变）；一个频道都没有 = 未开启。
 *
 * `channels` 永远只放「当前真正生效的显式选择」——服务器被关闭、或切到全部频道时，原来的选择收进
 * `savedChannels`（重新开启 / 切回仅指定频道时恢复）。这样只认 `channels` 的旧版本读到这份配置，
 * 只会少开、不会多开。
 */
export interface DiscordGuildAccessEntry {
  guildId: string;
  enabled: boolean;
  mode: DiscordGuildMode;
  /** 全部频道模式下，是否允许成员召唤（仅伙伴连接可开；指定频道模式沿用逐频道的 allowMembers）。 */
  allowMembers?: boolean;
  /** 暂时不生效的显式选择（服务器关闭 / 全部频道模式下保留）。 */
  savedChannels?: Array<{ channelId: string; allowMembers?: boolean }>;
}

/** 默认空 = 不开放任何服务器频道。 */
export interface DiscordChannelAccessConfig {
  channels: DiscordChannelAccessEntry[];
  guilds?: DiscordGuildAccessEntry[];
}

export const DISCORD_CHANNEL_ACCESS_MAX_ENTRIES = 200;
export const DISCORD_GUILD_ACCESS_MAX_ENTRIES = 100;

export const EMPTY_DISCORD_CHANNEL_ACCESS: DiscordChannelAccessConfig = { channels: [] };

/** 宿主注入的白名单存取（桌面是 owner-scoped JSON；读是实时的，改动立即生效）。 */
export interface DiscordChannelAccessStore {
  read(): DiscordChannelAccessConfig;
  /** 缺省 = 这份实例不通过自己的 IPC 改白名单（伙伴连接由宿主的连接设置写）。 */
  write?(config: DiscordChannelAccessConfig): DiscordChannelAccessConfig;
}

type SavedChannel = NonNullable<DiscordGuildAccessEntry['savedChannels']>[number];

/**
 * 把外部输入规整成合法、规范的配置（不信任 UI，也不信任手改的文件）：
 * 丢弃非法 id、去重、封顶；缺失 / 非法的 `enabled` 按关闭处理（fail closed）；
 * 不生效的服务器（关闭或全部频道模式）名下的显式频道挪进 `savedChannels`，保证 `channels` 只含生效的选择。
 */
export function normalizeDiscordChannelAccess(raw: unknown): DiscordChannelAccessConfig {
  const source = isRecord(raw) ? raw : {};
  const seen = new Set<string>();
  let channels: DiscordChannelAccessEntry[] = [];
  for (const item of Array.isArray(source.channels) ? source.channels : []) {
    if (!isRecord(item)) continue;
    const { guildId, channelId } = item;
    if (typeof guildId !== 'string' || typeof channelId !== 'string') continue;
    if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId)) continue;
    const key = `${guildId}/${channelId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    channels.push({ guildId, channelId, ...(item.allowMembers === true ? { allowMembers: true } : {}) });
    if (channels.length >= DISCORD_CHANNEL_ACCESS_MAX_ENTRIES) break;
  }

  const guildSeen = new Set<string>();
  const parsedGuilds: DiscordGuildAccessEntry[] = [];
  for (const item of Array.isArray(source.guilds) ? source.guilds : []) {
    if (!isRecord(item) || typeof item.guildId !== 'string' || !SNOWFLAKE.test(item.guildId)) continue;
    if (guildSeen.has(item.guildId)) continue;
    guildSeen.add(item.guildId);
    const saved: SavedChannel[] = [];
    const savedSeen = new Set<string>();
    for (const channel of Array.isArray(item.savedChannels) ? item.savedChannels : []) {
      if (!isRecord(channel) || typeof channel.channelId !== 'string' || !SNOWFLAKE.test(channel.channelId)) continue;
      if (savedSeen.has(channel.channelId)) continue;
      savedSeen.add(channel.channelId);
      saved.push({ channelId: channel.channelId, ...(channel.allowMembers === true ? { allowMembers: true } : {}) });
    }
    parsedGuilds.push({
      guildId: item.guildId,
      enabled: item.enabled === true,
      mode: item.mode === 'all' ? 'all' : 'selected',
      ...(item.allowMembers === true ? { allowMembers: true } : {}),
      ...(saved.length > 0 ? { savedChannels: saved } : {}),
    });
    if (parsedGuilds.length >= DISCORD_GUILD_ACCESS_MAX_ENTRIES) break;
  }

  const guilds: DiscordGuildAccessEntry[] = [];
  let savedBudget = DISCORD_CHANNEL_ACCESS_MAX_ENTRIES;
  for (const guild of parsedGuilds) {
    const inEffect = guild.enabled && guild.mode === 'selected';
    let saved: SavedChannel[] = inEffect ? [] : [...(guild.savedChannels ?? [])];
    if (!inEffect) {
      // 不生效的服务器：显式频道从 channels 挪进 saved（已在 saved 里的保留成员标记的并集）。
      const moved = channels.filter((entry) => entry.guildId === guild.guildId);
      channels = channels.filter((entry) => entry.guildId !== guild.guildId);
      for (const entry of moved) {
        const existing = saved.find((item) => item.channelId === entry.channelId);
        if (existing) {
          if (entry.allowMembers) existing.allowMembers = true;
        } else {
          saved.push({ channelId: entry.channelId, ...(entry.allowMembers ? { allowMembers: true } : {}) });
        }
      }
    }
    saved = saved.slice(0, Math.max(0, savedBudget));
    savedBudget -= saved.length;
    // 条目本身就是「已设置过」的记录：关闭 + 仅指定 + 零选择也保留——否则重新开启会被当成首次开启而变成全部频道。
    guilds.push({
      guildId: guild.guildId,
      enabled: guild.enabled,
      mode: guild.mode,
      ...(guild.allowMembers ? { allowMembers: true } : {}),
      ...(saved.length > 0 ? { savedChannels: saved } : {}),
    });
  }
  return { channels, ...(guilds.length > 0 ? { guilds } : {}) };
}

function guildEntryOf(config: DiscordChannelAccessConfig, guildId: string): DiscordGuildAccessEntry | undefined {
  return config.guilds?.find((guild) => guild.guildId === guildId);
}

/** 这条 lane 所在的频道此刻是否在准入范围内（与发言人身份无关）：出站、卡片点击、撤销复核都用它。 */
export function isDiscordLaneEnabled(
  config: DiscordChannelAccessConfig,
  lane: Pick<DiscordLane, 'guildId' | 'channelId'>,
): boolean {
  const guild = guildEntryOf(config, lane.guildId);
  if (guild) {
    if (!guild.enabled) return false;
    if (guild.mode === 'all') return true;
  }
  return config.channels.some((entry) => entry.guildId === lane.guildId && entry.channelId === lane.channelId);
}

/** 这条 lane 现在是否允许该身份使用：必须在准入范围内，非主人还需显式允许成员。thread 随父频道。 */
export function isDiscordLaneAdmitted(
  config: DiscordChannelAccessConfig,
  lane: DiscordLane,
  isOwner: boolean,
): boolean {
  if (!isDiscordLaneEnabled(config, lane)) return false;
  if (isOwner) return true;
  const guild = guildEntryOf(config, lane.guildId);
  if (guild?.enabled && guild.mode === 'all') return guild.allowMembers === true;
  return (
    config.channels.find((entry) => entry.guildId === lane.guildId && entry.channelId === lane.channelId)
      ?.allowMembers === true
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
