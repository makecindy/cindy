/**
 * Discord 服务器频道准入的纯函数：设置页的每个操作都是「旧配置 → 新配置」的变换。
 * 规范形状与主进程 / 传输层的 `normalizeDiscordChannelAccess`（packages/lizi-im discord/lane.ts）一致，
 * 主进程仍会重新规范化，这里不替它兜底：
 *  - `channels` 只放当前生效的显式选择；
 *  - 服务器被关闭 / 切到全部频道时，原选择收进该服务器的 `savedChannels`，重新开启 / 切回仅指定频道时恢复；
 *  - 没有服务器条目但 `channels` 里有它的频道 = 已开启 + 仅指定频道（存量配置，升级后不变）。
 */
import type {
  BotImDiscordChannelAccess as Access,
  BotImDiscordGuildAccess as GuildEntry,
} from '../../shared/botImConnection';

export type DiscordGuildMode = 'all' | 'selected';

export interface DiscordGuildState {
  enabled: boolean;
  mode: DiscordGuildMode;
  /** 仅指定频道模式下生效的选择。 */
  selectedChannelIds: ReadonlySet<string>;
  /** 全部频道模式下是否允许成员。 */
  allowMembers: boolean;
}

const entryOf = (access: Access, guildId: string): GuildEntry | undefined =>
  access.guilds?.find((guild) => guild.guildId === guildId);

const channelsOf = (access: Access, guildId: string) =>
  access.channels.filter((channel) => channel.guildId === guildId);

export function guildState(access: Access, guildId: string): DiscordGuildState {
  const entry = entryOf(access, guildId);
  const selected = channelsOf(access, guildId);
  const enabled = entry ? entry.enabled : selected.length > 0;
  const mode = entry?.mode ?? 'selected';
  return {
    enabled,
    mode,
    selectedChannelIds: new Set(
      enabled && mode === 'selected' ? selected.map((channel) => channel.channelId) : [],
    ),
    allowMembers: entry?.allowMembers === true,
  };
}

/** 已开启的服务器数（含已不可用的服务器：它们仍在白名单里生效，直到被移除）。 */
export function enabledGuildCount(access: Access): number {
  const ids = new Set(access.channels.map((channel) => channel.guildId));
  for (const guild of access.guilds ?? []) {
    if (guild.enabled) ids.add(guild.guildId);
    else ids.delete(guild.guildId);
  }
  return ids.size;
}

/** 写回一个服务器的条目（含它名下生效的频道），其余服务器原样不动。 */
function withGuild(
  access: Access,
  guildId: string,
  entry: GuildEntry | null,
  channels: Access['channels'],
): Access {
  const otherChannels = access.channels.filter((channel) => channel.guildId !== guildId);
  const otherGuilds = (access.guilds ?? []).filter((guild) => guild.guildId !== guildId);
  const guilds = entry ? [...otherGuilds, entry] : otherGuilds;
  return { channels: [...otherChannels, ...channels], ...(guilds.length > 0 ? { guilds } : {}) };
}

const toEntries = (guildId: string, saved: GuildEntry['savedChannels']): Access['channels'] =>
  (saved ?? []).map(({ channelId, allowMembers }) => ({
    guildId,
    channelId,
    ...(allowMembers ? { allowMembers: true } : {}),
  }));

const toSaved = (channels: Access['channels']): NonNullable<GuildEntry['savedChannels']> =>
  channels.map(({ channelId, allowMembers }) => ({
    channelId,
    ...(allowMembers ? { allowMembers: true } : {}),
  }));

function stash(
  entry: GuildEntry | undefined,
  active: Access['channels'],
): GuildEntry['savedChannels'] {
  const merged = [...(entry?.savedChannels ?? [])];
  for (const channel of toSaved(active))
    if (!merged.some((item) => item.channelId === channel.channelId)) merged.push(channel);
  return merged.length > 0 ? merged : undefined;
}

