/**
 * 个人 Discord bot 的 owner-scoped 频道白名单，transport 每次现读，默认不开放。
 * 个人 bot 没有非主人轮次的工具 / 文件 / 检索隔离，读写必须丢弃 allowMembers；
 * 伙伴连接的成员准入由各自连接记录管理，不经过这里。
 */

import {
  EMPTY_DISCORD_CHANNEL_ACCESS,
  normalizeDiscordChannelAccess,
  type DiscordChannelAccessConfig,
  type DiscordChannelAccessStore,
} from '@cindy/im';

import { desktopMakerLogger } from '../../maker-host/logger-adapter.js';
import { createOverrideSettingsFile } from '../../maker-host/override-settings-file.js';
import { ownerScopedImUserDataPath } from '../ownerScopedStorage.js';
import { discordFinalTextGrantStamp, discordGrantTarget, discordGrantTargets, discordGrantValue, reconcileDiscordFinalTextGrants, type DiscordFinalTextGrants } from './authorizationGrants';

const log = desktopMakerLogger.child('discord-channel-access-store');

/** 一期个人 bot 只有主人：成员准入（逐频道 / 服务器级 / 保留的选择里的）一律丢弃。 */
function ownerOnly(raw: unknown): DiscordChannelAccessConfig {
  const access = normalizeDiscordChannelAccess(raw);
  return {
    channels: access.channels.map(({ guildId, channelId }) => ({ guildId, channelId })),
    ...(access.guilds
      ? {
          guilds: access.guilds.map((guild) => ({
            guildId: guild.guildId,
            enabled: guild.enabled,
            mode: guild.mode,
            ...(guild.savedChannels
              ? { savedChannels: guild.savedChannels.map(({ channelId }) => ({ channelId })) }
              : {}),
          })),
        }
      : {}),
  };
}

interface AccessDocument extends DiscordChannelAccessConfig { finalTextGrants?: DiscordFinalTextGrants }
const file = createOverrideSettingsFile<AccessDocument>({
  filePath: () => ownerScopedImUserDataPath('discord-channel-access.json'),
  defaults: EMPTY_DISCORD_CHANNEL_ACCESS,
  normalize: raw => {
    const access = ownerOnly(raw);
    const grants = reconcileDiscordFinalTextGrants((raw as AccessDocument)?.finalTextGrants,
      discordGrantTargets(access).map(target => `personal:${target}`), key => discordGrantValue(access, key.slice('personal:'.length), 'personal'));
    return { ...access, finalTextGrants: grants };
  },
  mergeOverrides: ({ next, overrides }) => {
    const result = { ...overrides };
    for (const key of ['channels', 'guilds', 'finalTextGrants'] as const) {
      if (next[key] === undefined || (key === 'channels' && !next.channels.length)) delete result[key];
      else if (key !== 'finalTextGrants' || Object.keys(next.finalTextGrants!.targets).length) result[key] = next[key];
    }
    return result;
  },
  log,
  label: 'discord-channel-access',
  logLoadedValue: false,
  // 文件读不出来（损坏 / 被手改坏）时按「全部不开放」处理，并拒绝覆盖原文件。
  preserveUnreadableFile: true,
});

export const discordChannelAccessStore: Required<DiscordChannelAccessStore> = {
  read: () => {
    file.invalidateIfChanged();
    return ownerOnly(file.read());
  },
  write(config) {
    file.invalidateIfChanged();
    const access = ownerOnly(config);
    // writePatch 合并已有键，省略 guilds 会留下已撤销的服务器。
    file.writePatch({ ...access, guilds: access.guilds ?? [] });
    return ownerOnly(file.read());
  },
};

export function personalDiscordFinalTextAuthorization(lane: string): string {
  file.invalidateIfChanged();
  const current = file.read();
  const target = discordGrantTarget(current, lane);
  const value = discordGrantValue(current, target, 'personal');
  return discordFinalTextGrantStamp(current.finalTextGrants ?? reconcileDiscordFinalTextGrants(undefined, [], () => value), `personal:${target}`, value);
}
