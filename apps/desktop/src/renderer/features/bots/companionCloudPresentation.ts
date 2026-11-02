import type { CompanionCloudActor, CompanionCloudSnapshot } from '../../../shared/companionCloud';
import { getRetiredCompanionBotIds } from './companionCloudStore';
import type { RemoteBot } from './remoteBotRoster';

/**
 * Local copies whose home moved to another computer stay out of the roster and entry choice:
 * the companion is listed once, where it runs. The shadow list is persisted in main, so it
 * applies offline and with the feature off too; a known cloud home elsewhere hides the copy
 * even before its demotion is published.
 */
export function withoutShadowedBots<T extends { id: string }>(bots: readonly T[], cloud: CompanionCloudSnapshot): T[] {
  const shadowed = new Set(cloud.demotedBotIds);
  const elsewhere = new Set(cloud.enabled && cloud.selfDeviceId ? cloud.actors.flatMap((actor) =>
    actor.homeDeviceId && actor.homeDeviceId !== cloud.selfDeviceId ? [actor.externalId] : []) : []);
  if (shadowed.size === 0 && elsewhere.size === 0) return [...bots];
  return bots.filter((bot) => !shadowed.has(bot.id) && !elsewhere.has(bot.id));
}

/**
 * Companions the cloud already lists once (their home is known) are not per-computer copies:
 * leave them out of the older multi-computer Cindy picker.
 */
export function withoutCloudCompanions<T extends { id: string }>(bots: readonly T[], cloud: CompanionCloudSnapshot): T[] {
  if (!cloud.enabled) return [...bots];
  const homed = new Set(cloud.actors.flatMap((actor) => actor.homeDeviceId ? [actor.externalId] : []));
  return bots.filter((bot) => !homed.has(bot.id));
}

/** The cloud companion whose home is `deviceId`, when the feature is on. */
export function cloudCompanionAt(cloud: CompanionCloudSnapshot, deviceId: string | undefined, botId: string | undefined): CompanionCloudActor | null {
  if (!cloud.enabled || !deviceId || !botId) return null;
  return cloud.actors.find((actor) => actor.externalId === botId && actor.homeDeviceId === deviceId) ?? null;
}

/** A remote companion homed on that computer: its connection is not announced (cloud-companions.md §3.1). */
export function isCloudCompanionRemote(cloud: CompanionCloudSnapshot, bot: Pick<RemoteBot, 'id' | 'deviceId'>): boolean {
  const actor = cloudCompanionAt(cloud, bot.deviceId, bot.id);
  return !!actor && actor.homeDeviceId !== cloud.selfDeviceId;
}

/**
 * Companions homed on a computer this device never listed (e.g. it was never online
 * here): still reachable as offline remote rows, so the cloud conversation can open.
 */
export function cloudOnlyRemoteBots(cloud: CompanionCloudSnapshot, remoteBots: readonly RemoteBot[]): RemoteBot[] {
  if (!cloud.enabled) return [];
  return cloud.actors.flatMap((actor) => {
    const home = actor.homeDeviceId;
    if (!home || home === cloud.selfDeviceId) return [];
    if (remoteBots.some((bot) => bot.deviceId === home && bot.id === actor.externalId)) return [];
    return [{
      id: actor.externalId,
      deviceId: home,
      deviceName: actor.homeDevice?.name ?? '',
      name: actor.name,
      avatar: actor.avatar ?? '',
      avatarColor: 'violet',
      description: '',
      preview: '',
      activityAt: 0,
      sessionId: null,
      online: false,
      connectionKnown: true,
    }];
  });
}

/**
 * One row per cloud companion: rows another computer still lists for a companion whose home is
 * known to be elsewhere (old copies, possibly cached while that computer is offline) are
 * dropped, and companions homed on a computer never listed here get an offline row.
 */
export function cloudRemoteBots(cloud: CompanionCloudSnapshot, remoteBots: readonly RemoteBot[]): RemoteBot[] {
  const retired = getRetiredCompanionBotIds();
  const current = remoteBots.filter((bot) => !retired.has(bot.id));
  if (!cloud.enabled) return current;
  const homes = new Map(cloud.actors.flatMap((actor) => actor.homeDeviceId ? [[actor.externalId, actor.homeDeviceId] as const] : []));
  const listed = current.filter((bot) => { const home = homes.get(bot.id); return !home || home === bot.deviceId; });
  return [...listed, ...cloudOnlyRemoteBots(cloud, listed)];
}

export function homeDeviceName(cloud: CompanionCloudSnapshot, botId: string, fallback: string): string {
  const actor = cloud.actors.find((candidate) => candidate.externalId === botId);
  return actor?.homeDevice?.name?.trim() || fallback;
}

/**
 * Whether this computer runs `botId`: it holds the profile, the copy is not shadowed, and the
 * companion's known home (when the feature is on) is this computer. Sessions and tasks of a
 * companion live only on its home computer, so only there can they be looked up locally.
 */
export function companionRunsHere(cloud: CompanionCloudSnapshot, localBotIds: readonly string[], botId: string): boolean {
  if (!localBotIds.includes(botId) || cloud.demotedBotIds.includes(botId)) return false;
  const home = cloud.enabled ? cloud.actors.find((actor) => actor.externalId === botId)?.homeDeviceId : undefined;
  return !home || home === cloud.selfDeviceId;
}

/**
 * The main computer is online but has not allowed remote control. Read from the live device list
 * (what the devices page shows), since the snapshot's copy of the presence is only rebuilt when a
 * home changes and goes stale; the snapshot answers only for a computer the list does not have.
 */
export function homeControlOff(
  actor: CompanionCloudActor | undefined,
  devices: ReadonlyArray<{ deviceId: string; online: boolean; remoteControlEnabled: boolean }> | null,
): boolean {
  if (!actor?.homeDeviceId) return false;
  const live = devices?.find((device) => device.deviceId === actor.homeDeviceId);
  if (live) return live.online && live.remoteControlEnabled === false;
  return actor.homeDevice?.online === true && actor.homeDevice.remoteControlEnabled === false;
}
