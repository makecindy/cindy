/**
 * 云端伙伴（docs/product-rules/cloud-companions.md §3.1）在手机上的纯逻辑：哪一行能在主力电脑离线时
 * 打开云端对话、同一伙伴只在主力电脑名下列一行（没见过的主力电脑补一行离线入口）、换电脑后的等待与超时。
 * 不触碰网络或界面，便于单测。
 */
import { isMobilePlatform } from '@cindy/maker-shared/device-list';
import type { RemoteResourceAvatar } from '@cindy/device-link';
import type { HostedRemoteCollectionItem } from '@/device-link/remoteResources';
import { chatCursor, chatMessageText, type ChatActor, type ChatMessage, type ChatSetHomeResult } from './chatServerClient';

/** How long the phone waits for the new main computer to list the companion. */
export const CLOUD_SWITCH_TIMEOUT_MS = 90_000;
/** Roster re-read cadence while waiting (pushes usually arrive first). */
export const CLOUD_SWITCH_POLL_MS = 5_000;

/** The account's companion actor for this roster row, when that row's computer is its main computer. */
export function cloudActorForRow(actors: readonly ChatActor[], row: HostedRemoteCollectionItem): ChatActor | null {
  if (row.item.ref.kind !== 'bot' || !row.host.deviceId) return null;
  return actors.find(actor => actor.kind === 'bot' && actor.externalId === row.item.ref.id
    && actor.homeDeviceId === row.host.deviceId) ?? null;
}

const TEAMMATES = 'teammates';
/** Revision of a row built from the cloud actor alone (its computer never listed it here). */
export const CLOUD_ROW_REVISION = 'cloud';

function cloudAvatar(actor: ChatActor): RemoteResourceAvatar {
  const fallbackText = Array.from(actor.name.trim())[0] ?? 'C';
  const value = actor.avatar ?? '';
  const kind = value.startsWith('cindy://avatar/') ? 'asset' : value && !/^https?:/.test(value) ? 'emoji' : 'text';
  return { kind, value: kind === 'text' ? fallbackText : value, fallbackText };
}

/**
 * One row per companion, under its main computer: rows other computers still list for a
 * companion whose main computer is known (old copies, often cached while that computer is
 * offline) are dropped, and a main computer this phone has no row from (e.g. a new phone while
 * it is offline) gets a row built from the cloud actor, so the cloud conversation can open.
 * Without a known main computer every row stays as listed.
 */
export function cloudCompanionRows(items: readonly HostedRemoteCollectionItem[], actors: readonly ChatActor[],
  deviceNames: ReadonlyMap<string, string> = new Map()): HostedRemoteCollectionItem[] {
  const homes = new Map<string, ChatActor>();
  for (const actor of actors) if (actor.kind === 'bot' && actor.externalId && actor.homeDeviceId) homes.set(actor.externalId, actor);
  const listed = items.filter(row => {
    const home = row.item.ref.kind === 'bot' ? homes.get(row.item.ref.id)?.homeDeviceId : undefined;
    return !home || home === row.host.deviceId;
  });
  const added = [...homes.values()].flatMap((actor): HostedRemoteCollectionItem[] => {
    const deviceId = actor.homeDeviceId!;
    if (listed.some(row => row.item.ref.kind === 'bot' && row.item.ref.id === actor.externalId && row.host.deviceId === deviceId)) return [];
    const ref = { collectionId: TEAMMATES, kind: 'bot', id: actor.externalId };
    return [{ key: JSON.stringify([deviceId, ref.collectionId, ref.kind, ref.id]), host: { deviceId, deviceName: deviceNames.get(deviceId) ?? deviceId },
      item: { ref, display: { title: actor.name, avatar: cloudAvatar(actor) }, links: [], revision: CLOUD_ROW_REVISION } }];
  });
  return [...listed, ...added];
}

export interface CloudSwitchCandidate { deviceId: string; name: string }

