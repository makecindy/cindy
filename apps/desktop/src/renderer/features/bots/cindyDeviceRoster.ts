import { deviceDisplayName } from '@/lib/deviceName';
import type { CompanionCloudSnapshot } from '../../../shared/companionCloud';
import type { BotProfile } from './botStore';
import { isRemoteBotUnread, taskBotKey, type RemoteBot } from './remoteBotRoster';

export type CindyDeviceBot = BotProfile | RemoteBot;

export interface CindyDeviceOption {
  key: string;
  bot: CindyDeviceBot;
  label: string;
  deviceName: string;
  online: boolean;
  unread: boolean;
  unreadCount?: number;
  route: string;
}

/** Names and avatars are editable, so neither can identify the built-in teammate.
 * Older remote rosters omit template IDs; their provisioned Cindy has this stable ID.
 * Unknown/custom profiles stay separate rather than disappearing into this group. */
export function isCindyDeviceBot(bot: { id: string; templateId?: string }): boolean {
  return bot.templateId === 'cindy' || bot.id === 'cindy-default';
}

/** Task filtering follows the built-in teammate across computers, including historical tasks. */
export function taskCreatorFilterKey(
  bot: { id: string; deviceId?: string; templateId?: string; filterKey?: string },
  cloud?: CompanionCloudSnapshot,
): string {
  if (bot.filterKey) return bot.filterKey;
  if (isCindyDeviceBot(bot)) return JSON.stringify(['teammate', 'cindy']);
  if (cloud?.enabled && cloud.actors.some(actor => actor.externalId === bot.id)) return JSON.stringify(['companion', bot.id]);
  return taskBotKey(bot);
}

export function cindyDeviceKey(bot: { id: string; deviceId?: string }): string {
  return JSON.stringify([bot.deviceId ?? null, bot.id]);
}

/** Presentation only: every option retains its original device and Bot route. */
export function cindyDeviceOptions(
  bots: readonly BotProfile[],
  remoteBots: readonly RemoteBot[],
  devices: readonly { deviceId: string; name: string; isSelf?: boolean }[],
  unreadByBotId: Readonly<Record<string, number>>,
  localLabel: string,
): CindyDeviceOption[] {
  const self = devices.find((device) => device.isSelf);
  const remoteCindys = remoteBots.filter(isCindyDeviceBot);
  const peers = remoteCindys.map((bot) => ({ deviceId: bot.deviceId, name: bot.deviceName }));
  const local = bots
    .filter(
      (bot) =>
        isCindyDeviceBot(bot) &&
        bot.status !== 'archived' &&
        bot.status !== 'deleting' &&
        !bot.hiddenAt,
    )
    .map((bot) => ({
      key: cindyDeviceKey(bot),
      bot,
      label: localLabel,
      deviceName: self?.name.trim() || localLabel,
      online: true,
      unread: (unreadByBotId[bot.id] ?? 0) > 0,
      unreadCount: unreadByBotId[bot.id] ?? 0,
      route: `/bots/${encodeURIComponent(bot.id)}`,
    }));
  const remote = remoteCindys
    .map((bot) => {
      const name = deviceDisplayName(bot.deviceId, bot.deviceName, peers);
      return {
        key: cindyDeviceKey(bot),
        bot,
        label: name,
        deviceName: name,
        online: bot.online,
        unread: isRemoteBotUnread(bot),
        route: `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return [...local, ...remote];
}