/** 首次开启（没有配置记录）= 全部频道；关闭不丢选择，配置过的空选择也保留。 */
export function setGuildEnabled(access: Access, guildId: string, enabled: boolean): Access {
  const entry = entryOf(access, guildId);
  const active = channelsOf(access, guildId);
  const state = guildState(access, guildId);
  if (enabled === state.enabled) return access;
  if (!enabled) {
    const saved = state.mode === 'all' ? entry?.savedChannels : stash(entry, active);
    return withGuild(
      access,
      guildId,
      {
        guildId,
        enabled: false,
        mode: state.mode,
        ...(entry?.allowMembers ? { allowMembers: true } : {}),
        ...(saved ? { savedChannels: saved } : {}),
      },
      [],
    );
  }
  // 开启：只有完全没有配置记录的服务器才是首次开启 = 全部频道；设置过的（含「仅指定 + 零选择」）按原样恢复。
  if (!entry) return withGuild(access, guildId, { guildId, enabled: true, mode: 'all' }, []);
  if (entry.mode === 'all') return withGuild(access, guildId, { ...entry, enabled: true }, []);
  return withGuild(
    access,
    guildId,
    {
      guildId,
      enabled: true,
      mode: 'selected',
      ...(entry.allowMembers ? { allowMembers: true } : {}),
    },
    toEntries(guildId, entry.savedChannels),
  );
}

/** 切换覆盖范围（仅对已开启的服务器有意义）：全部频道 ⇄ 仅指定频道；选择在两者之间保留。 */
export function setGuildMode(access: Access, guildId: string, mode: DiscordGuildMode): Access {
  const state = guildState(access, guildId);
  if (!state.enabled || state.mode === mode) return access;
  const entry = entryOf(access, guildId);
  const active = channelsOf(access, guildId);
  const members = entry?.allowMembers ? { allowMembers: true as const } : {};
  if (mode === 'all') {
    const saved = stash(entry, active);
    return withGuild(
      access,
      guildId,
      {
        guildId,
        enabled: true,
        mode: 'all',
        ...members,
        ...(saved ? { savedChannels: saved } : {}),
      },
      [],
    );
  }
  return withGuild(
    access,
    guildId,
    { guildId, enabled: true, mode: 'selected', ...members },
    toEntries(guildId, entry?.savedChannels),
  );
}

/** 仅指定频道模式下勾选 / 取消一个频道（总是确保服务器条目存在，取消最后一个也不会把服务器变成「未开启」）。 */
export function setChannelSelected(
  access: Access,
  guildId: string,
  channelId: string,
  selected: boolean,
): Access {
  const entry = entryOf(access, guildId);
  const rest = channelsOf(access, guildId).filter((channel) => channel.channelId !== channelId);
  const channels = selected ? [...rest, { guildId, channelId }] : rest;
  return withGuild(
    access,
    guildId,
    {
      guildId,
      enabled: true,
      mode: 'selected',
      ...(entry?.allowMembers ? { allowMembers: true } : {}),
    },
    channels,
  );
}

/** 全部频道模式下的「允许成员」。 */
export function setGuildMembersAllowed(access: Access, guildId: string, allowed: boolean): Access {
  const entry = entryOf(access, guildId);
  if (!entry || !entry.enabled || entry.mode !== 'all') return access;
  const { allowMembers: _drop, ...rest } = entry;
  void _drop;
  return withGuild(access, guildId, { ...rest, ...(allowed ? { allowMembers: true } : {}) }, []);
}

/** 仅指定频道模式下，某个已选频道的「允许成员」。 */
export function setChannelMembersAllowed(
  access: Access,
  guildId: string,
  channelId: string,
  allowed: boolean,
): Access {
  const state = guildState(access, guildId);
  if (!state.enabled || state.mode !== 'selected' || !state.selectedChannelIds.has(channelId))
    return access;
  const entry = entryOf(access, guildId);
  const channels = channelsOf(access, guildId).map((channel) =>
    channel.channelId === channelId
      ? { guildId, channelId, ...(allowed ? { allowMembers: true as const } : {}) }
      : channel,
  );
  return withGuild(
    access,
    guildId,
    entry ?? { guildId, enabled: true, mode: 'selected' },
    channels,
  );
}

/** 移除一个已不可用的服务器的全部设置（含保留的选择）。 */
export function removeGuild(access: Access, guildId: string): Access {
  return withGuild(access, guildId, null, []);
}

/** 移除一个已不可用的频道（生效的和保留的选择里都去掉）。 */
export function removeChannel(access: Access, guildId: string, channelId: string): Access {
  const entry = entryOf(access, guildId);
  const current = channelsOf(access, guildId);
  const channels = current.filter((channel) => channel.channelId !== channelId);
  const saved = (entry?.savedChannels ?? []).filter((channel) => channel.channelId !== channelId);
  const next: GuildEntry | null = entry
    ? { ...entry, ...(saved.length > 0 ? { savedChannels: saved } : { savedChannels: undefined }) }
    : current.length > 0 ? { guildId, enabled: true, mode: 'selected' } : null;
  if (next && next.savedChannels === undefined) delete next.savedChannels;
  return withGuild(access, guildId, next, channels);
}