/** Computers the companion can move to: online, remote control allowed, not a phone, not the current home. */
export function cloudSwitchCandidates(
  devices: readonly { canOpen: boolean; device: { deviceId: string; name: string; platform: string | null } }[],
  currentHome: string | null,
): CloudSwitchCandidate[] {
  return devices.filter(row => row.canOpen && !isMobilePlatform(row.device.platform) && row.device.deviceId !== currentHome)
    .map(row => ({ deviceId: row.device.deviceId, name: row.device.name }));
}

/** Computers the home offers for the companion (its own view), never the home or this phone. */
export function cloudHomeTargets<T extends { deviceId: string; online: boolean }>(targets: readonly T[], home: string, self: string | null): T[] {
  return targets.filter(target => target.online && target.deviceId !== home && target.deviceId !== self);
}

export interface CloudMessage { id: string; fromCompanion: boolean; text: string; createdAt: number }

/** Oldest first, deduplicated; the companion's actor wrote its replies, everyone else is the owner. */
export function cloudCompanionMessages(messages: readonly ChatMessage[], actorId: string): CloudMessage[] {
  const unique = [...new Map(messages.map(message => [message.id, message])).values()]
    .filter(message => !message.deleted && !message.threadRootId && message.origin !== 'system');
  // Message time first: older history uploaded later (backfill, merges) arrives after newer messages.
  unique.sort((a, b) => {
    const time = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    if (Number.isFinite(time) && time !== 0) return time;
    const left = BigInt(chatCursor(a.seq)); const right = BigInt(chatCursor(b.seq));
    return left < right ? -1 : left > right ? 1 : 0;
  });
  return unique.flatMap(message => {
    const text = chatMessageText(message).trim();
    return text ? [{ id: message.id, fromCompanion: message.authorId === actorId, text, createdAt: Date.parse(message.createdAt) }] : [];
  });
}

/** What the phone shows while (and after) asking another computer to take over. */
export type CloudSwitchState =
  | { phase: 'idle' }
  | { phase: 'requesting'; target: CloudSwitchCandidate }
  | { phase: 'waiting'; target: CloudSwitchCandidate; since: number }
  | { phase: 'timeout'; target: CloudSwitchCandidate }
  | { phase: 'conflict'; homeDeviceId: string | null }
  | { phase: 'failed'; target: CloudSwitchCandidate };

/** The server's answer to the compare-and-set. */
export function cloudSwitchAfterSetHome(target: CloudSwitchCandidate, result: ChatSetHomeResult, now: number): CloudSwitchState {
  if (result.ok) return { phase: 'waiting', target, since: now };
  // Another device moved it to exactly this computer: wait for it just the same.
  if (result.homeDeviceId === target.deviceId) return { phase: 'waiting', target, since: now };
  return { phase: 'conflict', homeDeviceId: result.homeDeviceId };
}

/**
 * The new main computer's row for the companion, once that computer lists it in a read made
 * while waiting (`answered`). A cached row (it ran there before) is not proof the take-over finished.
 */
export function cloudSwitchArrival<T extends HostedRemoteCollectionItem>(items: readonly T[], deviceId: string, botId: string,
  answered: (row: T) => boolean): T | null {
  return items.find(row => row.item.ref.kind === 'bot' && row.host.deviceId === deviceId && row.item.ref.id === botId && answered(row)) ?? null;
}

/** One waiting tick: open the arrived row, give up after the timeout, otherwise keep waiting. */
export function cloudSwitchTick<T extends HostedRemoteCollectionItem>(state: CloudSwitchState, items: readonly T[], botId: string, now: number,
  answered: (row: T) => boolean, timeoutMs = CLOUD_SWITCH_TIMEOUT_MS): { state: CloudSwitchState; arrived: T | null } {
  if (state.phase !== 'waiting') return { state, arrived: null };
  const arrived = cloudSwitchArrival(items, state.target.deviceId, botId, answered);
  if (arrived) return { state: { phase: 'idle' }, arrived };
  if (now - state.since >= timeoutMs) return { state: { phase: 'timeout', target: state.target }, arrived: null };
  return { state, arrived: null };
}
