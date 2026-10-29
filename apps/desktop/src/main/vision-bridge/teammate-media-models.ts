import { and, eq, isNull } from 'drizzle-orm';
import { parseTeammateMediaModels, effectiveTeammateVision, type TeammateMediaModels } from '@cindy/maker-shared/teammate-media-models';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { botProfiles, botProfileVersions, botSessionLinks, sessions } from '../localDb/schema.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { readVisionBridgeSettings } from './vision-bridge-settings-store.js';

/** Ownership comes exclusively from the Host's session link, including group/channel lanes. */
export async function readSessionMediaModels(sessionId?: string): Promise<{
  scope: string; overrides: TeammateMediaModels | null;
}> {
  if (!sessionId) return { scope: '', overrides: null };
  if (isAppSessionBoundaryPending()) throw new Error('Media settings owner changed');
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot) throw new Error('Media settings owner unavailable');
  const [row] = await snapshot.client.drizzle.select({ botId: botProfiles.id, config: botProfileVersions.capabilitiesJson })
    .from(botSessionLinks)
    .innerJoin(sessions, and(eq(sessions.id, botSessionLinks.sessionId), eq(sessions.source, 'bot')))
    .innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
    .innerJoin(botProfileVersions, and(eq(botProfileVersions.botId, botProfiles.id), eq(botProfileVersions.version, botProfiles.currentVersion)))
    .where(and(eq(botSessionLinks.sessionId, sessionId), isNull(botSessionLinks.archivedAt))).limit(1);
  if (isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== snapshot) throw new Error('Media settings owner changed');
  return { scope: JSON.stringify([snapshot.userId, snapshot.clientEpoch, row?.botId ?? null]),
    overrides: row ? parseTeammateMediaModels(JSON.parse(row.config).mediaModels) : null };
}

export async function readSessionVisionSettings(sessionId?: string) {
  const context = await readSessionMediaModels(sessionId);
  return { scope: context.scope, settings: effectiveTeammateVision(readVisionBridgeSettings(), context.overrides) };
}
