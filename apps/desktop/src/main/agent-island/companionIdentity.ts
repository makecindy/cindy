import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import { and, eq, inArray } from 'drizzle-orm';
import sharp from 'sharp';
import type { AgentIslandCompanionSnapshot } from '../../shared/agentIsland.js';
import { parseBotGroupIdFromRouteKey } from '../../shared/botGroupChat.js';
import { botAvatarInitial, normalizeBotAvatarHue } from '../../shared/botAvatarHue.js';
import { BOT_AVATAR_MAX_BYTES, isManagedBotAvatarUrl, isSingleBotAvatarGrapheme } from '../../shared/botAvatarValue.js';
import { resolveSafe } from '../cindy-media/blobStore.js';
import { getDbClient } from '../localDb/client/current.js';
import { botGroups, botProfiles, botSessionLinks } from '../localDb/schema.js';
import { encodeNotificationAvatar } from '../notificationAvatar.js';

export interface AgentIslandCompanionIdentity {
  botId: string;
  /** Set for a group lane: a rename of that group changes what the card shows. */
  groupId?: string;
  companion: AgentIslandCompanionSnapshot;
}

/** Links that speak as the companion; delegated executions stay ordinary tasks. */
const COMPANION_SPEAKING_ROLES = ['canonical', 'history', 'thread', 'group', 'channel'] as const;

/**
 * Bundled preset artwork, relative to the packaged resources directory. The Cindy portrait is a
 * byte copy of `src/renderer/assets/bot-presets/cindy.png`: that path is also read by the mobile
 * notification plugin and its fingerprint config, so it must not move, while main can only read
 * files shipped as resources (the renderer bundle inlines its asset).
 */
const PRESET_AVATAR_FILES: Readonly<Record<string, string>> = {
  'cindy://avatar/preset/cindy': 'companion-preset-avatars/cindy.png',
  'cindy://avatar/preset/dash': 'legacy-teammate-avatars/dash.png',
  'cindy://avatar/preset/lizi': 'legacy-teammate-avatars/lizi.png',
};

/**
 * Local copy of an avatar held by another computer or the cloud. Registered at startup
 * (bootstrap) rather than imported: the avatar cache pulls in the media store and device-link,
 * which this module must not load (and main forbids runtime dynamic imports).
 */
type CompanionAvatarResolver = (request: { avatar: string; deviceId: string | null; fetch: boolean }) => Promise<string | null>;
let resolveCompanionAvatarCopy: CompanionAvatarResolver | null = null;

export function setCompanionAvatarResolver(resolver: CompanionAvatarResolver | null): void {
  resolveCompanionAvatarCopy = resolver;
}

const THUMBNAIL_CACHE_LIMIT = 32;
// Content-addressed avatar values: a changed avatar is a new key, never a stale hit.
const thumbnails = new Map<string, Promise<string | undefined>>();

/** The companion a Bot Session speaks for, or null for every other Session. */
export async function readAgentIslandCompanion(sessionId: string): Promise<AgentIslandCompanionIdentity | null> {
  const db = getDbClient().drizzle;
  const row = await db
    .select({
      botId: botProfiles.id,
      name: botProfiles.displayName,
      avatar: botProfiles.avatar,
      avatarColor: botProfiles.avatarColor,
      role: botSessionLinks.role,
      routeKey: botSessionLinks.routeKey,
    })
    .from(botSessionLinks)
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .where(and(
      eq(botSessionLinks.sessionId, sessionId),
      inArray(botSessionLinks.role, [...COMPANION_SPEAKING_ROLES]),
    ))
    .get();
  if (!row) return null;
  // Lane, 分工 Session and authorized Chat Server lane keys all start `group:<groupId>`.
  const groupId = row.role === 'group' ? parseBotGroupIdFromRouteKey(row.routeKey) : null;
  const group = groupId
    ? await db.select({ name: botGroups.name }).from(botGroups).where(eq(botGroups.id, groupId)).get()
    : undefined;
  const groupName = group?.name.trim();
  const base = companionSnapshotWithoutArtwork({ name: row.name, avatar: row.avatar, avatarColor: row.avatarColor, groupName });
  const imageJpeg = companionAvatarHasArtwork(row.avatar) ? await companionAvatarThumbnail(row.avatar) : undefined;
  return { botId: row.botId, ...(groupId ? { groupId } : {}), companion: imageJpeg ? { ...base, imageJpeg } : base };
}

/** Name, tint and glyph: everything but the artwork, available without any read. */
export function companionSnapshotWithoutArtwork(identity: {
  name: string;
  avatar: string;
  avatarColor: string;
  groupName?: string;
}): AgentIslandCompanionSnapshot {
  const avatar = identity.avatar.trim();
  const emoji = isSingleBotAvatarGrapheme(avatar) ? avatar : null;
  return {
    name: identity.name,
    ...(identity.groupName ? { groupName: identity.groupName } : {}),
    hue: normalizeBotAvatarHue(identity.avatarColor),
    glyph: emoji ?? botAvatarInitial(identity.name),
    glyphIsInitial: !emoji,
  };
}

export function companionAvatarHasArtwork(avatar: string): boolean {
  return !isSingleBotAvatarGrapheme(avatar.trim());
}

/**
 * Bounded JPEG of the companion's artwork. `deviceId` names the computer that holds a
 * `cindy-media://` avatar of a companion running elsewhere; it is read through this
 * computer's companion avatar copy, the same one the roster shows.
 */
export function companionAvatarThumbnail(avatar: string, deviceId?: string | null): Promise<string | undefined> {
  const key = `${deviceId ?? ''}\n${avatar.trim()}`;
  const cached = thumbnails.get(key);
  if (cached) return cached;
  const pending = encodeAvatarThumbnail(avatar.trim(), deviceId ?? null).catch(() => undefined);
  thumbnails.set(key, pending);
  if (thumbnails.size > THUMBNAIL_CACHE_LIMIT) thumbnails.delete(thumbnails.keys().next().value!);
  // Artwork is optional: a failed read falls back to the glyph and retries on the next lookup.
  void pending.then((value) => { if (!value && thumbnails.get(key) === pending) thumbnails.delete(key); });
  return pending;
}

async function encodeAvatarThumbnail(avatar: string, deviceId: string | null): Promise<string | undefined> {
  const bytes = await readAvatarBytes(avatar, deviceId);
  if (!bytes) return undefined;
  const encoded = await encodeNotificationAvatar(bytes, sharp);
  return encoded?.kind === 'jpeg' ? encoded.value : undefined;
}

async function readAvatarBytes(avatar: string, deviceId: string | null): Promise<Buffer | undefined> {
  const preset = PRESET_AVATAR_FILES[avatar.toLowerCase()];
  if (preset) {
    const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    return readFile(path.join(root, preset));
  }
  let local: string | null = isManagedBotAvatarUrl(avatar) && !deviceId ? avatar : null;
  if (!local && (deviceId || avatar.startsWith('https://'))) {
    local = (await resolveCompanionAvatarCopy?.({ avatar, deviceId, fetch: true })) ?? null;
  }
  if (!local || !isManagedBotAvatarUrl(local)) return undefined;
  const bytes = await readFile(resolveSafe(local).absPath);
  return bytes.length > BOT_AVATAR_MAX_BYTES ? undefined : bytes;
}
