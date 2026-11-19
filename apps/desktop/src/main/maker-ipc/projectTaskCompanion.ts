import path from 'node:path';
import { resolveMemoryScopeKey } from '@cindy/maker-core';
import { readBotProjectMode } from '../../shared/botProjectMode.js';
import { botProfileDir } from './botProfileFolder.js';
import { and, eq, sql } from 'drizzle-orm';
import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { getCurrentDbClientSnapshot, getDbClient } from '../localDb/client/current.js';
import { botProfiles, botProfileVersions, projectTaskCompanions, sessions } from '../localDb/schema.js';
import { isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../appSessionState.js';
import { isCompanionShadowed } from '../companion-cloud/homes.js';
import { isSessionSharedTaskActive } from '../device-link/sharedTaskDispatch.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { supportsProjectTaskCompanion } from '../../shared/projectTaskCompanion.js';
import { buildBotProfileContextPrompt, buildBotProfilePrompt, buildBotUserProfilePrompt } from './botProfileRuntime.js';

export function captureProjectCompanionOwner() {
  const owner = getCurrentDbClientSnapshot();
  const assertCurrent = () => {
    if (!owner || isAppSessionBoundaryPending() || getCurrentDbClientSnapshot() !== owner)
      throwIpcError('PRECONDITION_FAILED', 'Account changed');
  };
  assertCurrent();
  return assertCurrent;
}

export async function readProjectCompanionSelection(sessionId: string) {
  const [choice] = await getDbClient().drizzle.select({
    botId: projectTaskCompanions.botId, revision: projectTaskCompanions.revision, displayName: botProfiles.displayName,
  }).from(projectTaskCompanions).leftJoin(botProfiles, eq(botProfiles.id, projectTaskCompanions.botId))
    .where(eq(projectTaskCompanions.sessionId, sessionId)).limit(1);
  return choice ?? { botId: null, displayName: null, revision: 0 };
}

export async function readProjectCompanionTask(sessionId: string) {
  const [task] = await getDbClient().drizzle.select({
    agentKind: sessions.agentKind, model: sessions.model, providerId: sessions.providerId,
    status: sessions.status, source: sessions.source, workspaceKind: sessions.workspaceKind,
    workingDir: sessions.workingDir, remoteHostId: sessions.remoteHostId, agentDeviceId: sessions.agentDeviceId,
    orcaRole: sessions.orcaRole, clearedAt: sessions.clearedAt,
    shared: sql<number>`EXISTS (SELECT 1 FROM shared_task_events e WHERE e.session_id = "sessions"."id"
      AND NOT EXISTS (SELECT 1 FROM shared_task_events closed WHERE closed.shared_task_id = e.shared_task_id AND closed.terminal = 1))`,
  }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  if (!task || task.shared || !supportsProjectTaskCompanion(task) || isSessionSharedTaskActive(sessionId))
    throwIpcError('PRECONDITION_FAILED', 'Conversation partners require a private local project task');
  return task;
}

export async function readProjectCompanionProfile(botId: string) {
  const [profile] = await getDbClient().drizzle.select({
    displayName: botProfiles.displayName, description: botProfiles.description, status: botProfiles.status,
    profileVersion: botProfiles.currentVersion, identitySource: botProfileVersions.identitySource,
    capabilities: botProfileVersions.capabilitiesJson,
  }).from(botProfiles).innerJoin(botProfileVersions, and(eq(botProfileVersions.botId, botProfiles.id),
    eq(botProfileVersions.version, botProfiles.currentVersion))).where(eq(botProfiles.id, botId)).limit(1);
  if (!profile || profile.status !== 'active' || isCompanionShadowed(botId))
    throwIpcError('PRECONDITION_FAILED', 'Conversation partner unavailable. Choose a partner in the task menu.');
  const config = JSON.parse(profile.capabilities) as Record<string, unknown>;
  return { ...profile, memory: config.memory !== false, projectMode: readBotProjectMode(config),
    userContext: typeof config.userContextSource === 'string' ? config.userContextSource : '' };
}

export async function hydrateProjectCompanion(opts: MakerSessionCreateOpts, sessionId: string) {
  const assertCurrent = captureProjectCompanionOwner();
  const choice = await readProjectCompanionSelection(sessionId);
  assertCurrent();
  if (!choice.botId) return;
  if (opts.remoteHostId || opts.agentDeviceId) throwIpcError('PRECONDITION_FAILED', 'Conversation partner requires the local computer');
  await readProjectCompanionTask(sessionId);
  const profile = await readProjectCompanionProfile(choice.botId);
  assertCurrent();
  let memoryPrompt = '';
  if (profile.memory) {
    const home = profile.projectMode && opts.makerMemoryEnabled && opts.workingDir
      ? path.join(botProfileDir(ownerScopedUserDataPath(), choice.botId), 'workspace') : null;
    const sharedStore = home && (await resolveMemoryScopeKey(home) ===
      (opts.makerMemoryScopeKey ?? await resolveMemoryScopeKey(opts.workingDir)));
    assertCurrent();
    memoryPrompt = sharedStore
      ? 'Your project memory and companion notes share this store. Read and save each note once using project memory.'
      : 'Project memory belongs to this project. For your own companion notes, use project_companion_memory in cindy_helper. Read notes as needed. Save a cross-project preference only when the user explicitly asks you to remember it across projects.';
  }
  opts.projectCompanion = { botId: choice.botId, revision: choice.revision,
    profileVersion: profile.profileVersion, displayName: profile.displayName };
  opts.botProfilePrompt = buildBotProfilePrompt(profile);
  opts.botProfileContextPrompt = [
    buildBotProfileContextPrompt(profile.displayName),
    memoryPrompt,
  ].filter(Boolean).join('\n\n');
  opts.botUserProfilePrompt = buildBotUserProfilePrompt(profile.userContext);
}

export async function verifyProjectCompanion(sessionId: string, author: NonNullable<MakerSessionCreateOpts['projectCompanion']>) {
  const assertCurrent = captureProjectCompanionOwner();
  await readProjectCompanionTask(sessionId);
  const choice = await readProjectCompanionSelection(sessionId);
  if (choice.botId !== author.botId || choice.revision !== author.revision)
    throwIpcError('PRECONDITION_FAILED', 'Conversation partner changed');
  const profile = await readProjectCompanionProfile(author.botId);
  assertCurrent();
  if (profile.profileVersion !== author.profileVersion)
    throwIpcError('PRECONDITION_FAILED', 'Conversation partner settings changed. Select the partner again.');
  return profile;
}
