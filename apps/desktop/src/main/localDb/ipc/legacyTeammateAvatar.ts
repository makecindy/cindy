import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { app } from 'electron';
import type { DbClient } from '../client/DbClient.js';
import { createLogger } from '../../logger.js';
import { storeTeammateAvatarImage, validateBotAvatarBuffer } from './botAvatarSelection.js';

const log = createLogger('legacy-teammate-avatar');
const legacyFiles: Record<string, string> = {
  'cindy://avatar/preset/dash': 'dash.png',
  'cindy://avatar/preset/lizi': 'lizi.png',
};

/** Upgrade by stored address, never by name or template: user replacements remain untouched. */
export async function migrateLegacyTeammateAvatar(
  client: Pick<DbClient, 'drizzle' | 'tx'>,
  profile: { id: string; avatar: string; currentVersion: number },
  assertCurrent: () => void,
): Promise<boolean> {
  const filename = legacyFiles[profile.avatar.trim().toLowerCase()];
  if (!filename) return false;
  try {
    assertCurrent();
    const root = app.isPackaged ? process.resourcesPath : path.join(app.getAppPath(), 'resources');
    const buffer = await fs.readFile(path.join(root, 'legacy-teammate-avatars', filename));
    const written = await storeTeammateAvatarImage({ buffer, mimeType: validateBotAvatarBuffer(buffer) }, client.drizzle, assertCurrent);
    // No profile version or activity-time change. The ref and address either both
    // commit or neither does; a concurrent user replacement wins even at the same version.
    await client.tx('bots.updateProfile', {
      id: profile.id, avatar: written.url,
      expectedAvatar: profile.avatar, expectedCurrentVersion: profile.currentVersion,
      identitySource: '', capabilitiesJson: '{}', profileContentChanged: false,
      botAvatarRef: { id: randomUUID(), hash: written.hash, createdAt: Date.now() },
      preserveUpdatedAt: true, now: Date.now(),
    });
    assertCurrent();
  } catch (error) {
    assertCurrent();
    // Leave the legacy value usable through the compatibility image and retry on
    // the next read. Failed/raced imports use the existing zero-ref recycler grace period.
    log.warn('legacy avatar migration deferred', { error: error instanceof Error ? error.name : typeof error });
  }
  // Re-read even after a lost race: return the user's current avatar, never this stale snapshot.
  return true;
}
