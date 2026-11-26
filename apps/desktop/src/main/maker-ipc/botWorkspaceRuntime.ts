import { stat } from 'node:fs/promises';

import { app } from 'electron';
import { and, eq } from 'drizzle-orm';

import { ensureDialogueWorkspaceDir, isManagedDialogueWorkspace } from '../localDb/dialogueWorkspace.js';
import { teammateWorkspaceDir } from './botProjectMemory.js';
import { registeredTaskProject } from '../mcp-integrations/projectManagementCore.js';
import type { MakerSessionCreateOpts } from './sessionRequest.js';
import { ensureBotChatOnlyWorkspaceDir, ensureBotWorkspaceDir } from './botProfileFolder.js';
import { getDbClient } from '../localDb/client/current.js';
import { botGroupPlans, botProfileVersions, botProfiles, botSessionLinks, sessions } from '../localDb/schema.js';
import { readBotProjectMode } from '../../shared/botProjectMode.js';
import { ownerScopedUserDataPath } from '../appSessionState.js';
import { botGroupPlanRouteKey, groupLaneOfRouteKey, groupLaneUsesChatWorkspace, parseBotGroupPlanRouteKey } from '../../shared/botGroupChat.js';

export interface BotWorkspaceRuntimeDeps {
  ensureWorkspaceDir?: typeof ensureBotWorkspaceDir;
  registeredProject?: typeof registeredTaskProject;
  dialogueWorkspace?: typeof ensureDialogueWorkspaceDir;
  ownerUserDataPath?: () => string;
  legacyUserDataPath?: () => string;
  isDirectory?: (dir: string) => Promise<boolean>;
}

/** Opening a chat may allocate a dialogue directory, never the missing project of a buddy. */
export async function privateBotWorkspace(botId: string, projectMode: boolean, deps: BotWorkspaceRuntimeDeps = {}) {
  const root = (deps.ownerUserDataPath ?? ownerScopedUserDataPath)();
  if (projectMode) {
    const projectDir = await (deps.registeredProject ?? registeredTaskProject)(teammateWorkspaceDir(root, botId));
    return { projectDir, workspaceKind: projectDir ? 'project' as const : 'dialogue' as const, workingDir: projectDir ?? undefined };
  }
  const workingDir = await (deps.ensureWorkspaceDir ?? ensureBotWorkspaceDir)(root, botId, (deps.legacyUserDataPath ?? (() => app.getPath('userData')))());
  return { projectDir: null, workspaceKind: 'dialogue' as const, workingDir };
}

export class BotPlanWorkDirUnavailableError extends Error {
  readonly code = 'BOT_GROUP_WORKDIR_UNAVAILABLE';
  constructor() {
    super('分工的工作目录不可用');
  }
}

async function isExistingDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Restore the recorded execution directory on start and resume. Private conversations use
 * the buddy's workspace, group tasks use their own selected workspace, and chat-only
 * grants always use an isolated directory. A missing plan workspace stops that step.
 */
