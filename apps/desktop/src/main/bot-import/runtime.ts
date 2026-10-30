import { and, eq, isNull, ne } from 'drizzle-orm';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { botSessionLinks, botProfiles, sessions } from '../localDb/schema.js';
import { botEnvironmentSecretIo } from '../secrets/providerSecretStore.js';
import { createCompanionEnvironmentStore } from './environment.js';
import { projectEnvironmentDiscovery } from './environmentJson.js';
import { fingerprint } from './files.js';
import { CompanionImportError } from './types.js';
import { removeImportedMemoryMedia } from './memoryMedia.js';
import { closeInvalidImportedConnections } from './connections.js';

// Bot IDs are not reused. Retain a process-local deletion fence so a delayed DB
// read or saved runtime scope cannot reopen a deleted companion's connection.
const deletedCompanions = new Set<string>();
const companionKey = (root: string, botId: string) => fingerprint([root, botId]);

export const companionEnvironmentStore = createCompanionEnvironmentStore({
  has: key => botEnvironmentSecretIo.has(key),
  read: (key, assertOwner) => botEnvironmentSecretIo.read(key, assertOwner),
  write: (key, value, assertOwner) => botEnvironmentSecretIo.write(key, value, assertOwner),
  remove: key => botEnvironmentSecretIo.remove(key),
  removeResources: removeImportedMemoryMedia,
});

/** Called only after profile deletion commits; failed deletions retain access. */
export async function finishCompanionEnvironmentRemoval(root: string, botId: string, assertOwner: () => void): Promise<void> {
  assertOwner();
  deletedCompanions.add(companionKey(root, botId));
  await closeInvalidImportedConnections();
  assertOwner();
  await companionEnvironmentStore.finishRemoval(root, botId, assertOwner);
}

export async function recoverCompanionEnvironmentRemovals(): Promise<void> {
  const owner = activeOwnerScopeKey();
  const root = ownerScopedUserDataPath();
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner) throw new CompanionImportError('OWNER_CHANGED');
  };
  assertOwner();
  const db = getDbClient().drizzle;
  await companionEnvironmentStore.recoverRemovals(root, assertOwner, async botId => {
    const [profile] = await db.select({ id: botProfiles.id }).from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    return !!profile;
  });
}

/** Resolve from the main-owned session link, never from a renderer-supplied Bot ID or path. */
export async function readCompanionSessionScope(sessionId: string) {
  const owner = activeOwnerScopeKey();
  const userData = ownerScopedUserDataPath();
  let botId: string | undefined;
  const assertOwner = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== owner)
      throw new CompanionImportError('OWNER_CHANGED');
    if (botId && deletedCompanions.has(companionKey(userData, botId)))
      throw new CompanionImportError('COMPANION_DELETED');
  };
  assertOwner();
  const [link] = await getDbClient().drizzle.select({ botId: botSessionLinks.botId })
    .from(botSessionLinks).innerJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId)).innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId)).where(and(eq(botSessionLinks.sessionId, sessionId), isNull(botSessionLinks.archivedAt), eq(botProfiles.status, 'active'), eq(sessions.status, 'active'), ne(botSessionLinks.role, 'history'))).limit(1);
  botId = link?.botId;
  assertOwner();
  if (!link) return undefined;
  return { owner, assertOwner, botId: link.botId, userData };
}

export async function readCompanionSessionEnvironment(sessionId: string) {
  const scope = await readCompanionSessionScope(sessionId);
  if (!scope) return undefined;
  const { owner, userData, botId, assertOwner } = scope;
  const environment = await companionEnvironmentStore.read(userData, botId, assertOwner);
  if (!environment) return undefined;
  return { identity: fingerprint([owner, botId, projectEnvironmentDiscovery(environment).identity]), environment, assertOwner, botId, userData };
}

export async function readCompanionSessionDiscovery(sessionId: string) {
  const scope = await readCompanionSessionScope(sessionId);
  if (!scope) return undefined;
  const { owner, userData, botId, assertOwner } = scope;
  const environment = await companionEnvironmentStore.readDiscovery(userData, botId, assertOwner);
  if (!environment) return undefined;
  return { identity: fingerprint([owner, botId, environment.identity]), environment, assertOwner, botId, userData };
}

export async function resolveCompanionRuntimeEnvironment(sessionId: string) {
  const result = await readCompanionSessionDiscovery(sessionId);
  return result ? { identity: result.identity, assertCurrent: result.assertOwner } : undefined;
}
