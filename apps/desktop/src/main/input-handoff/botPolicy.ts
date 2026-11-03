import { and, eq } from 'drizzle-orm';
import { getDbClient } from '../localDb/client/current.js';
import { botProfiles, botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';

/**
 * Whether the owner turned 代输入 off for the teammate behind this task.
 * Ordinary tasks are never affected. Reads the teammate's current profile
 * (not the version a delegation was pinned to), so turning it off applies at
 * once to every running task of that teammate.
 */
export async function isInputHandoffDisabledForSession(sessionId: string): Promise<boolean> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({ config: botProfileVersions.capabilitiesJson })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .innerJoin(
      botProfileVersions,
      and(eq(botProfileVersions.botId, botProfiles.id), eq(botProfileVersions.version, botProfiles.currentVersion)),
    )
    .where(and(eq(botSessionLinks.sessionId, sessionId), eq(sessions.source, 'bot')))
    .limit(1);
  if (!row) return false;
  return readInputHandoffSetting(row.config) === false;
}

/** `inputHandoff` in a teammate's capabilities JSON; missing or unreadable means allowed. */
export function readInputHandoffSetting(capabilitiesJson: string): boolean {
  try {
    const parsed = JSON.parse(capabilitiesJson) as unknown;
    if (parsed && typeof parsed === 'object' && (parsed as { inputHandoff?: unknown }).inputHandoff === false) return false;
  } catch {
    /* unreadable profile: keep the default */
  }
  return true;
}
