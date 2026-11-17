/**
 * discord/guildDirectory.ts — 设置页「选频道」用的服务器 / 频道清单。
 * ---------------------------------------------------------------------------
 * 只读机器人当前连接缓存里的服务器和文字频道（不发请求、不读消息），并给出机器人在
 * 每个频道的权限，让用户在白名单里一眼看出「选了也用不了」的频道。结构类型，
 * 不依赖 discord.js 运行时，测试可用假对象。
 */

export interface DiscordChannelPermissions {
  /** 看得到频道（没有它其余都无意义）。 */
  view: boolean;
  /** 发送消息。 */
  send: boolean;
  /** 读取历史：表情回应与消息缓存未命中后的编辑需要它。 */
  readHistory: boolean;
  /** 嵌入链接：审批 / 提问卡片是 embed。 */
  embed: boolean;
  /** 上传文件。 */
  attachFiles: boolean;
  /** 在 thread 里发言。 */
  sendInThreads: boolean;
}

export interface DiscordGuildChannelInfo {
  id: string;
  name: string;
  permissions: DiscordChannelPermissions;
}

export interface DiscordGuildInfo {
  id: string;
  name: string;
  channels: DiscordGuildChannelInfo[];
}

interface ChannelLike {
  id: string;
  name?: string;
  type: number;
  rawPosition?: number;
  permissionsFor?(member: unknown): { has(flag: string): boolean } | null;
}

interface GuildLike {
  id: string;
  name?: string;
  members?: { me?: unknown };
  channels?: { cache?: Iterable<ChannelLike> | { values(): Iterable<ChannelLike> } };
}

export interface DirectoryClientLike {
  guilds?: { cache?: Iterable<GuildLike> | { values(): Iterable<GuildLike> } };
}

const GUILD_TEXT = 0;

function values<T>(source: Iterable<T> | { values(): Iterable<T> } | undefined): T[] {
  if (!source) return [];
  if (typeof (source as { values?: unknown }).values === 'function') {
    return Array.from((source as { values(): Iterable<T> }).values());
  }
  return Array.from(source as Iterable<T>);
}

export function listBotGuilds(client: DirectoryClientLike | null | undefined): DiscordGuildInfo[] {
  const guilds: DiscordGuildInfo[] = [];
  for (const guild of values(client?.guilds?.cache)) {
    const me = guild.members?.me;
    const channels: DiscordGuildChannelInfo[] = values(guild.channels?.cache)
      .filter((channel) => channel.type === GUILD_TEXT)
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0))
      .map((channel) => {
        const perms = me ? channel.permissionsFor?.(me) : null;
        const has = (flag: string) => perms?.has(flag) === true;
        return {
          id: channel.id,
          name: channel.name ?? channel.id,
          permissions: {
            view: has('ViewChannel'),
            send: has('SendMessages'),
            readHistory: has('ReadMessageHistory'),
            embed: has('EmbedLinks'),
            attachFiles: has('AttachFiles'),
            sendInThreads: has('SendMessagesInThreads'),
          },
        };
      });
    guilds.push({ id: guild.id, name: guild.name ?? guild.id, channels });
  }
  return guilds.sort((a, b) => a.name.localeCompare(b.name));
}
