import { and, eq, isNull } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { botProfileVersions, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';

const SESSION_PERMISSION_MODES = new Set([
  'ask',
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'bypassPermissions',
]);

export function isSessionPermissionMode(mode: string): boolean {
  return SESSION_PERMISSION_MODES.has(mode);
}

/** Profile stores only the three teammate permission values. Other session modes stay on the session row. */
export function profilePermissionForSessionMode(mode: string): 'ask' | 'auto' | 'trusted' | null {
  if (mode === 'bypassPermissions') return 'trusted';
  if (mode === 'auto') return 'auto';
  if (mode === 'ask') return 'ask';
  return null;
}

/**
 * Persist a permission change when the Maker runtime is not loaded.
 * Returns false only when the mode is invalid or the session row does not exist.
 */
export async function persistPermissionModeWithoutRuntime(
  sessionId: string,
  mode: string,
): Promise<boolean> {
  if (!isSessionPermissionMode(mode)) return false;
  const db = getDbClient().drizzle;
  // The session row is what the next runtime reads. Write it before the profile
  // mirror; a profile sync failure must not turn a saved chat permission into a no-op.
  const [updated] = await db.update(sessions).set({
    permissionMode: mode as typeof sessions.$inferInsert.permissionMode,
    updatedAt: Date.now(),
  }).where(eq(sessions.id, sessionId)).returning({ id: sessions.id });
  if (!updated) return false;
  const profilePermission = profilePermissionForSessionMode(mode);
  if (!profilePermission) return true;
  try {
    const [link] = await db.select({ botId: botSessionLinks.botId }).from(botSessionLinks).where(and(
      eq(botSessionLinks.sessionId, sessionId),
      eq(botSessionLinks.role, 'canonical'),
      isNull(botSessionLinks.archivedAt),
    )).limit(1);
    if (!link) return true;
    const [profile] = await db.select({ version: botProfiles.currentVersion })
      .from(botProfiles).where(eq(botProfiles.id, link.botId)).limit(1);
    if (!profile) return true;
    const [version] = await db.select({ capabilitiesJson: botProfileVersions.capabilitiesJson })
      .from(botProfileVersions).where(and(
        eq(botProfileVersions.botId, link.botId),
        eq(botProfileVersions.version, profile.version),
      )).limit(1);
    if (!version) return true;
    const parsed = JSON.parse(version.capabilitiesJson) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return true;
    const config = parsed as Record<string, unknown>;
    if (config.permissions === profilePermission) return true;
    await db.update(botProfileVersions).set({
      capabilitiesJson: JSON.stringify({ ...config, permissions: profilePermission }),
    }).where(and(
      eq(botProfileVersions.botId, link.botId),
      eq(botProfileVersions.version, profile.version),
    ));
  } catch (error) {
    console.warn('teammate permission profile sync failed after session write', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}