export async function prepareBotWorkspaceRuntime(
  opts: MakerSessionCreateOpts,
  deps: BotWorkspaceRuntimeDeps = {},
): Promise<void> {
  const sessionId = opts.id;
  if (!sessionId) return;

  const db = getDbClient().drizzle;
  const link = await db
    .select({ botId: botSessionLinks.botId, role: botSessionLinks.role, routeKey: botSessionLinks.routeKey })
    .from(botSessionLinks)
    .where(eq(botSessionLinks.sessionId, sessionId))
    .limit(1);
  const botId = link[0]?.botId;
  if (!botId) return;

  const ownerUserDataPath = deps.ownerUserDataPath ?? ownerScopedUserDataPath;
  const groupRouteKey = link[0]?.role === 'group' ? link[0].routeKey : null;
  const [lane] = groupRouteKey ? await db.select({
    workingDir: sessions.workingDir, workspaceKind: sessions.workspaceKind, projectDir: sessions.projectDir,
  }).from(sessions).where(eq(sessions.id, sessionId)).limit(1) : [];
  if (groupRouteKey && groupLaneUsesChatWorkspace(groupRouteKey)) {
    opts.workingDir = await ensureBotChatOnlyWorkspaceDir(ownerUserDataPath(), botId, groupLaneOfRouteKey(groupRouteKey));
    opts.workspaceKind = 'dialogue';
    opts.projectDir = lane?.projectDir ?? undefined;
    opts.remoteHostId = undefined;
    return;
  }

  const planRoute = parseBotGroupPlanRouteKey(groupRouteKey);
  if (planRoute) {
    let workDir: string | null | undefined;
    if (groupRouteKey === botGroupPlanRouteKey(planRoute.groupId, planRoute.planId)) {
      const [plan] = await db
        .select({ groupId: botGroupPlans.groupId, workDir: botGroupPlans.workDir })
        .from(botGroupPlans)
        .where(eq(botGroupPlans.id, planRoute.planId))
        .limit(1);
      workDir = plan && plan.groupId === planRoute.groupId ? plan.workDir : null;
    } else {
      // A server plan's local workspace is recorded when its access-scoped lane
      // is created. Never resolve a coincidentally matching legacy plan id.
      workDir = lane?.workingDir;
    }
    const isDirectory = deps.isDirectory ?? isExistingDirectory;
    if (!workDir || !(await isDirectory(workDir))) throw new BotPlanWorkDirUnavailableError();
    opts.workingDir = workDir;
    opts.workspaceKind = lane?.workspaceKind === 'dialogue' ? 'dialogue' : 'project';
    opts.projectDir = lane?.projectDir ?? undefined;
    opts.remoteHostId = undefined;
    return;
  }

  if (groupRouteKey && lane?.workingDir) {
    const isDirectory = deps.isDirectory ?? isExistingDirectory;
    if (!(await isDirectory(lane.workingDir))) throw new BotPlanWorkDirUnavailableError();
    opts.workingDir = lane.workingDir;
    opts.workspaceKind = lane.workspaceKind === 'dialogue' ? 'dialogue' : 'project';
    opts.projectDir = lane.projectDir ?? undefined;
    opts.remoteHostId = undefined;
    return;
  }
  const workspace = await privateBotWorkspace(botId, await readTeammateProjectMode(botId), deps);
  const [stored] = await db.select({ workspaceKind: sessions.workspaceKind, projectDir: sessions.projectDir,
    workingDir: sessions.workingDir, createdAt: sessions.createdAt }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  let dir = workspace.workingDir;
  if (!dir) {
    dir = stored?.workingDir && isManagedDialogueWorkspace(stored.workingDir) && await isExistingDirectory(stored.workingDir)
      ? stored.workingDir : (deps.dialogueWorkspace ?? ensureDialogueWorkspaceDir)(sessionId, stored?.createdAt ?? Date.now());
  }
  opts.workingDir = dir;
  opts.workspaceKind = workspace.workspaceKind;
  opts.projectDir = workspace.projectDir ?? undefined;
  opts.remoteHostId = undefined;
  if (stored && (stored.workspaceKind !== workspace.workspaceKind || stored.projectDir !== workspace.projectDir || stored.workingDir !== dir)) {
    await db.update(sessions).set({ workingDir: dir, workspaceKind: workspace.workspaceKind, projectDir: workspace.projectDir })
      .where(eq(sessions.id, sessionId));
  }
}

export async function readTeammateProjectMode(botId: string): Promise<boolean> {
  const [row] = await getDbClient().drizzle
    .select({ config: botProfileVersions.capabilitiesJson })
    .from(botProfiles)
    .innerJoin(botProfileVersions, and(
      eq(botProfileVersions.botId, botProfiles.id),
      eq(botProfileVersions.version, botProfiles.currentVersion),
    ))
    .where(eq(botProfiles.id, botId))
    .limit(1);
  try {
    return readBotProjectMode(JSON.parse(row?.config ?? '{}') as Record<string, unknown>);
  } catch {
    return false;
  }
}
