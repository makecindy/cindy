import type { BotProfile } from './botStore';
import { isRemoteBotUnread, type RemoteBot } from './remoteBotRoster';

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
  const peersByName = new Map<string, string[]>();
  for (const bot of remoteCindys) {
    const name = bot.deviceName.trim().toLocaleLowerCase();
    const peers = peersByName.get(name) ?? [];
    if (!peers.includes(bot.deviceId)) peers.push(bot.deviceId);
    peersByName.set(name, peers);
  }
  for (const peers of peersByName.values()) peers.sort();
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
      const name = bot.deviceName.trim() || bot.deviceId;
      const peers = peersByName.get(bot.deviceName.trim().toLocaleLowerCase())!;
      return {
        key: cindyDeviceKey(bot),
        bot,
        label: peers.length > 1 ? `${name} (${peers.indexOf(bot.deviceId) + 1})` : name,
        deviceName: name,
        online: bot.online,
        unread: isRemoteBotUnread(bot),
        route: `/bots/remote/${encodeURIComponent(bot.deviceId)}/${encodeURIComponent(bot.id)}`,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label) || a.key.localeCompare(b.key));
  return [...local, ...remote];
}
