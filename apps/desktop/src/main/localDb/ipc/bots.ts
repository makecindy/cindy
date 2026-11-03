import { emitSessionCreated } from './sessionCreatedBroadcast.js';
import type { RoutineModel } from '@cindy/maker-scheduler';
import { todoAccess } from '../../maker-ipc/botTodoAccess.js';
import { botLinkedProjectAccess } from '../../maker-ipc/botLinkedProjects.js';
import type { TodoPatch } from '@cindy/maker-shared/teammate-todo';
/** Cindy Bots 的 main-side 权威数据边界。
 *
 * Bot profile 与 Session 归属只在这里写入 SQLite；renderer 只读取投影，
 * 不维护第二份资料或决定 canonical Session。
 */
import { listBotSkillsForBot } from '../../maker-ipc/botSkillService.js';
import { provisionDefaultBot } from '../../maker-ipc/botDefaultProvisioning.js';
import { BOT_TEMPLATE_PRESET_AVATARS, CINDY_DEFAULT_IDENTITY } from '../../../shared/botTemplatePreset.js';
import fs from 'node:fs/promises';
import { chooseAvatarSource } from '../../profileEdit.js';
import { toSdrAvatarImage } from '../../hdrAvatarToSdr.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { and, desc, eq, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { getDbClient, tryGetDbClient } from '../client/current';
import { notifyAgentIslandCompanionChanged } from '../agentIslandSessionPatch.js';
import type {
  BotsReparentDelegationsResult,
  BotsReplaceCanonicalSessionResult,
  BotGroupsCreateLaneResult,
} from '../client/tx/types.js';
import {
  botDelegations,
  botProfileVersions,
  botProfiles,
  botRuntimeSnapshots,
  botSessionLinks,
  messages,
  sessions,
} from '../schema';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';
import { collectPresentBotRemoteResourceSources } from './botRemoteResourceAbsence.js';
import { isIpcError } from '../../../shared/ipc-errors.js';
import { isBotVisibleRemotely } from './botRemoteVisibility.js';
import { readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch } from './botRemoteSessionAccess.js';
import { setRemoteBotSessionLookup } from '../../device-link/remoteBotSessionBoundary.js';
import { resolveBusinessSessionId } from '../../sessionIds.js';
import { ensureProjectGitInitialized } from '../../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../../maker-host/git-safety-settings-store.js';
import {
  readBotModelChainSettingsState,
  resetBotModelChainSettings,
  readEffectiveBotModelChain,
  writeBotModelChainSettings,
} from '../../maker-host/bot-model-chain-settings-store.js';
import { extractMessagePreview, sessionCreateToRow, sessionToCamel } from '../mapper.js';
import { normalizeBotToolCapabilities } from '../../../shared/botCapabilitySelection.js';
import type { BotWorkbench } from '../../../shared/botWorkbench.js';
import {
  botProfileContentChanged,
  botProfileModelSelectionChanged,
  mergeBotProfileCapabilities,
  normalizeBotProfileModelChain,
} from './botProfileVersioning.js';
import {
  botProfileDir,
  ensureBotChatOnlyWorkspaceDir,
  ensureBotWorkspaceDir,
  migrateBotProfileFolder,
  readBotProfileFolder,
  writeBotProfileFolder,
} from '../../maker-ipc/botProfileFolder.js';
import { syncBotProfileFromFolder } from '../../maker-ipc/botProfileFolderSync.js';
import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { createLogger } from '../../logger.js';
import { collectTaskResponsibilityScopes } from '../../maker-ipc/botTaskResponsibility.js';
import {
  readBotWorkbenchTaskForOwner,
  readBotResponsibilityScope,
  readBotResponsibleSessionIds,
} from '../../maker-ipc/botWorkbenchTools.js';
import {
  NEW_BOT_DEFAULT_PI_EFFORT,
  NEW_BOT_DEFAULT_PI_MODEL,
  NEW_BOT_DEFAULT_PI_PROVIDER,
} from '../../../shared/botDefaults.js';
import { normalizeBotModelChain, readBotTaskModelOverride } from '../../../shared/botModelChain.js';
import { validateTaskModel } from '../../maker-ipc/appDefaultModelControl.js';
import {
  activeOwnerScopeKey,
  isAppSessionBoundaryPending,
  ownerScopedUserDataPath,
} from '../../appSessionState.js';
import {
  isManagedBotAvatarUrl,
  isSupportedBotAvatarValue,
  portableBotAvatarOrFallback,
} from '../../../shared/botAvatarValue.js';
import { migrateLegacyTeammateAvatar } from './legacyTeammateAvatar.js';
import { MAKER_PUSH } from '../../maker-ipc/channels.js';
import { decodeBotAvatarImage, validateBotAvatarBuffer, storeTeammateAvatarImage, readDefaultTeammatePortrait } from './botAvatarSelection.js';
import {
  inferBotTemplatePresetId,
  isBotTemplatePresetId,
} from '../../../shared/botTemplatePreset.js';
import { createMessage } from './messages.js';
import { syncBotLanePermission, syncBotLinkedLanePermissions, syncBotPermissionsByBotId } from '../../maker-ipc/botPermissionSync.js';
import { withSessionPermissionChange } from '../../maker-ipc/sessionPermissionChange.js';
import { withBotPermissionChangeForBot } from '../../maker-ipc/botPermissionDispatch.js';
import { broadcastSessionPatched, restoreArchivedSessionForSend } from './sessions.js';
import { BOT_DELEGATION_CLIENT_ID } from '../../../shared/botCollaboration.js';

import { generateBotCreationDraft, readBotCreationDraft, generateBotCreationAvatar } from '../../maker-ipc/botCreationDraft.js';
import { botInvitationProgress, type BotInvitationProgress } from '../../../shared/botInvitation.js';
import type { BotPackageOpening } from '../../../shared/botMarket.js';
import { botDmThreadRouteKey, parseBotDmThreadRouteKey, type BotDmThreadSummary } from '../../../shared/botDmThread.js';
import { botGroupLaneRouteKey, botGroupPlanRouteKey, chatGroupLaneRouteKey, chatGroupTalkRouteKey, chatGroupThreadRouteKey, groupLaneOfRouteKey, parseBotGroupIdFromRouteKey, type ChatLaneAccess } from '../../../shared/botGroupChat.js';
import { queueBotInvitation as enqueueBotInvitation } from '../../maker-ipc/botInvitation.js';
import { getMakerIfReady, validateBotCapabilityAdditions } from '../../maker-host/index.js';
import type { BotCapabilityUpdate } from '../../maker-ipc/botCapabilityService.js';
import { getResolvedMainLocale } from '../../i18n.js';
import { SUPPORTED_LOCALES, type SupportedLocale } from '../../../shared/locale.js';
import { normalizeBotWelcomeContext, type BotWelcomeContext } from '../../../shared/botWelcomeContext';
import { broadcastBotRemoteResourceChanged } from '../../maker-ipc/botRemoteResourceInvalidation.js';
import { routineTools } from '../../routines/service.js';
import { createBotMemoryService } from '../../maker-ipc/botMemoryService.js';

const log = createLogger('bots');

function queueBotInvitation(botId: string, retry = false): void {
  enqueueBotInvitation(
    botId,
    { createCanonicalSession: createBotCanonicalSession, broadcastProfileChanged: broadcastBotProfileChanged,
      canStartWelcome: async config => (await readEffectiveBotModelChain(config)).length > 0 },
    retry,
  );
}

/** Bind async profile work to the account that initiated it. */
function captureBotOperationOwner() {
  const scopeKey = activeOwnerScopeKey();
  const userDataDir = ownerScopedUserDataPath();
  const assertCurrent = () => {
    if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== scopeKey) {
      throwIpcError('PRECONDITION_FAILED', '账号已切换，请在当前账号重试');
    }
  };
  assertCurrent();
  return { userDataDir, assertCurrent };
}

let botMemoryService: ReturnType<typeof createBotMemoryService> | null = null;
/**
 * 伙伴记忆页的唯一服务实例。本机设置页 IPC 与设备互联的远程设置共用它,
 * 同一条记忆的保存 / 删除串行与运行时刷新合并才不会分成两份。
 */
export function getBotMemoryService(): ReturnType<typeof createBotMemoryService> {
  botMemoryService ??= createBotMemoryService({
    async getStore(scopeKey) {
      const manager = getMakerIfReady()?.makerMemory;
      if (!manager) throwIpcError('MAKER_MEMORY_NOT_READY', 'Memory is not ready');
      return manager.getStore(scopeKey, { skipDisabledCheck: true });
    },
    async readBot(botId) {
      const owner = captureBotOperationOwner();
      const [row] = await getDbClient()
        .drizzle.select({ status: botProfiles.status, canonicalSessionId: botProfiles.canonicalSessionId })
        .from(botProfiles)
        .where(eq(botProfiles.id, botId))
        .limit(1);
      owner.assertCurrent();
      return row && row.status !== 'deleting'
        ? { canonicalSessionId: row.canonicalSessionId, assertCurrent: owner.assertCurrent }
        : null;
    },
    requestRefresh: (sessionId) => requestBotRuntimeEpochRefresh(sessionId, 'resource'),
  });
  return botMemoryService;
}

/**
 * 把这份档案摊到伙伴自己的家(`<userData>/bots/<botId>/`)。
 *
 * 分工见 botProfileFolder.ts 的开头:**文件是当前值与编辑面**(用户拿编辑器改、
 * 伙伴自己用文件工具改都落这里),**`bot_profile_versions` 行是运行时的冻结快照**
 * (任务启动认版本号,整轮不变)。所以改完文件不会让进行中的对话当场变身,而是
 * 下一轮生效 —— 契约 9.3 节要的第三种状态。
 *
 * `userContextSource` 存在 capabilities 里,但它在磁盘上有自己的位置
 * (`memories/USER.md`,与 Hermes 同路径),所以这里拆出来单独写。
 *
 * 写文件失败**不让保存整个失败**:数据库那份才是运行时读的东西,文件只影响
 * 「能不能用编辑器改」。吞掉异常但记一笔,不静默。
 */
function botUserContextSource(config: Record<string, unknown>): string {
  return typeof config.userContextSource === 'string' ? config.userContextSource : '';
}

/**
 * Seed a Bot Home that was never created (profiles from before the folder existed)
 * so any save leaves editable SOUL.md / USER.md. Idempotent: an existing SOUL.md
 * means the Home exists and nothing is touched.
 */
async function ensureBotProfileFolderSeeded(
  botId: string,
  identitySource: string,
  config: Record<string, unknown>,
  userDataDir = ownerScopedUserDataPath(),
): Promise<void> {
  try {
    await migrateBotProfileFolder(userDataDir, botId, {
      identitySource,
      userContextSource: botUserContextSource(config),
      config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== 'userContextSource')),
    }, app.getPath('userData'));
  } catch (cause) {
    log.warn('seed bot profile folder failed', { botId, error: String(cause) });
  }
}

async function syncBotProfileFolder(
  botId: string,
  patch: { identitySource?: string; userContextSource?: string },
  userDataDir = ownerScopedUserDataPath(),
): Promise<void> {
  try {
    await writeBotProfileFolder(userDataDir, botId, patch);
  } catch (cause) {
    log.warn('write bot profile folder failed', { botId, error: String(cause) });
  }
}
import { buildDefaultBotIdentity } from '../../../shared/botProfileDefaults.js';
import { coordinateBotCanonicalReplacement } from '../../maker-ipc/botCanonicalReplacementCoordinator.js';
import { coordinateBotModelSelection } from '../../maker-ipc/botModelSelectionCoordinator.js';
import { searchConversations } from '../conversationSearch.js';
import { registerBotAutonomyIpc } from '../../bot-autonomy/ipc.js';
import { signalBotAutonomyBotsChanged } from '../../bot-autonomy/botsChangedSignal.js';
import { readBotSystemSkillsOff } from '../../../shared/botSystemSkills.js';
import {
  BOT_FAILURE_REASONS,
  isBotFailureAttentionWorthy,
  type BotFailureReason,
} from '../../../shared/botFailureReason.js';

/** Sender of the latest visible message in a Bot's canonical chat. */
type BotChatRole = 'user' | 'assistant';

const MAX_TEXT = 4000;
/**
 * An avatar is either a single grapheme or a reserved `cindy://avatar/…` sentinel
 * that resolves to bundled artwork (see
 * `renderer/features/bots/botAvatarIdentity.ts`). The longest sentinel shipped
 * today is `cindy://avatar/preset/whitecat` (30 chars). Custom images are strict
 * `cindy-media://blobs/<sha>.<image-ext>` addresses produced by main; arbitrary
 * URLs, file paths and inline blobs remain outside this field's contract.
 */
const MAX_AVATAR_TEXT = 128;

function readBotAvatar(value: unknown, required = false): string {
  const avatar = readText(value, 'avatar', MAX_AVATAR_TEXT, required);
  if (!avatar && !required) return '';
  if (!isSupportedBotAvatarValue(avatar)) {
    throwIpcError('INVALID_PARAMS', 'avatar 只能是一个表情、内置角色或已上传图片');
  }
  return avatar;
}

export interface CreateBotCanonicalSessionInput {
  botId: string;
  expectedCanonicalSessionId: string | null;
  expectedProfileVersion: number;
  /** Repair a dangling profile pointer only; never renew a task that still exists. */
  recoverMissingOnly?: boolean;
}

type CreateBotCanonicalSessionResult = {
  created: boolean;
  canonicalSessionId: string;
  session: ReturnType<typeof sessionToCamel>;
};

type CanonicalLinkReconciliation = {
  status:
    | 'unchanged'
    | 'repaired-mirror'
    | 'migrated'
    | 'missing-pointer'
    | 'missing-session'
    | 'conflict';
  canonicalSessionId: string | null;
};

let createBotCanonicalSessionImpl:
  ((input: CreateBotCanonicalSessionInput, beforeCommit?: () => Promise<void>) => Promise<CreateBotCanonicalSessionResult>) | null =
  null;

/** Main-side canonical creator shared by first creation, restore and missing-task repair. */
export async function createBotCanonicalSession(
  input: CreateBotCanonicalSessionInput,
  // Host-only guard, never accepted from the IPC payload or serialized to the worker.
  beforeCommit?: () => Promise<void>,
): Promise<CreateBotCanonicalSessionResult> {
  if (!createBotCanonicalSessionImpl) {
    throwIpcError('PRECONDITION_FAILED', 'Bot 数据服务尚未初始化');
  }
  const owner = captureBotOperationOwner();
  owner.assertCurrent();
  const result = await createBotCanonicalSessionImpl(input, beforeCommit);
  owner.assertCurrent();
  return result;
}

export type EnsureBotGroupLaneResult =
  | { ok: true; sessionId: string; created: boolean }
  | { ok: false; errorCode: 'MEMBER_UNAVAILABLE' | 'NO_MODEL'; message: string };

/**
 * The Bot's hidden lane for one group chat (docs/product-rules/bot-group-chat.md).
 * Same Profile, Home workspace and model chain as the canonical Chat; never a
 * second canonical Session and never visible in the task list.
 *
 * With `plan`, the Bot's 分工 Session for that plan instead (§7.4): same Profile and
 * model chain, but it works in the plan's recorded work directory. A worktree plan
 * passes the Session id the worktree was registered for.
 *
 * With `threadRootId` (server groups only), the Bot's own lane for that Thread: same
 * Profile, model chain and working place as the group lane, but its own context.
 *
 * With `talkPlanId` (server groups only), the Bot's own lane for that queue: like a Thread
 * lane, it talks in the group lane's place with its own context; no project folder.
 */
export async function ensureBotGroupLaneSession(input: {
  botId: string;
  groupId: string;
  title: string;
  chatAccess?: ChatLaneAccess;
  plan?: { planId: string; workDir: string; sessionId?: string };
  threadRootId?: string;
  talkPlanId?: string;
  personalDigest?: boolean;
}): Promise<EnsureBotGroupLaneResult> {
  const owner = captureBotOperationOwner();
  const client = getDbClient();
  const db = client.drizzle;
  const routeKey = input.personalDigest && input.chatAccess
    ? `${chatGroupLaneRouteKey(input.groupId,input.chatAccess)}:personal-digest`
    : input.plan
    ? input.chatAccess ? `${chatGroupLaneRouteKey(input.groupId, input.chatAccess)}:plan:${input.plan.planId}` : botGroupPlanRouteKey(input.groupId, input.plan.planId)
    : input.chatAccess && input.talkPlanId ? chatGroupTalkRouteKey(input.groupId, input.chatAccess, input.talkPlanId)
    : input.chatAccess && input.threadRootId ? chatGroupThreadRouteKey(input.groupId, input.chatAccess, input.threadRootId)
    : input.chatAccess ? chatGroupLaneRouteKey(input.groupId, input.chatAccess) : botGroupLaneRouteKey(input.groupId);
  const [existing] = await db
    .select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(
      eq(botSessionLinks.botId, input.botId),
      eq(botSessionLinks.role, 'group'),
      eq(botSessionLinks.routeKey, routeKey),
      isNull(botSessionLinks.archivedAt),
      eq(sessions.source, 'bot'),
      eq(sessions.status, 'active'),
    ))
    .limit(1);
  if (existing) {
    await syncBotLanePermission(existing.sessionId);
    owner.assertCurrent();
    return { ok: true, sessionId: existing.sessionId, created: false };
  }
  const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, input.botId)).limit(1);
  if (!profile || profile.status !== 'active') {
    return { ok: false, errorCode: 'MEMBER_UNAVAILABLE', message: '伙伴当前不可用' };
  }
  const [profileVersion] = await db
    .select()
    .from(botProfileVersions)
    .where(and(
      eq(botProfileVersions.botId, input.botId),
      eq(botProfileVersions.version, profile.currentVersion),
    ))
    .limit(1);
  if (!profileVersion) return { ok: false, errorCode: 'MEMBER_UNAVAILABLE', message: '伙伴资料版本不存在' };
  const config = parseJson(profileVersion.capabilitiesJson);
  const primaryRoute = (await readEffectiveBotModelChain(config))[0] ?? null;
  if (!primaryRoute) return { ok: false, errorCode: 'NO_MODEL', message: '伙伴还没有可用模型' };
  const workspaceKind = input.plan && input.chatAccess?.mode !== 'chat' ? ('project' as const) : ('dialogue' as const);
  const workingDir = input.chatAccess?.mode === 'chat'
    ? await ensureBotChatOnlyWorkspaceDir(owner.userDataDir, input.botId, groupLaneOfRouteKey(routeKey))
    : input.plan ? input.plan.workDir : await ensureBotWorkspaceDir(owner.userDataDir, input.botId, app.getPath('userData'));
  const now = Date.now();
  const sessionId = resolveBusinessSessionId(input.plan?.sessionId);
  const row = {
    ...sessionCreateToRow(
      sessionId,
      {
        workspaceKind,
        workingDir,
        ...botSessionRouteFields(config, primaryRoute),
        remoteHostId: undefined,
        source: 'bot',
      },
      now,
    ),
    title: input.title,
  };
  const gitSafety = readGitSafetySettings();
  await ensureProjectGitInitialized({
    workingDir,
    workspaceKind,
    remoteHostId: null,
    sessionId,
    autoSnapshotEnabled: gitSafety.autoSnapshotEnabled,
    autoInitProjectGit: gitSafety.autoInitProjectGit,
    source: 'local-db:bots:create-group-lane',
  });
  owner.assertCurrent();
  const result = await client.tx<BotGroupsCreateLaneResult>('bots.createGroupLane', {
    botId: input.botId,
    groupId: input.groupId,
    routeKey,
    session: {
      id: row.id,
      title: row.title,
      workingDir: row.workingDir ?? null,
      workspaceKind: row.workspaceKind,
      model: row.model,
      effort: row.effort,
      fastMode: row.fastMode,
      permissionMode: row.permissionMode,
      agentKind: row.agentKind,
      remoteHostId: null,
      providerId: row.providerId ?? null,
      agentDeviceId: row.agentDeviceId ?? null,
      extraDirs: row.extraDirs,
      source: row.source,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
  });
  owner.assertCurrent();
  if (result.permissionRepairCanonicalSessionId) {
    await syncBotLinkedLanePermissions(result.permissionRepairCanonicalSessionId);
    owner.assertCurrent();
  }
  return { ok: true, sessionId: result.sessionId, created: result.created };
}

export type EnsureBotChannelLaneResult =
  | { ok: true; sessionId: string; created: boolean }
  | { ok: false; errorCode: 'BOT_UNAVAILABLE' | 'NO_MODEL'; message: string };

/** Read-only lookup of an active IM channel lane (`role = 'channel'`). */
export async function findBotChannelLaneSession(botId: string, routeKey: string): Promise<string | null> {
  return findBotOwnedLaneSession(botId, routeKey, 'channel');
}

async function findBotOwnedLaneSession(
  botId: string,
  routeKey: string,
  role: 'channel' | 'routine',
  status: 'active' | 'archived' = 'active',
): Promise<string | null> {
  const [existing] = await getDbClient()
    .drizzle.select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(
      eq(botSessionLinks.botId, botId),
      eq(botSessionLinks.role, role),
      eq(botSessionLinks.routeKey, routeKey),
      isNull(botSessionLinks.archivedAt),
      eq(sessions.source, 'bot'),
      eq(sessions.status, status),
    ))
    .orderBy(desc(sessions.updatedAt))
    .limit(1);
  return existing?.sessionId ?? null;
}

/**
 * The owner can archive these lanes from the task list. Like an archived automation
 * target, the next trigger resumes the same Session (and its context) instead of
 * starting another one. Only a lane deleted meanwhile falls through to a new Session;
 * any other failure propagates so the caller retries rather than losing the context.
 */
async function resumeArchivedBotOwnedLaneSession(
  botId: string,
  routeKey: string,
  role: 'channel' | 'routine',
): Promise<string | null> {
  const archived = await findBotOwnedLaneSession(botId, routeKey, role, 'archived');
  if (!archived) return null;
  try {
    await restoreArchivedSessionForSend(archived);
  } catch (error) {
    if (!(isIpcError(error) && error.code === 'NOT_FOUND')) throw error;
    log.warn('archived bot lane was deleted before it resumed; starting a new one', { sessionId: archived });
    return null;
  }
  return archived;
}

/**
 * The Bot's hidden lane for one personal-IM group / topic (or an admitted guest
 * DM) once the whole connection is handed to the Bot. Same Profile, Home
 * workspace, model chain and permission profile as the canonical Chat; never a
 * second canonical Session and never visible in the task list. Route keys:
 * `im:<channel>:<botContextId>:g:<chatId>[:t:<threadId>]` / `…:dm:<userId>`.
 */
export async function ensureBotChannelLaneSession(input: {
  botId: string;
  routeKey: string;
  title: string;
}): Promise<EnsureBotChannelLaneResult> {
  return ensureBotOwnedLaneSession(input, 'channel');
}

/** A persistent execution context for one standing instruction, sharing its companion's Home. */
export async function ensureBotRoutineLaneSession(input: { botId: string; routineId: string; title: string; modelOverride?: RoutineModel | null }): Promise<EnsureBotChannelLaneResult> {
  return ensureBotOwnedLaneSession({ ...input, routeKey: `routine:${input.routineId}` }, 'routine');
}

async function ensureBotOwnedLaneSession(input: { botId: string; routeKey: string; title: string; modelOverride?: RoutineModel | null }, role: 'channel' | 'routine'): Promise<EnsureBotChannelLaneResult> {
  const owner = captureBotOperationOwner();
  const client = getDbClient();
  const db = client.drizzle;
  const existing = await findBotOwnedLaneSession(input.botId, input.routeKey, role)
    ?? await resumeArchivedBotOwnedLaneSession(input.botId, input.routeKey, role);
  if (existing) {
    await syncBotLanePermission(existing);
    owner.assertCurrent();
    return { ok: true, sessionId: existing, created: false };
  }
  const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, input.botId)).limit(1);
  if (!profile || profile.status !== 'active') {
    return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: '伙伴当前不可用' };
  }
  const [profileVersion] = await db
    .select()
    .from(botProfileVersions)
    .where(and(
      eq(botProfileVersions.botId, input.botId),
      eq(botProfileVersions.version, profile.currentVersion),
    ))
    .limit(1);
  if (!profileVersion) return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: '伙伴资料版本不存在' };
  const config = parseJson(profileVersion.capabilitiesJson);
  const override = input.modelOverride;
  const primaryRoute = override ? { harness: override.agentKind === 'claude-code' ? 'claude' as const : override.agentKind,
    model: override.model, providerId: override.providerId ?? null, effort: override.effort ?? '',
    fastMode: override.fastMode ?? false, agentDeviceId: override.agentDeviceId ?? null }
    : (await readEffectiveBotModelChain(config))[0] ?? null;
  if (!primaryRoute) return { ok: false, errorCode: 'NO_MODEL', message: '伙伴还没有可用模型' };
  const workspaceKind = 'dialogue' as const;
  const workingDir = await ensureBotWorkspaceDir(owner.userDataDir, input.botId, app.getPath('userData'));
  const now = Date.now();
  const sessionId = resolveBusinessSessionId(undefined);
  const row = {
    ...sessionCreateToRow(
      sessionId,
      {
        workspaceKind,
        workingDir,
        ...botSessionRouteFields(override ? { ...config, providerId: null, effort: undefined } : config, primaryRoute),
        remoteHostId: undefined,
        source: 'bot',
      },
      now,
    ),
    title: input.title,
  };
  const gitSafety = readGitSafetySettings();
  await ensureProjectGitInitialized({
    workingDir,
    workspaceKind,
    remoteHostId: null,
    sessionId,
    autoSnapshotEnabled: gitSafety.autoSnapshotEnabled,
    autoInitProjectGit: gitSafety.autoInitProjectGit,
    source: 'local-db:bots:create-channel-lane',
  });
  owner.assertCurrent();
  let result: BotGroupsCreateLaneResult;
  try {
    result = await client.tx<BotGroupsCreateLaneResult>(role === 'routine' ? 'bots.createRoutineLane' : 'bots.createChannelLane', {
      botId: input.botId,
      routeKey: input.routeKey,
      session: {
        id: row.id,
        title: row.title,
        workingDir: row.workingDir ?? null,
        workspaceKind: row.workspaceKind,
        model: row.model,
        effort: row.effort,
        fastMode: row.fastMode,
        permissionMode: row.permissionMode,
        agentKind: row.agentKind,
        remoteHostId: null,
        providerId: row.providerId ?? null,
        agentDeviceId: row.agentDeviceId ?? null,
        extraDirs: row.extraDirs,
        source: row.source,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    });
  } catch (cause) {
    if ((cause as { code?: unknown } | null)?.code === 'BOT_UNAVAILABLE'
      || (cause instanceof Error && cause.message.includes('伙伴当前不可用'))) {
      return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: '伙伴当前不可用' };
    }
    throw cause;
  }
  owner.assertCurrent();
  if (result.permissionRepairCanonicalSessionId) {
    await syncBotLinkedLanePermissions(result.permissionRepairCanonicalSessionId);
    owner.assertCurrent();
  }
  if (result.created) emitSessionCreated(result.sessionId);
  return { ok: true, sessionId: result.sessionId, created: result.created };
}

export type EnsureBotDmThreadResult =
  | { ok: true; sessionId: string; created: boolean }
  | { ok: false; errorCode: 'BOT_UNAVAILABLE' | 'NO_MODEL' | 'ROOT_UNAVAILABLE'; message: string };

/**
 * The Bot's hidden lane for one private-chat topic (`role = 'thread'`,
 * docs/product-rules/cindy-bots-runtime.md「私聊话题」). Same Profile, Home workspace,
 * model chain and permission profile as the canonical Chat; never a second canonical
 * Session and never visible in the task list. The root is a message of the current
 * canonical Chat, identified by its Session and clientId.
 */
export async function ensureBotDmThreadSession(input: {
  botId: string;
  rootSessionId: string;
  rootClientId: string;
  title: string;
}): Promise<EnsureBotDmThreadResult> {
  const owner = captureBotOperationOwner();
  const client = getDbClient();
  const db = client.drizzle;
  const routeKey = botDmThreadRouteKey(input.rootSessionId, input.rootClientId);
  const [existing] = await db
    .select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(
      eq(botSessionLinks.botId, input.botId),
      eq(botSessionLinks.role, 'thread'),
      eq(botSessionLinks.routeKey, routeKey),
      isNull(botSessionLinks.archivedAt),
      eq(sessions.source, 'bot'),
      eq(sessions.status, 'active'),
    ))
    .limit(1);
  if (existing) {
    await syncBotLanePermission(existing.sessionId);
    owner.assertCurrent();
    return { ok: true, sessionId: existing.sessionId, created: false };
  }
  const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, input.botId)).limit(1);
  if (!profile || profile.status !== 'active') {
    return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: '伙伴当前不可用' };
  }
  const [profileVersion] = await db
    .select()
    .from(botProfileVersions)
    .where(and(
      eq(botProfileVersions.botId, input.botId),
      eq(botProfileVersions.version, profile.currentVersion),
    ))
    .limit(1);
  if (!profileVersion) return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: '伙伴资料版本不存在' };
  const config = parseJson(profileVersion.capabilitiesJson);
  const primaryRoute = (await readEffectiveBotModelChain(config))[0] ?? null;
  if (!primaryRoute) return { ok: false, errorCode: 'NO_MODEL', message: '伙伴还没有可用模型' };
  // The canonical Chat's permission profile, not the default of a new Bot session.
  const [canonical] = await db
    .select({ permissionMode: sessions.permissionMode })
    .from(sessions)
    .where(eq(sessions.id, input.rootSessionId))
    .limit(1);
  const workspaceKind = 'dialogue' as const;
  const workingDir = await ensureBotWorkspaceDir(owner.userDataDir, input.botId, app.getPath('userData'));
  const now = Date.now();
  const sessionId = resolveBusinessSessionId(undefined);
  const row = {
    ...sessionCreateToRow(
      sessionId,
      {
        workspaceKind,
        workingDir,
        ...botSessionRouteFields(config, primaryRoute),
        remoteHostId: undefined,
        source: 'bot',
      },
      now,
    ),
    title: input.title,
  };
  const gitSafety = readGitSafetySettings();
  await ensureProjectGitInitialized({
    workingDir,
    workspaceKind,
    remoteHostId: null,
    sessionId,
    autoSnapshotEnabled: gitSafety.autoSnapshotEnabled,
    autoInitProjectGit: gitSafety.autoInitProjectGit,
    source: 'local-db:bots:create-thread-lane',
  });
  owner.assertCurrent();
  let result: BotGroupsCreateLaneResult;
  try {
    result = await client.tx<BotGroupsCreateLaneResult>('bots.createThreadLane', {
      botId: input.botId,
      routeKey,
      rootSessionId: input.rootSessionId,
      rootClientId: input.rootClientId,
      session: {
        id: row.id,
        title: row.title,
        workingDir: row.workingDir ?? null,
        workspaceKind: row.workspaceKind,
        model: row.model,
        effort: row.effort,
        fastMode: row.fastMode,
        permissionMode: canonical?.permissionMode ?? row.permissionMode,
        agentKind: row.agentKind,
        remoteHostId: null,
        providerId: row.providerId ?? null,
        agentDeviceId: row.agentDeviceId ?? null,
        extraDirs: row.extraDirs,
        source: row.source,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      },
    });
  } catch (cause) {
    const code = (cause as { code?: unknown } | null)?.code;
    const message = cause instanceof Error ? cause.message : '';
    if (code === 'ROOT_UNAVAILABLE' || message.includes('原消息已不在私聊里')) {
      return { ok: false, errorCode: 'ROOT_UNAVAILABLE', message: '原消息已不在私聊里' };
    }
    if (code === 'BOT_UNAVAILABLE' || message.includes('伙伴当前不可用')) {
      return { ok: false, errorCode: 'BOT_UNAVAILABLE', message: '伙伴当前不可用' };
    }
    throw cause;
  }
  owner.assertCurrent();
  if (result.permissionRepairCanonicalSessionId) {
    await syncBotLinkedLanePermissions(result.permissionRepairCanonicalSessionId);
    owner.assertCurrent();
  }
  return { ok: true, sessionId: result.sessionId, created: result.created };
}

/** Rows a topic summary inspects; a topic longer than this still shows the latest activity. */
const DM_THREAD_STATS_SCAN = 500;

/**
 * The private-chat topics opened on messages of `rootSessionId` (the Bot's canonical
 * Chat), for the entry rows under their root messages. Counts follow the companion
 * transcript's visibility: user messages and sealed companion replies, no rewound
 * rows, hidden auto-resume prompts or `/clear`ed history. Topics with no visible
 * message yet (opened and left empty) are omitted.
 */
export async function listBotDmThreads(botId: string, rootSessionId: string): Promise<BotDmThreadSummary[]> {
  const owner = captureBotOperationOwner();
  const db = getDbClient().drizzle;
  const links = await db
    .select({
      sessionId: botSessionLinks.sessionId,
      routeKey: botSessionLinks.routeKey,
      createdAt: botSessionLinks.createdAt,
      clearedAt: sessions.clearedAt,
    })
    .from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(
      eq(botSessionLinks.botId, botId),
      eq(botSessionLinks.role, 'thread'),
      isNull(botSessionLinks.archivedAt),
      eq(sessions.source, 'bot'),
      eq(sessions.status, 'active'),
    ));
  const result: BotDmThreadSummary[] = [];
  for (const link of links) {
    const root = parseBotDmThreadRouteKey(link.routeKey);
    if (!root || root.rootSessionId !== rootSessionId) continue;
    owner.assertCurrent();
    const running = getMakerIfReady()?.getSession(link.sessionId)?.isTurnRunning?.() === true;
    const rows = await db
      .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
      .from(messages)
      .where(and(
        eq(messages.sessionId, link.sessionId),
        inArray(messages.role, ['user', 'assistant']),
        or(eq(messages.role, 'user'), and(...canonicalReplyVisibility())),
        ...(running ? [sql`(${messages.role} != 'assistant' OR ${canonicalReplyCompleted()})`] : []),
        isNull(messages.rewindAt),
        sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
        ...(link.clearedAt !== null ? [gt(messages.createdAt, link.clearedAt)] : []),
      ))
      .orderBy(desc(messages.createdAt))
      .limit(DM_THREAD_STATS_SCAN);
    let replyCount = 0;
    let lastReplyAt: number | null = null;
    let lastAssistantAt: number | null = null;
    for (const row of rows) {
      if (!extractMessagePreview(row.content, row.role)) continue;
      replyCount += 1;
      lastReplyAt ??= row.createdAt;
      if (row.role === 'assistant') lastAssistantAt ??= row.createdAt;
    }
    if (replyCount === 0) continue;
    result.push({
      sessionId: link.sessionId,
      rootSessionId: root.rootSessionId,
      rootClientId: root.rootClientId,
      replyCount,
      lastReplyAt,
      lastAssistantAt,
      createdAt: link.createdAt,
    });
  }
  owner.assertCurrent();
  return result;
}

/**
 * Archive IM channel lanes: one lane (`routeKey`, e.g. `/new` in a group) or a
 * whole connection (`routeKeyPrefix = im:<channel>:<botContextId>:`), optionally
 * keeping one Bot's lanes. Returns the archived Session ids so the caller can
 * release their live runtimes.
 */
export async function archiveBotChannelLanes(input: {
  routeKey?: string;
  routeKeyPrefix?: string;
  exceptBotId?: string | null;
}): Promise<string[]> {
  const owner = captureBotOperationOwner();
  const result = await getDbClient().tx<{ archivedSessionIds: string[] }>('bots.archiveChannelLanes', {
    routeKey: input.routeKey ?? null,
    routeKeyPrefix: input.routeKeyPrefix ?? null,
    exceptBotId: input.exceptBotId ?? null,
    now: Date.now(),
  });
  owner.assertCurrent();
  return result.archivedSessionIds;
}

/**
 * Canonical identity is owned by bot_session_links(role=canonical). The
 * bot_profiles.canonical_session_id column is retained only as a compatibility
 * mirror while old databases are being brought forward.
 */
async function reconcileCanonicalLink(
  botId: string,
  client = getDbClient(),
): Promise<CanonicalLinkReconciliation> {
  try {
    return await client.tx<CanonicalLinkReconciliation>('bots.reconcileCanonicalLink', {
      botId,
      now: Date.now(),
    });
  } catch (error) {
    // A failed reconciliation must never make us guess a Session. Consumers
    // treat this as a closed recovery state and surface health/repair UI.
    log.warn('canonical link reconciliation failed closed', { botId, error: String(error) });
    return { status: 'conflict', canonicalSessionId: null };
  }
}

/**
 * 把伙伴家里的文件收进数据库 —— 用户拿编辑器改完 SOUL.md、或者伙伴自己用文件
 * 工具改完自己的灵魂之后,由这里派生一个新版本。
 *
 * 派生而不是就地改:运行中的任务认版本号,**进行中的对话仍跑在旧版本上,下一轮
 * 才换过去**。就地改会让一个跑到一半的任务中途换身份。
 *
 * 挂在开新任务之前 —— 那正是「下一轮」的起点。整个过程失败不阻断开任务:最坏是
 * 这一轮还用旧身份,下一轮再收。
 */
export async function reconcileBotProfileFolder(
  botId: string,
): Promise<{ from: number; to: number } | null> {
  const userDataDir = ownerScopedUserDataPath();
  let derived: { from: number; to: number } | null = null;
  const legacyUserDataDir = app.getPath('userData');
  const client = getDbClient();
  const db = client.drizzle;
  try {
    await syncBotProfileFromFolder(botId, {
      readSnapshot: async (id) => {
        const [profile] = await db
          .select({ currentVersion: botProfiles.currentVersion })
          .from(botProfiles)
          .where(eq(botProfiles.id, id))
          .limit(1);
        if (!profile) return null;
        const [version] = await db
          .select()
          .from(botProfileVersions)
          .where(
            and(
              eq(botProfileVersions.botId, id),
              eq(botProfileVersions.version, profile.currentVersion),
            ),
          )
          .limit(1);
        if (!version) return null;
        return {
          identitySource: version.identitySource,
          config: parseJson(version.capabilitiesJson),
          currentVersion: profile.currentVersion,
        };
      },
      readFolder: (id) => readBotProfileFolder(userDataDir, id),
      // 播种顺带把技能从旧目录搬进来 —— 存量伙伴第一次走到这里时一并完成。
      seedFolder: async (id, seed) => {
        await migrateBotProfileFolder(userDataDir, id, seed, legacyUserDataDir);
      },
      deriveVersion: async (input) => {
        const result = await client.tx<{ currentVersion: number }>('bots.updateProfile', {
          id: input.botId,
          identitySource: input.identitySource,
          capabilitiesJson: safeJson(input.config),
          profileContentChanged: true,
          expectedCurrentVersion: input.expectedCurrentVersion,
          now: Date.now(),
        });
        derived = { from: input.expectedCurrentVersion, to: result.currentVersion };
      },
    });
  } catch (cause) {
    log.warn('reconcile bot profile folder failed', { botId, error: String(cause) });
  }
  return derived;
}

function botSessionAgentKind(config: { harness?: unknown }): 'cc' | 'codex' | 'pi' {
  return config.harness === 'codex' ? 'codex' : config.harness === 'pi' ? 'pi' : 'cc';
}

function defaultBotModelForConfig(config: Record<string, unknown>): string {
  return botSessionAgentKind(config) === 'pi' ? NEW_BOT_DEFAULT_PI_MODEL : 'claude-sonnet-4-6';
}

function botSessionPermissionMode(config: Record<string, unknown>): 'ask' | 'auto' | 'bypassPermissions' {
  return config.permissions === 'trusted' ? 'bypassPermissions' : config.permissions === 'auto' ? 'auto' : 'ask';
}

type BotPrimaryRoute = Awaited<ReturnType<typeof readEffectiveBotModelChain>>[number];

/** Session runtime fields every Bot-owned Chat (canonical or group lane) starts from. */
function botSessionRouteFields(config: Record<string, unknown>, primaryRoute: BotPrimaryRoute | null) {
  return {
    model:
      primaryRoute?.model ??
      (typeof config.model === 'string'
        ? config.model.trim()
        : defaultBotModelForConfig(config)),
    providerId:
      primaryRoute?.providerId ??
      (typeof config.providerId === 'string' && config.providerId.trim()
        ? config.providerId.trim()
        : config.providerId === null
          ? null
          : botSessionAgentKind(primaryRoute ?? config) === 'pi'
            ? NEW_BOT_DEFAULT_PI_PROVIDER
            : undefined),
    effort:
      primaryRoute?.effort ||
      (typeof config.effort === 'string' && config.effort.trim()
        ? config.effort.trim()
        : botSessionAgentKind(primaryRoute ?? config) === 'pi'
          ? NEW_BOT_DEFAULT_PI_EFFORT
          : undefined),
    fastMode: primaryRoute?.fastMode ?? config.fastMode === true,
    agentDeviceId: primaryRoute?.agentDeviceId ?? null,
    agentKind: botSessionAgentKind(primaryRoute ?? config),
    permissionMode: botSessionPermissionMode(config),
  };
}

function readText(value: unknown, field: string, max = MAX_TEXT, required = false): string {
  if (typeof value !== 'string') {
    if (!required && (value === undefined || value === null)) return '';
    throwIpcError('INVALID_PARAMS', `${field} 必须是字符串`);
  }
  const text = value.trim();
  if (required && !text) throwIpcError('INVALID_PARAMS', `${field} 不能为空`);
  if (text.length > max) throwIpcError('INVALID_PARAMS', `${field} 超过长度上限 ${max}`);
  return text;
}

/**
 * 角色性别。只收已知取值,别的一律当没给 —— 界面文案据它取「她 / 他」,
 * 收到脏值不如回落到「用名字称呼」(见 shared/botGender.ts)。
 */
function readBotGender(value: unknown): 'female' | 'male' | undefined {
  return value === 'female' || value === 'male' ? value : undefined;
}

function parseJson(value: string, fallback: Record<string, unknown> = {}): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : fallback;
  } catch {
    return fallback;
  }
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function normalizeBotModelCapabilitiesOrThrow(
  config: Record<string, unknown>,
): Record<string, unknown> {
  try {
    return normalizeBotProfileModelChain(config);
  } catch (error) {
    throwIpcError(
      'INVALID_PARAMS',
      error instanceof Error ? error.message : 'Bot model chain is invalid',
    );
  }
}

/** How many candidate rows the preview query inspects (see below). */
const CANONICAL_PREVIEW_SCAN = 100;

/** Explicit group deliveries are complete replies independent of the canonical turn.
 * The transcript also accepts persisted usage/cost as a legacy turn seal. */
function canonicalReplyCompleted() {
  return sql`(json_extract(${messages.agentMeta}, '$.turnCompleted') = 1
    OR json_extract(${messages.agentMeta}, '$.turnMoney.amount') > 0
    OR json_extract(${messages.agentMeta}, '$.turnCostUsd') > 0
    OR json_type(${messages.agentMeta}, '$.turnUsageDetails') IS NOT NULL
    OR (json_type(${messages.agentMeta}, '$.sourceGroup.groupId') = 'text'
      AND length(trim(json_extract(${messages.agentMeta}, '$.sourceGroup.groupId'))) > 0))`;
}

/** Visibility shared by the local unread count and remote reply watermark. */
function canonicalReplyVisibility() {
  return [
    sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.assistantPhase') IS NOT 'commentary')`,
    sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.parentToolUseId') IS NULL)`,
    sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.parent_tool_use_id') IS NULL)`,
    // A completed reply remains visible even when the same turn continues with tools.
    // Only unsealed pre-tool narration is hidden by the companion transcript.
    // Only the nearest live tool matters: if a new user turn precedes it, every
    // later tool is also outside this reply's turn. Stop the indexed tool scan at
    // that first row, then bound the input scan by its time. Searching for the next
    // input first would rescan the entire tail for each narration in a long turn.
    sql`(${canonicalReplyCompleted()} OR NOT EXISTS (
      SELECT 1 FROM (
        SELECT subsequent_tool.created_at FROM messages AS subsequent_tool
        WHERE subsequent_tool.session_id = ${messages.sessionId}
          AND subsequent_tool.created_at > ${messages.createdAt}
          AND subsequent_tool.rewind_at IS NULL
          AND subsequent_tool.role IN ('tool_use', 'tool_result', 'thinking')
        ORDER BY subsequent_tool.created_at LIMIT 1
      ) AS first_tool
      WHERE NOT EXISTS (SELECT 1 FROM messages AS next_input
          WHERE next_input.session_id = ${messages.sessionId}
            AND next_input.role = 'user' AND next_input.rewind_at IS NULL
            AND next_input.created_at > ${messages.createdAt}
            AND next_input.created_at < first_tool.created_at
            AND (next_input.agent_meta IS NULL OR json_extract(next_input.agent_meta, '$.autoResume') IS NOT 1)
            AND (next_input.agent_meta IS NULL OR json_extract(next_input.agent_meta, '$.delivery') IS NOT 'steer'))
    ))`,
  ];
}

/**
 * Latest visible message of a Bot's canonical chat, for the Bots list rows.
 *
 * Read-only Bot projection with the ordinary preview
 * boundaries plus companion reply visibility: only
 * user / assistant rows, no rewind-truncated rows, no hidden auto-resume
 * prompts, and nothing before the session's `/clear` boundary. Indexed
 * batches skip empty content without hiding a preceding real reply.
 *
 * A small window instead of `LIMIT 1`: `content` is a serialized structure, and
 * rows whose text cannot be extracted (attachment-only sends, synthetic UI
 * triggers) must be skipped rather than shown as an empty preview.
 */
async function readCanonicalChatPreview(
  db: ReturnType<typeof getDbClient>['drizzle'],
  canonicalSessionId: string | null,
  clearedAt: number | null,
  repliesOnly = false,
): Promise<{ preview: string | null; createdAt: number | null; role: BotChatRole | null }> {
  if (!canonicalSessionId) return { preview: null, createdAt: null, role: null };
  const running = getMakerIfReady()?.getSession(canonicalSessionId)?.isTurnRunning?.() === true;
  let offset = 0;
  for (;;) {
    const rows = await db
      .select({
        role: messages.role,
        content: messages.content,
        createdAt: messages.createdAt,
      })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, canonicalSessionId),
          repliesOnly ? eq(messages.role, 'assistant') : inArray(messages.role, ['user', 'assistant']),
          or(eq(messages.role, 'user'), and(...canonicalReplyVisibility())),
          // During generation, prose blocks are progress. Only a sealed answer is a reply preview.
          ...(running ? [sql`(${messages.role} != 'assistant' OR ${canonicalReplyCompleted()})`] : []),
          isNull(messages.rewindAt),
          sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
          sql`(${messages.agentMeta} IS NULL OR json_type(${messages.agentMeta}, '$.botDirectMessage') IS NULL)`,
          sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.botPrivateReply') IS NOT 1)`,
          ...(clearedAt !== null ? [gt(messages.createdAt, clearedAt)] : []),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(CANONICAL_PREVIEW_SCAN).offset(offset);
    for (const row of rows) {
      const preview = extractMessagePreview(row.content, row.role);
      if (preview) {
        return {
          preview,
          createdAt: row.createdAt ?? null,
          role: row.role === 'user' ? 'user' : 'assistant',
        };
      }
    }
    if (rows.length < CANONICAL_PREVIEW_SCAN) break;
    offset += rows.length;
  }
  return { preview: null, createdAt: null, role: null };
}

/** Anything above this is rendered as `99+`, so counting further is wasted work. */
const CANONICAL_UNREAD_SCAN = 100;

/**
 * How many replies landed in a Bot's canonical chat after the user last read it.
 *
 * Read position is renderer state (see `features/bots/botReadState.ts`) and is
 * passed in per request — main never persists it, so this stays a pure read.
 * Only the Bot's own `assistant` output counts: the user's sends and internal
 * Bot-to-Bot conversation traces are never "unread". The remaining visibility
 * rules are exactly the preview's (no rewind-truncated rows, no hidden
 * auto-resume prompts, nothing before the `/clear` boundary). One indexed
 * range scan per Bot on `idx_messages_session_created`, stopping after
 * `CANONICAL_UNREAD_SCAN` visible replies; empty rows cannot consume the cap.
 */
async function countCanonicalUnread(
  db: ReturnType<typeof getDbClient>['drizzle'],
  canonicalSessionId: string | null,
  clearedAt: number | null,
  lastReadAt: number | null,
): Promise<number> {
  if (!canonicalSessionId || lastReadAt === null) return 0;
  const boundary = clearedAt !== null ? Math.max(clearedAt, lastReadAt) : lastReadAt;
  const running = getMakerIfReady()?.getSession(canonicalSessionId)?.isTurnRunning?.() === true;
  let count = 0;
  let offset = 0;
  for (;;) {
    const rows = await db
      .select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, canonicalSessionId),
          eq(messages.role, 'assistant'),
          ...(running ? [canonicalReplyCompleted()] : []),
          ...canonicalReplyVisibility(),
          isNull(messages.rewindAt),
          sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.autoResume') IS NOT 1)`,
          sql`(${messages.agentMeta} IS NULL OR json_type(${messages.agentMeta}, '$.botDirectMessage') IS NULL)`,
          sql`(${messages.agentMeta} IS NULL OR json_extract(${messages.agentMeta}, '$.botPrivateReply') IS NOT 1)`,
          gt(messages.createdAt, boundary),
        ),
      )
      .orderBy(desc(messages.createdAt), desc(messages.id))
      .limit(CANONICAL_UNREAD_SCAN).offset(offset);
    count += rows.filter(row => Boolean(extractMessagePreview(row.content, 'assistant'))).length;
    if (count >= CANONICAL_UNREAD_SCAN || rows.length < CANONICAL_UNREAD_SCAN) return Math.min(count, CANONICAL_UNREAD_SCAN);
    offset += rows.length;
  }
}

async function readProfile(
  client: ReturnType<typeof getDbClient>,
  botId: string,
  /** Renderer-owned read position for this Bot; omitted ⇒ no unread accounting. */
  lastReadAt: number | null = null,
) {
  const owner = captureBotOperationOwner();
  const db = client.drizzle;
  let [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  if (await migrateLegacyTeammateAvatar(client, profile, owner.assertCurrent)) {
    [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  }
  const canonicalResolution = await reconcileCanonicalLink(botId, client);
  const canonicalSessionId = canonicalResolution.canonicalSessionId;
  const links = await db
    .select()
    .from(botSessionLinks)
    .where(eq(botSessionLinks.botId, botId))
    .orderBy(desc(botSessionLinks.createdAt));
  const sessionRows = links.length
    ? await db
        .select()
        .from(sessions)
        .where(
          inArray(
            sessions.id,
            links.map((link) => link.sessionId),
          ),
        )
    : [];
  const byId = new Map(sessionRows.map((row) => [row.id, row]));
  // Runtime snapshots are durable history. The list needs only the latest per
  // task; fetching every frozen capability JSON grows with months of restarts.
  const runtimeRows: (typeof botRuntimeSnapshots.$inferSelect)[] = [];
  for (const link of links) {
    owner.assertCurrent();
    runtimeRows.push(...await db.select().from(botRuntimeSnapshots)
      .where(eq(botRuntimeSnapshots.sessionId, link.sessionId))
      .orderBy(desc(botRuntimeSnapshots.preparedAt), desc(botRuntimeSnapshots.appliedAt))
      .limit(1));
  }
  const runtimeBySession = new Map<string, (typeof runtimeRows)[number]>();
  for (const row of runtimeRows) {
    if (!runtimeBySession.has(row.sessionId)) runtimeBySession.set(row.sessionId, row);
  }
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, botId),
        eq(botProfileVersions.version, profile.currentVersion),
      ),
    )
    .limit(1);
  const canonicalClearedAt = byId.get(canonicalSessionId ?? '')?.clearedAt ?? null;
  const latestMessage = await readCanonicalChatPreview(db, canonicalSessionId, canonicalClearedAt);
  const unreadCount = await countCanonicalUnread(
    db,
    canonicalSessionId,
    canonicalClearedAt,
    lastReadAt,
  );
  const config = normalizeBotToolCapabilities(parseJson(version?.capabilitiesJson ?? '{}'));
  const modelChain = await readEffectiveBotModelChain(config);
  const primaryModelRoute = modelChain[0];
  const invitation = botInvitationProgress(config.invitation);
  if (invitation && isManagedBotAvatarUrl(profile.avatar)) invitation.avatarSkipped = false;
  const failureReason = BOT_FAILURE_REASONS.includes(profile.attentionReason as BotFailureReason)
    ? (profile.attentionReason as BotFailureReason)
    : null;
  const needsAttention =
    profile.attentionAt !== null &&
    failureReason !== null &&
    isBotFailureAttentionWorthy(failureReason);
  owner.assertCurrent();
  return {
    id: profile.id,
    name: profile.displayName,
    description: profile.description,
    identitySource: version?.identitySource ?? '',
    invitation,
    userContextSource: typeof config.userContextSource === 'string' ? config.userContextSource : '',
    // 与 userContextSource 同款:存在档案 JSON 里,投影成顶层字段。老档案没有这
    // 个键 → undefined → 界面回落「用名字称呼」,与升级前行为一致。
    ...(readBotGender(config.gender) ? { gender: readBotGender(config.gender) } : {}),
    avatar: profile.avatar,
    avatarColor: profile.avatarColor,
    enabled: profile.status === 'active',
    hiddenAt: profile.hiddenAt,
    pinnedAt: profile.pinnedAt,
    failureReason,
    needsAttention,
    status: profile.status,
    templateId: typeof config.templateId === 'string' ? config.templateId : inferBotTemplatePresetId(version?.identitySource ?? '') ?? undefined,
    currentVersion: profile.currentVersion,
    canonicalSessionId: canonicalSessionId ?? undefined,
    /*
      伙伴的家在磁盘上的位置。文件夹化的全部用户价值就是「能用编辑器改、能备份、
      能复制一份」—— 而在这之前界面上没有一处告诉用户它在哪。

      Hermes 不需要这个:它是命令行,用户本来就站在文件系统里(`~/.hermes/profiles/<名字>/`,
      见 bot-mode.md 的 CLI parity 表)。Cindy 是桌面应用,不给入口就等于没有。
      这一条是 Cindy 自己的产品判断,不是抄来的。
    */
    homeDir: botProfileDir(owner.userDataDir, profile.id),
    lastMessagePreview: latestMessage.preview,
    lastMessageAt: latestMessage.createdAt,
    lastMessageRole: latestMessage.role,
    unreadCount,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
    skills: Array.isArray(config.skills)
      ? config.skills.filter((item): item is string => typeof item === 'string')
      : [],
    capabilities: {
      model:
        primaryModelRoute?.model ??
        (typeof config.model === 'string' ? config.model : 'claude-sonnet-4-6'),
      // Renderer treats this as the source-of-truth marker: null means the
      // concrete model above is only a resolved cache and must follow the
      // current Gateway/Catalog default.
      modelOverride:
        config.modelOverride && typeof config.modelOverride === 'object'
          ? config.modelOverride
          : null,
      providerId:
        primaryModelRoute?.providerId ??
        (typeof config.providerId === 'string'
          ? config.providerId
          : config.providerId === null
            ? null
            : undefined),
      effort: primaryModelRoute?.effort ?? (typeof config.effort === 'string' ? config.effort : ''),
      fastMode: primaryModelRoute?.fastMode ?? config.fastMode === true,
      harness:
        primaryModelRoute?.harness ??
        (config.harness === 'codex' || config.harness === 'pi' ? config.harness : 'claude'),
      modelChain,
      modelChainOverride: Array.isArray(config.modelChainOverride)
        ? normalizeBotModelChain(config.modelChainOverride)
        : null,
      ...(config.taskModelOverride !== undefined ? { taskModelOverride: readBotTaskModelOverride(config.taskModelOverride) } : {}),
      skillMode: config.skillMode === 'allowlist' ? 'allowlist' : 'inherit',
      // 跟随全局时被单独关掉的那几项(见 botProfileRuntime 的 excludedSkills)。
      skillsExcluded: Array.isArray(config.skillsExcluded)
        ? config.skillsExcluded.filter((item): item is string => typeof item === 'string')
        : [],
      toolsetMode: config.toolsetMode,
      toolsets: Array.isArray(config.toolsets)
        ? config.toolsets.filter((item): item is string => typeof item === 'string')
        : [],
      mcpMode: config.mcpMode,
      mcpServers: Array.isArray(config.mcpServers)
        ? config.mcpServers.filter((item): item is string => typeof item === 'string')
        : [],
      ...(config.mcpServerNames && typeof config.mcpServerNames === 'object' && !Array.isArray(config.mcpServerNames)
        ? { mcpServerNames: Object.fromEntries(Object.entries(config.mcpServerNames as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
      memory: config.memory !== false,
      permissions: config.permissions === 'trusted' || config.permissions === 'auto' ? config.permissions : 'ask',
      // Stored and enforced elsewhere (input handoff policy, scheduler follow); the settings page reads them
      // back from here, so an explicit choice must survive a reload. Absent keeps the defaults.
      ...(config.inputHandoff === false ? { inputHandoff: false } : {}),
      ...(config.allowSchedulerFollow === true ? { allowSchedulerFollow: true } : {}),
      // Absent = every system Skill on (shared/botSystemSkills.ts).
      ...(readBotSystemSkillsOff(config.systemSkillsOff).length
        ? { systemSkillsOff: readBotSystemSkillsOff(config.systemSkillsOff) } : {}),
    },
    sessions: links.flatMap((link) => {
      const row = byId.get(link.sessionId);
      if (!row) return [];
      const groupId = link.role === 'group' ? parseBotGroupIdFromRouteKey(link.routeKey) : null;
      const threadRoot = link.role === 'thread' ? parseBotDmThreadRouteKey(link.routeKey) : null;
      return [
        {
          id: row.id,
          title: row.title,
          kind:
            link.role === 'canonical'
              ? 'chat'
              : link.role === 'delegation'
                ? 'worker'
                : link.role === 'group'
                  ? 'group'
                  : link.role === 'channel'
                    ? 'channel'
                    : link.role === 'routine'
                      ? 'routine'
                      : link.role === 'thread'
                        ? 'thread'
                        : 'history',
          updatedAt: row.updatedAt,
          status: row.status,
          role: link.role,
          // 群专线没有自己的页面:通知 / 灵动岛入口要据此回到它所在的群。
          ...(groupId ? { groupId } : {}),
          // 私聊话题没有自己的页面:通知等入口据此打开私聊并展开这个话题。
          ...(threadRoot ? { threadRoot } : {}),
          profileVersion: link.profileVersion,
          runtimeSnapshot: runtimeBySession.has(row.id)
            ? (() => {
                const runtime = runtimeBySession.get(row.id)!;
                return {
                  profileVersion: runtime.profileVersion,
                  agentKind: runtime.agentKind,
                  status: runtime.status,
                  preparedAt: runtime.preparedAt || runtime.appliedAt || 0,
                  appliedAt: runtime.appliedAt ?? undefined,
                  failedAt: runtime.failedAt ?? undefined,
                  failure: runtime.failureJson ? parseJson(runtime.failureJson) : undefined,
                  configured: parseJson(runtime.configuredJson),
                  resolved: parseJson(runtime.resolvedJson),
                };
              })()
            : undefined,
        },
      ];
    }),
  };
}

/** Full profile read for the teammate settings pages (the remote Desktop projects it before sending). */
export async function readBotSettingsProfile(botId: string) {
  return readProfile(getDbClient(), botId);
}

/**
 * Device-link only needs enough Bot metadata to render the Mobile directory and
 * open the canonical task. Keep this projection main-side so profile prompts,
 * channel credentials, project paths and runtime state never cross the wire.
 */
async function readRemoteBotProfile(client: ReturnType<typeof getDbClient>, botId: string) {
  const owner = captureBotOperationOwner();
  const db = client.drizzle;
  const [stored] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (!stored) throwIpcError('NOT_FOUND', 'Bot 不存在');
  if (!isBotVisibleRemotely(stored)) return null;
  await migrateLegacyTeammateAvatar(client, stored, owner.assertCurrent);
  const [profile] = await db
    .select({
      id: botProfiles.id,
      name: botProfiles.displayName,
      description: botProfiles.description,
      avatar: botProfiles.avatar,
      avatarColor: botProfiles.avatarColor,
      status: botProfiles.status,
      currentVersion: botProfiles.currentVersion,
      canonicalSessionId: botProfiles.canonicalSessionId,
      hiddenAt: botProfiles.hiddenAt,
    })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  if (!isBotVisibleRemotely(profile)) return null;
  const canonicalResolution = await reconcileCanonicalLink(botId, client);
  owner.assertCurrent();
  // Personal transcript links let search entries open the exact historical task.
  // Include only the root binding for private topics, never prompts or runtime configuration.
  const personalSessions = await db.select({
    id: sessions.id,
    role: botSessionLinks.role,
    routeKey: botSessionLinks.routeKey,
    status: sessions.status,
  }).from(botSessionLinks)
    .innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
    .where(and(
      eq(botSessionLinks.botId, botId),
      inArray(botSessionLinks.role, ['canonical', 'history', 'thread']),
      or(ne(botSessionLinks.role, 'thread'), isNull(botSessionLinks.archivedAt)),
      ne(sessions.status, 'deleted'),
    ));
  owner.assertCurrent();
  const { hiddenAt: _hiddenAt, ...visibleProfile } = profile;
  return {
    ...visibleProfile,
    canonicalSessionId: canonicalResolution.canonicalSessionId ?? undefined,
    dmThreadsSupported: true,
    sessions: personalSessions.map(({ routeKey, ...row }) => ({ ...row,
      ...(row.role === 'thread' ? { threadRoot: parseBotDmThreadRouteKey(routeKey) } : {}),
    })),
  };
}

/**
 * User-facing Bot facts consumed by the module-neutral remote resource provider.
 * This is an in-process connection function, not a wire DTO: the provider turns
 * it into portable display/link/action primitives before anything crosses the
 * device-link boundary.
 */
export interface BotRemoteResourceSource {
  invitation?: BotInvitationProgress;
  id: string;
  name: string;
  description: string;
  avatar: string;
  avatarColor: string;
  status: string;
  canonicalSessionId?: string;
  lastMessagePreview: string | null;
  lastMessageAt: number | null;
  lastMessageRole: BotChatRole | null;
  lastReplyAt?: number;
  needsAttention: boolean;
  hiddenAt: number | null;
  pinnedAt: number | null;
  activityAt: number;
  currentVersion: number;
  updatedAt: number;
  /** Open tasks this Bot looks after, for the follow mark on remote task rows. Absent = none. */
  followingSessionIds?: string[];
}

const MAX_FOLLOWED_TASK_LINKS = 200;

/**
 * The tasks the desktop sidebar marks as followed by this Bot (`useSessionFollowers`):
 * active, local, ordinary tasks only, so archived history never grows the roster.
 */
async function readFollowedTaskIds(
  db: ReturnType<typeof getDbClient>['drizzle'],
  userDataDir: string,
  botId: string,
): Promise<string[]> {
  let ids: string[];
  try {
    ids = (await readBotResponsibilityScope(userDataDir, botId)).sessionIds;
  } catch {
    // A damaged store may hold releases: show no mark rather than guess (collectTaskResponsibilityScopes).
    return [];
  }
  const followed: Array<{ id: string; updatedAt: number }> = [];
  for (let start = 0; start < ids.length; start += 500) {
    const rows = await db.select({ id: sessions.id, updatedAt: sessions.updatedAt }).from(sessions).where(and(
      inArray(sessions.id, ids.slice(start, start + 500)),
      eq(sessions.status, 'active'),
      isNull(sessions.remoteHostId),
      // isWorkbenchTaskSource: ordinary tasks only, never a Bot's own or a channel conversation.
      inArray(sessions.source, ['desktop', 'plugin']),
      or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
    ));
    followed.push(...rows);
  }
  // Keep the roster row small: the most recently active tasks, in a stable order.
  return followed
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, MAX_FOLLOWED_TASK_LINKS)
    .map((row) => row.id)
    .sort();
}

async function readBotRemoteResourceSource(
  client: ReturnType<typeof getDbClient>,
  botId: string,
): Promise<BotRemoteResourceSource> {
  const owner = captureBotOperationOwner();
  const db = client.drizzle;
  const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  const { canonicalSessionId } = await reconcileCanonicalLink(botId, client);
  owner.assertCurrent();
  const [canonical] = canonicalSessionId ? await db
    .select({ clearedAt: sessions.clearedAt, updatedAt: sessions.updatedAt })
    .from(sessions).where(eq(sessions.id, canonicalSessionId)).limit(1) : [];
  const latest = await readCanonicalChatPreview(db, canonicalSessionId, canonical?.clearedAt ?? null);
  const [version] = await db.select({ capabilitiesJson: botProfileVersions.capabilitiesJson })
    .from(botProfileVersions).where(and(eq(botProfileVersions.botId, botId), eq(botProfileVersions.version, profile.currentVersion))).limit(1);
  const invitation = botInvitationProgress(parseJson(version?.capabilitiesJson ?? '{}').invitation);
  const reply = latest.role === 'assistant' ? latest : await readCanonicalChatPreview(db, canonicalSessionId, canonical?.clearedAt ?? null, true);
  // Paused or archived companions show no mark, as on the desktop sidebar.
  const followingSessionIds = profile.status === 'active' ? await readFollowedTaskIds(db, owner.userDataDir, botId) : [];
  owner.assertCurrent();
  return {
    ...(invitation ? { invitation } : {}),
    id: profile.id,
    name: profile.displayName,
    description: profile.description,
    avatar: profile.avatar,
    avatarColor: profile.avatarColor,
    status: profile.status,
    canonicalSessionId: canonicalSessionId ?? undefined,
    lastMessagePreview: latest.preview,
    lastMessageAt: latest.createdAt,
    lastMessageRole: latest.role,
    lastReplyAt: reply.createdAt ?? 0,
    needsAttention: profile.attentionAt !== null &&
      BOT_FAILURE_REASONS.includes(profile.attentionReason as BotFailureReason) &&
      isBotFailureAttentionWorthy(profile.attentionReason as BotFailureReason),
    hiddenAt: profile.hiddenAt,
    pinnedAt: profile.pinnedAt,
    activityAt: Math.max(profile.createdAt, latest.createdAt ?? 0, canonical?.updatedAt ?? 0),
    currentVersion: profile.currentVersion,
    updatedAt: profile.updatedAt,
    followingSessionIds,
  };
}

function readBotInvitationLocale(value: unknown): SupportedLocale {
  return typeof value === 'string' && (SUPPORTED_LOCALES as readonly string[]).includes(value)
    ? value as SupportedLocale
    : getResolvedMainLocale();
}

/** Desktop, device-link and resource discovery share the same owner-bound receipt. */
async function provisionDefaultBotForList(
  client: ReturnType<typeof getDbClient>,
  owner: ReturnType<typeof captureBotOperationOwner>,
  welcomeContext?: BotWelcomeContext,
  locale?: SupportedLocale,
): Promise<void> {
  try {
    await provisionDefaultBot({
      ownerRoot: owner.userDataDir, assertOwner: owner.assertCurrent,
      hasBotHistory: async () => {
        const profiles = await client.drizzle.select({ id: botProfiles.id }).from(botProfiles).limit(1);
        if (profiles.length) return true;
        const history = await client.drizzle.select({ id: sessions.id }).from(sessions).where(eq(sessions.source, 'bot')).limit(1);
        return history.length > 0;
      },
      create: () => createBotProfile({ id: 'cindy-default', name: 'Cindy', templateId: 'cindy',
        avatar: BOT_TEMPLATE_PRESET_AVATARS.cindy, identitySource: CINDY_DEFAULT_IDENTITY,
        prepareInvitation: true, welcomeContext, locale }),
    });
  } catch (error) {
    log.warn('initial companion deferred', { error: error instanceof Error ? error.name : typeof error });
  }
  owner.assertCurrent();
}

export async function listBotRemoteResourceSources(): Promise<BotRemoteResourceSource[]> {
  const owner = captureBotOperationOwner();
  const client = getDbClient();
  await provisionDefaultBotForList(client, owner);
  const profiles = await client.drizzle.select({ id: botProfiles.id }).from(botProfiles)
    .where(isNull(botProfiles.hiddenAt)).orderBy(desc(botProfiles.updatedAt));
  owner.assertCurrent();
  // The roster reads only identity + canonical preview, never runtime snapshots
  // or every historical task attached to a long-lived companion.
  // A large roster must not occupy one DB RPC slot per companion at once.
  const sources = await collectPresentBotRemoteResourceSources(
    profiles.map((profile) => profile.id),
    (id) => readBotRemoteResourceSource(client, id),
    () => owner.assertCurrent(),
  );
  owner.assertCurrent();
  return sources;
}

export async function getBotRemoteResourceSource(botId: string): Promise<BotRemoteResourceSource> {
  return readBotRemoteResourceSource(getDbClient(), botId);
}

/** In-process settings projection. Never expose full profiles, runtime snapshots or Home paths. */
export async function getBotRemoteSettingsSource(botId: string) {
  const owner = captureBotOperationOwner();
  const client = getDbClient();
  const source = await readBotRemoteResourceSource(client, botId);
  owner.assertCurrent();
  if (!isBotVisibleRemotely(source)) throwIpcError('NOT_FOUND', 'Bot does not exist');
  const [version] = await client.drizzle.select().from(botProfileVersions).where(and(
    eq(botProfileVersions.botId, botId), eq(botProfileVersions.version, source.currentVersion),
  )).limit(1);
  const config = normalizeBotToolCapabilities(parseJson(version?.capabilitiesJson ?? '{}'));
  const modelChain = await readEffectiveBotModelChain(config);
  owner.assertCurrent();
  const strings = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string') : [];
  return {
    source,
    identity: version?.identitySource ?? '',
    userContext: typeof config.userContextSource === 'string' ? config.userContextSource : '',
    memory: config.memory !== false,
    permissions: config.permissions === 'trusted' || config.permissions === 'auto' ? config.permissions : 'ask',
    modelChain,
    followsDefault: !(Array.isArray(config.modelChainOverride) && config.modelChainOverride.length > 0)
      && (config.modelChainOverride === null || config.modelOverride === null
        || (!Array.isArray(config.modelChainOverride) && !Array.isArray(config.modelChain) && typeof config.model !== 'string')),
    ...(config.taskModelOverride !== undefined ? { taskModelOverride: readBotTaskModelOverride(config.taskModelOverride) } : {}),
    skills: strings(config.skills),
    connections: strings(config.mcpServers),
    toolsets: strings(config.toolsets),
    // Absent = every system Skill on (shared/botSystemSkills.ts).
    ...(readBotSystemSkillsOff(config.systemSkillsOff).length ? { systemSkillsOff: readBotSystemSkillsOff(config.systemSkillsOff) } : {}),
  };
}

/** Upper bound on how many Bot read positions one list call may carry. */
const MAX_READ_STATE_ENTRIES = 500;

/**
 * Parse the optional `{ lastReadAtByBotId }` body of `local-db:bots:list`.
 *
 * Hostile or stale renderer input must never break the Bots list, so anything
 * unparseable is dropped silently instead of failing the whole projection.
 */
function readLastReadAtMap(raw: unknown): Map<string, number> {
  const out = new Map<string, number>();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const value = (raw as { lastReadAtByBotId?: unknown }).lastReadAtByBotId;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [botId, at] of Object.entries(value as Record<string, unknown>)) {
    if (out.size >= MAX_READ_STATE_ENTRIES) break;
    if (!botId || botId.length > 128) continue;
    if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) continue;
    out.set(botId, Math.floor(at));
  }
  return out;
}

async function fileExists(candidate: string): Promise<boolean> {
  try {
    await fs.access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function defaultNewBotCapabilities(): Promise<Record<string, unknown>> {
  const modelChain = await readEffectiveBotModelChain({
    modelChainOverride: null,
    modelOverride: null,
  });
  const primary = modelChain[0] ?? {
    harness: 'pi' as const,
    model: '',
    providerId: null,
    effort: '',
    fastMode: false,
  };
  return {
    ...primary,
    modelOverride: null,
    modelChain,
    modelChainOverride: null,
    skillMode: 'allowlist',
    skillsExcluded: [],
    toolCapabilityVersion: 1,
    toolsetMode: 'inherit',
    toolsets: [],
    mcpMode: 'inherit',
    mcpServers: [],
    memory: true,
    permissions: 'auto',
  };
}

export function broadcastBotProfileChanged(payload: {
  botId: string;
  change: 'created' | 'updated';
}): void {
  broadcastBotRemoteResourceChanged(payload.botId);
  // 伙伴自主跟进：新建伙伴、改「它开的任务也交给总调度跟」立即生效。
  signalBotAutonomyBotsChanged();
  if (payload.change === 'updated') notifyAgentIslandCompanionChanged(payload.botId);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    try {
      win.webContents.send(MAKER_PUSH.BOT_PROFILE_CHANGED, payload);
    } catch (error) {
      log.warn('Bot profile broadcast failed', { error: String(error) });
    }
  }
}

/** Resume persisted invitations without reinstalling retired template capabilities. */
export async function recoverActiveTeammateInvitations(): Promise<void> {
  if (isAppSessionBoundaryPending()) return;
  const client = tryGetDbClient();
  if (!client) return;
  const owner = captureBotOperationOwner();
  try {
    const profiles = await client.drizzle
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(ne(botProfiles.status, 'archived'));
    owner.assertCurrent();
    for (const { id } of profiles) queueBotInvitation(id);
  } catch (cause) {
    log.warn('recover pending teammate invitations failed', {
      error: cause instanceof Error ? cause.name : typeof cause,
    });
  }
}


/** Shared image write; callers supply validated bytes, never a remote filesystem path. */
export async function setBotProfileAvatar(botId: string, image: { buffer: Buffer; mimeType: string }, expectedVersion?: number, expectedAvatar?: string) {
  const ownerBoundary = captureBotOperationOwner();
  const client = getDbClient();
  const db = client.drizzle;
    const [current] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    if (!current) throwIpcError('NOT_FOUND', 'Bot 不存在');
    if (expectedVersion !== undefined && current.currentVersion !== expectedVersion) throwIpcError('PRECONDITION_FAILED', 'Teammate changed');
    if (current.status === 'archived') {
      throwIpcError('PRECONDITION_FAILED', '已停止的 Bot 不能修改头像');
    }
    const [version] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, botId),
          eq(botProfileVersions.version, current.currentVersion),
        ),
      )
      .limit(1);
    if (!version) throwIpcError('PRECONDITION_FAILED', 'Bot Profile 版本不存在');

    // The file bytes are published first, then the profile address and durable
    // reference move together in one SQLite transaction. If the transaction
    // loses a race, the unreferenced content-addressed blob is recycler-safe.
    ownerBoundary.assertCurrent();
    const written = await storeTeammateAvatarImage(image, db, ownerBoundary.assertCurrent);
    const capabilities = parseJson(version.capabilitiesJson);
    const clearsFallback = capabilities.cloudAvatarFallback === true;
    delete capabilities.cloudAvatarFallback;
    const now = Date.now();
    await client.tx('bots.updateProfile', {
      id: botId,
      avatar: written.url,
      identitySource: version.identitySource,
      capabilitiesJson: safeJson(capabilities),
      profileContentChanged: clearsFallback,
      expectedCurrentVersion: current.currentVersion,
      expectedAvatar: expectedAvatar ?? current.avatar,
      botAvatarRef: { id: randomUUID(), hash: written.hash, createdAt: now },
      now,
    });
    ownerBoundary.assertCurrent();
    const profile = await readProfile(client, botId);
    ownerBoundary.assertCurrent();
    broadcastBotProfileChanged({ botId, change: 'updated' });
    return profile;
}

/**
 * Trusted, main-only inputs of a companion restored from the cloud (cloud-companions.md §3.1):
 * the preset it was made from, provenance of a local stand-in avatar, whether the cloud
 * profile replaces a copy whose first meeting never finished, and whether its name may
 * equal another companion's here (the default Cindy stays unique).
 * Never reachable from a renderer or model body. The stand-in marker lives in
 * the profile transaction, not in disposable companion sync bookkeeping.
 */
export interface RestoredBotOrigin { templateId?: unknown; avatarFallback?: boolean; replacesUnfinishedMeeting?: true; allowSameName?: true }

/** Main-owned creation path shared by the renderer and Bot runtime tools. */
export async function createBotProfile(raw: unknown, restored?: RestoredBotOrigin) {
  const body =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const draftEntry = body.creationDraftToken ? readBotCreationDraft(body.creationDraftToken) : undefined;
  const name = readText(body.name ?? body.displayName, 'name', 200, true);
  const description = readText(body.description, 'description', draftEntry ? 2000 : 12000);
  const id =
    draftEntry?.botId || readText(body.id, 'id', 128) || `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  // New identities must map one-to-one to portable directory names. Keep the
  // legacy directory resolver unchanged so existing profiles still open.
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(id)) {
    throwIpcError('INVALID_PARAMS', 'Bot id must be a lowercase portable directory identifier');
  }
  // Retired sentinels are accepted only when explicitly supplied by an older client.
  const requestedAvatar = readBotAvatar(body.avatar);
  // Managed addresses must come from validated image bytes ingested below,
  // never from a renderer or model supplying a URL string alone.
  let avatar = portableBotAvatarOrFallback(requestedAvatar);
  const avatarImage = decodeBotAvatarImage(body.avatarImageBase64);
  const avatarColor = readText(body.avatarColor, 'avatarColor', 32) || 'violet';
  const identitySource =
    (draftEntry ? `${draftEntry.draft.background}\n\n${draftEntry.draft.conversationStyle}\n\nCurrent profile:\n${name}\n${description}` : readText(body.identitySource, 'identitySource', 12000)) || buildDefaultBotIdentity(name, description);
  const skills = draftEntry ? draftEntry.draft.skillRefs : Array.isArray(body.skills)
    ? body.skills.filter((item): item is string => typeof item === 'string').slice(0, 100)
    : [];
  // Older clients may request a welcome; its supplied text is never an assistant message.
  const prepareInvitation = body.prepareInvitation === true || Boolean(readText(body.welcomeMessage, 'welcomeMessage'));
  const hasRequestedCapabilities =
    body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities);
  const requestedCapabilities = hasRequestedCapabilities
    ? (body.capabilities as Record<string, unknown>)
    : {};
  const userContextSource = readText(body.userContextSource, 'userContextSource', 12000);
  const gender = readBotGender(body.gender);
  // Old clients may still submit retired template ids with a complete profile.
  // Accept those as ordinary teammates, without installing or reconstructing a template.
  const retiredTemplate = body.templateId === 'dash' || body.templateId === 'lizi';
  const templateId = retiredTemplate ? undefined : body.templateId;
  if (draftEntry && templateId !== undefined) throwIpcError('INVALID_PARAMS', '请选择创建伙伴或预设伙伴');
  if (templateId !== undefined && !isBotTemplatePresetId(templateId)) {
    throwIpcError('INVALID_PARAMS', '未知的伙伴模板');
  }
  const creationOwnerBoundary = {
    scopeKey: activeOwnerScopeKey(),
    userDataDir: ownerScopedUserDataPath(),
  };
  const assertCreationOwnerStillCurrent = () => {
    if (
      isAppSessionBoundaryPending() ||
      activeOwnerScopeKey() !== creationOwnerBoundary.scopeKey
    ) {
      throwIpcError('PRECONDITION_FAILED', '账号已切换，请在当前账号重新创建伙伴');
    }
  };
  if (isAppSessionBoundaryPending()) {
    throwIpcError('PRECONDITION_FAILED', '账号正在切换，请稍后重试');
  }
  const persistedCapabilities = normalizeBotModelCapabilitiesOrThrow({
    permissions: 'auto',
    toolsetMode: 'inherit',
    mcpMode: 'inherit',
    ...(hasRequestedCapabilities ? {} : await defaultNewBotCapabilities()),
    ...requestedCapabilities,
    toolCapabilityVersion: 1,
    skills,
    ...(draftEntry ? { skillMode: 'allowlist', mcpMode: 'inherit', mcpServers: draftEntry.draft.mcpRefs, toolsetMode: 'inherit', toolsets: draftEntry.draft.toolsetRefs } : {}),
    userContextSource,
    ...(gender ? { gender } : {}),
  });
  // Progress is main-owned; callers can request an invitation, never supply its result.
  delete persistedCapabilities.invitation;
  delete persistedCapabilities.templateId;
  delete persistedCapabilities.cloudAvatarFallback;
  if (restored?.avatarFallback === true) persistedCapabilities.cloudAvatarFallback = true;
  if (templateId) persistedCapabilities.templateId = templateId;
  else if (isBotTemplatePresetId(restored?.templateId)) persistedCapabilities.templateId = restored.templateId;
  if (prepareInvitation) persistedCapabilities.invitation = {
    id: randomUUID(), stage: 'skills', locale: readBotInvitationLocale(body.locale),
    avatarRequested: body.generateAvatar === true && !avatarImage,
    welcomeContext: normalizeBotWelcomeContext(body.welcomeContext),
    ...(draftEntry ? { draft: { ...draftEntry.draft, background: `${draftEntry.draft.background}\n\nCurrent profile (use this name and introduction):\n${name}\n${description}` } } : {}),
  };
  const now = Date.now();
  const client = getDbClient();
  const db = client.drizzle;
  let botAvatarRef: { id: string; hash: string; createdAt: number } | undefined;
  const existingIds = await db.select({ id: botProfiles.id }).from(botProfiles);
  assertCreationOwnerStillCurrent();
  if (draftEntry && existingIds.some(p => p.id === id)) return readProfile(client, id);
  if (templateId === 'cindy') {
    const existingCindy = await findExistingCindy(client);
    assertCreationOwnerStillCurrent();
    if (existingCindy?.status === 'deleting') throwIpcError('PRECONDITION_FAILED', 'Cindy 正在删除，请稍后重试');
    if (existingCindy) return existingCindy;
  }
  assertCreationOwnerStillCurrent();
  const newHome = botProfileDir(creationOwnerBoundary.userDataDir, id).toLowerCase();
  if (existingIds.some((profile) => botProfileDir(creationOwnerBoundary.userDataDir, profile.id).toLowerCase() === newHome)) {
    throwIpcError('ALREADY_EXISTS', 'Bot home already belongs to another profile');
  }
  const selectedImage = avatarImage ?? (!requestedAvatar ? await readDefaultTeammatePortrait(existingIds.length) : null);
  if (selectedImage) {
    const written = await storeTeammateAvatarImage(selectedImage, db, assertCreationOwnerStillCurrent);
    avatar = written.url;
    botAvatarRef = { id: randomUUID(), hash: written.hash, createdAt: now };
  }
  try {
  await client.tx('bots.createProfile', {
    id,
    ...(botAvatarRef ? { botAvatarRef } : {}),
    displayName: name,
    description,
    avatar,
    avatarColor,
    identitySource,
    capabilitiesJson: safeJson(persistedCapabilities),
    ...(restored?.allowSameName === true ? { allowDuplicateName: true } : {}),
    now,
  });
  } catch (error) {
    assertCreationOwnerStillCurrent();
    if (templateId === 'cindy' && (error as { code?: string }).code === 'ALREADY_EXISTS') {
      const existing = await findExistingCindy(client);
      if (existing?.status === 'deleting') throwIpcError('PRECONDITION_FAILED', 'Cindy 正在删除，请稍后重试');
      if (existing) return existing;
    }
    if ((error as { code?: string }).code === 'ALREADY_EXISTS') throwIpcError('ALREADY_EXISTS', '已有同名伙伴，请换一个名字');
    throw error;
  }
  assertCreationOwnerStillCurrent();
  if (prepareInvitation) {
    // Creation is already committed. A fallible presentation read must not
    // strand that durable invitation before it reaches the runtime queue.
    queueBotInvitation(id);
    const profile = await readProfile(client, id);
    broadcastBotProfileChanged({ botId: id, change: 'created' });
    return profile;
  }
  await syncBotProfileFolder(
    id,
    { identitySource, userContextSource: botUserContextSource(persistedCapabilities) },
    creationOwnerBoundary.userDataDir,
  );
  assertCreationOwnerStillCurrent();
  const profile = await readProfile(client, id);
  assertCreationOwnerStillCurrent();
  broadcastBotProfileChanged({ botId: id, change: 'created' });
  return profile;
}

/** Caller holds the original lifecycle lock; only fully saved native imports reach here. */
export async function prepareImportedBotInvitation(botId: string, requestId: string, locale?: string,
  opening?: BotPackageOpening): Promise<void> {
  const owner = captureBotOperationOwner();
  const client = getDbClient();
  const [profile] = await client.drizzle.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
  owner.assertCurrent();
  if (!profile || profile.status === 'deleting' || profile.status === 'archived') throwIpcError('NOT_FOUND', 'Bot 不存在');
  const [version] = await client.drizzle.select().from(botProfileVersions).where(and(
    eq(botProfileVersions.botId, botId), eq(botProfileVersions.version, profile.currentVersion),
  )).limit(1);
  owner.assertCurrent();
  if (!version) throwIpcError('NOT_FOUND', 'Bot 不存在');
  const config = parseJson(version.capabilitiesJson);
  // The original invitation is the only welcome receipt, including failures and ready.
  if (config.invitation) return;
  await client.tx('bots.updateProfile', { id: botId, expectedCurrentVersion: profile.currentVersion,
    identitySource: version.identitySource,
    capabilitiesJson: JSON.stringify({ ...config, invitation: { id: `import-welcome:${requestId}`,
      stage: 'welcome', locale: readBotInvitationLocale(locale), avatarRequested: false,
      // The package opening shapes the greeting and its one onboarding turn.
      ...(opening ? { opening } : {}) } }),
    profileContentChanged: true, now: Date.now(),
  });
  owner.assertCurrent();
  broadcastBotProfileChanged({ botId, change: 'updated' });
  queueBotInvitation(botId);
}

/** Shared profile mutation for trusted settings and owner-bound capability selection. */
export async function updateBotProfile(raw: unknown, expectedVersion?: number,
  validateAdditions?: (update: BotCapabilityUpdate) => Promise<void>, restored?: RestoredBotOrigin) {
  const body =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const id = readText(body.id, 'botId', 128, true);
  const owner = captureBotOperationOwner();
  const client = getDbClient();
  if (body.retryInvitation === true) {
    queueBotInvitation(id, true);
    return readProfile(client, id);
  }
  const db = client.drizzle;
  const [current] = await db.select().from(botProfiles).where(eq(botProfiles.id, id)).limit(1);
  if (!current) throwIpcError('NOT_FOUND', 'Bot 不存在');
  // Explicit recovery accepts the saved choice, rather than guessing that an
  // unversioned automation baseline is stale because its provider is missing.
  const acceptsSavedModel = body.acceptSavedModelSelectionVersion !== undefined;
  if (acceptsSavedModel && (!Number.isSafeInteger(body.acceptSavedModelSelectionVersion)
    || (body.acceptSavedModelSelectionVersion as number) < 1)) {
    throwIpcError('INVALID_PARAMS', 'acceptSavedModelSelectionVersion must be a positive integer');
  }
  if (acceptsSavedModel && current.currentVersion !== body.acceptSavedModelSelectionVersion) {
    throwIpcError('PRECONDITION_FAILED', '伙伴配置已更新，请重新读取后重试');
  }
  if (expectedVersion !== undefined && current.currentVersion !== expectedVersion) {
    throwIpcError('PRECONDITION_FAILED', '伙伴配置已更新，请重新读取后重试');
  }
  const now = Date.now();
  const patch: Partial<typeof botProfiles.$inferInsert> = { updatedAt: now };
  if (body.name !== undefined || body.displayName !== undefined)
    patch.displayName = readText(body.name ?? body.displayName, 'name', 200, true);
  // Same bound as creation and `update_teammate_profile`: a description created
  // there must stay editable here.
  if (body.description !== undefined)
    patch.description = readText(body.description, 'description', 12000);

  const expectedAvatar =
    body.avatar !== undefined && body.expectedAvatar !== undefined
      ? readBotAvatar(body.expectedAvatar, true)
      : current.avatar;
  if (body.avatar !== undefined) {
    const nextAvatar = readBotAvatar(body.avatar, true);
    if (isManagedBotAvatarUrl(nextAvatar) && nextAvatar !== current.avatar) {
      throwIpcError('INVALID_PARAMS', '请通过头像选择器上传图片');
    }
    // A delayed full-form autosave must not roll back an avatar that won in
    // another window. An idempotent echo of the winner remains harmless.
    if (expectedAvatar === current.avatar || nextAvatar === current.avatar) {
      patch.avatar = nextAvatar;
    }
  }
  if (body.avatarColor !== undefined)
    patch.avatarColor = readText(body.avatarColor, 'avatarColor', 32, true);
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean')
      throwIpcError('INVALID_PARAMS', 'enabled 必须是 boolean');
    patch.status = body.enabled ? 'active' : 'paused';
  }
  const hiddenAt =
    body.hidden === undefined
      ? undefined
      : body.hidden === true
        ? now
        : body.hidden === false
          ? null
          : throwIpcError('INVALID_PARAMS', 'hidden 必须是 boolean');
  const pinnedAt =
    body.pinned === undefined
      ? undefined
      : body.pinned === true
        ? now
        : body.pinned === false
          ? null
          : throwIpcError('INVALID_PARAMS', 'pinned 必须是 boolean');
  const [version] = await db
    .select()
    .from(botProfileVersions)
    .where(
      and(
        eq(botProfileVersions.botId, id),
        eq(botProfileVersions.version, current.currentVersion),
      ),
    )
    .limit(1);
  const previous = parseJson(version?.capabilitiesJson ?? '{}');
  const preparation = botInvitationProgress(previous.invitation);
  const retryingPortrait = preparation?.stage === 'avatar' && current.canonicalSessionId;
  // A take-over replaces this copy with the cloud profile: its own meeting no longer means anything.
  const droppingMeeting = restored?.replacesUnfinishedMeeting === true && !!preparation && preparation.stage !== 'ready';
  if (preparation && preparation.stage !== 'ready' && !retryingPortrait && !droppingMeeting && (body.name !== undefined || body.description !== undefined || body.identitySource !== undefined)) {
    throwIpcError('PRECONDITION_FAILED', '伙伴正在准备见面，请完成准备后再编辑资料');
  }
  const nextConfig = mergeBotProfileCapabilities({
    previous,
    capabilities:
      body.capabilities &&
      typeof body.capabilities === 'object' &&
      !Array.isArray(body.capabilities)
        ? (body.capabilities as Record<string, unknown>)
        : undefined,
    skills: body.skills,
    hasSkills: Object.prototype.hasOwnProperty.call(body, 'skills'),
    capabilityBaseline: body.capabilityBaseline,
  });
  // Template identity survives renames and cannot be replaced through settings.
  const retainedTemplate = typeof previous.templateId === 'string' ? previous.templateId
    : isBotTemplatePresetId(restored?.templateId) ? restored.templateId
      : inferBotTemplatePresetId(version?.identitySource ?? '');
  if (retainedTemplate) nextConfig.templateId = retainedTemplate;
  else delete nextConfig.templateId;
  // Keep preparation checkpoints outside caller-editable capabilities. Dropping the record also
  // stops a running or recovered invitation (it ends as INVITATION_REPLACED) from greeting again.
  if (previous.invitation && !droppingMeeting) nextConfig.invitation = previous.invitation;
  else delete nextConfig.invitation;
  // Only cloud restoration can set/reset this provenance; ordinary settings
  // edits (including stale full-form saves) cannot release it. A real image
  // clears it atomically in setBotProfileAvatar.
  if (restored?.avatarFallback ?? (previous.cloudAvatarFallback === true)) nextConfig.cloudAvatarFallback = true;
  else delete nextConfig.cloudAvatarFallback;
  if (Object.prototype.hasOwnProperty.call(body, 'userContextSource')) {
    nextConfig.userContextSource = readText(body.userContextSource, 'userContextSource', 12000);
  }
  // 没显式传就保持原值(mergeBotProfileCapabilities 已经把 previous 整份带过来了),
  // 显式传脏值则清掉 —— 与 readBotGender 的口径一致。
  if (Object.prototype.hasOwnProperty.call(body, 'gender')) {
    const nextGender = readBotGender(body.gender);
    if (nextGender) nextConfig.gender = nextGender;
    else delete nextConfig.gender;
  }
  const normalizedNextConfig = normalizeBotModelCapabilitiesOrThrow(nextConfig);
  // Legacy chain-only profiles gain mirrored fields during normalization.
  // Compare the same representation so unrelated edits do not validate stale routes.
  const modelSelectionChanged = botProfileModelSelectionChanged(normalizeBotModelCapabilitiesOrThrow(previous), normalizedNextConfig);
  const acceptsModelSelection = modelSelectionChanged || acceptsSavedModel;
  if (acceptsModelSelection) {
    const primary = (await readEffectiveBotModelChain(normalizedNextConfig))[0];
    owner.assertCurrent();
    if (!primary || !await validateTaskModel(primary)) {
      throwIpcError('INVALID_PARAMS', 'Model route unavailable');
    }
    owner.assertCurrent();
  }
  if (JSON.stringify(previous.taskModelOverride ?? null) !== JSON.stringify(normalizedNextConfig.taskModelOverride ?? null)) {
    const taskModel = readBotTaskModelOverride(normalizedNextConfig.taskModelOverride);
    if (taskModel && !await validateTaskModel(taskModel)) {
      throwIpcError('INVALID_PARAMS', '任务模型不可用，请重新选择模型、来源与引擎');
    }
    owner.assertCurrent();
  }
  const nextIdentitySource =
    body.identitySource !== undefined
      ? readText(body.identitySource, 'identitySource', 12000) ||
        buildDefaultBotIdentity(patch.displayName ?? current.displayName, patch.description ?? current.description)
      : (version?.identitySource ?? '');
  const profileContentChanged = botProfileContentChanged({
    previousCapabilities: previous,
    nextCapabilities: normalizedNextConfig,
    previousIdentitySource: version?.identitySource ?? '',
    nextIdentitySource,
  }) || (patch.displayName !== undefined && patch.displayName !== current.displayName)
    || (patch.description !== undefined && patch.description !== current.description);
  // Only the renderer save boundary needs this hook; model-side selections already validate
  // before calling this function. Both paths retain the transaction's profile-version CAS.
  await validateAdditions?.({ botId: id, canonicalSessionId: current.canonicalSessionId,
    previous, next: normalizedNextConfig });
  owner.assertCurrent();
  const changesPermissions = body.capabilities != null && typeof body.capabilities === 'object'
    && Object.prototype.hasOwnProperty.call(body.capabilities, 'permissions');
  const modelFollowers = acceptsModelSelection ? await db.select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks).where(and(eq(botSessionLinks.botId, id),
      inArray(botSessionLinks.role, ['canonical', 'group', 'channel', 'thread', 'routine']),
      isNull(botSessionLinks.archivedAt))) : [];
  const commitProfile = async () => {
    await coordinateBotModelSelection(modelFollowers.map((link) => link.sessionId), async () => {
      // Hold send locks only through persistence/invalidation, not runtime
      // permission refresh, which may wait for the current turn to finish.
      owner.assertCurrent();
      await client.tx('bots.updateProfile', {
        id,
        ...(acceptsModelSelection ? { clearScheduledModelBaseline: true } : {}),
        ...(changesPermissions ? { canonicalPermissionMode: botSessionPermissionMode(normalizedNextConfig) } : {}),
        ...(restored?.allowSameName === true ? { allowDuplicateName: true } : {}),
        ...(patch.displayName !== undefined ? { displayName: patch.displayName } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
        ...(patch.avatarColor !== undefined ? { avatarColor: patch.avatarColor } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(hiddenAt !== undefined ? { hiddenAt } : {}),
        ...(pinnedAt !== undefined ? { pinnedAt } : {}),
        identitySource: nextIdentitySource,
        capabilitiesJson: safeJson(normalizedNextConfig),
        profileContentChanged,
        expectedCurrentVersion: current.currentVersion,
        clearBotAvatarRefs:
          patch.avatar !== undefined &&
          isManagedBotAvatarUrl(current.avatar) &&
          !isManagedBotAvatarUrl(patch.avatar),
        now,
      });
    });
    owner.assertCurrent();
    if (changesPermissions) {
      // Read the committed canonical row: profile and chat permissions change together,
      // and a concurrent newer settings save must not be rolled back by this continuation.
      const [canonical] = await db.select({ sessionId: botSessionLinks.sessionId, mode: sessions.permissionMode })
        .from(botSessionLinks).innerJoin(sessions, eq(sessions.id, botSessionLinks.sessionId))
        .where(and(eq(botSessionLinks.botId, id), eq(botSessionLinks.role, 'canonical'), isNull(botSessionLinks.archivedAt))).limit(1);
      owner.assertCurrent();
      try {
        if (canonical) {
          const maker = getMakerIfReady();
          const live = maker?.getSession(canonical.sessionId);
          try { await live?.setPermissionMode(canonical.mode as 'ask' | 'auto' | 'bypassPermissions'); }
          catch (error) {
            // A failed hot switch cannot leave the old, more permissive runtime alive.
            owner.assertCurrent();
            if (maker?.getSession(canonical.sessionId) === live) await maker?.closeSession(canonical.sessionId);
            throw error;
          }
          owner.assertCurrent();
          broadcastSessionPatched(canonical.sessionId, { permissionMode: canonical.mode });
        }
      } finally {
        owner.assertCurrent();
        await syncBotPermissionsByBotId(id, canonical?.sessionId);
      }
    }
  };
  if (changesPermissions) {
    const [canonical] = await db.select({ sessionId: botSessionLinks.sessionId }).from(botSessionLinks)
      .where(and(eq(botSessionLinks.botId, id), eq(botSessionLinks.role, 'canonical'), isNull(botSessionLinks.archivedAt))).limit(1);
    owner.assertCurrent();
    // Serialize the DB commit and runtime continuation together with the chat
    // permission chip; native Session serialization alone only orders transports.
    await withBotPermissionChangeForBot(id, async () => {
      if (canonical) await withSessionPermissionChange(canonical.sessionId, commitProfile);
      else await commitProfile();
    });
  } else await commitProfile();
  // The files are the user's editing surface: rewrite only the file whose content this
  // save changed, so pinning, a model change or editing the other file cannot clobber
  // hand edits that have not been reconciled yet.
  const nextUserContextSource = botUserContextSource(normalizedNextConfig);
  const folderPatch = {
    ...(nextIdentitySource !== (version?.identitySource ?? '') ? { identitySource: nextIdentitySource } : {}),
    ...(nextUserContextSource !== botUserContextSource(previous) ? { userContextSource: nextUserContextSource } : {}),
  };
  await ensureBotProfileFolderSeeded(id, nextIdentitySource, normalizedNextConfig, owner.userDataDir);
  owner.assertCurrent();
  if (Object.keys(folderPatch).length > 0) {
    await syncBotProfileFolder(id, folderPatch, owner.userDataDir);
    owner.assertCurrent();
  }
  if (profileContentChanged || acceptsSavedModel) {
    const [canonical] = await db
      .select({ sessionId: botSessionLinks.sessionId })
      .from(botSessionLinks)
      .where(
        and(
          eq(botSessionLinks.botId, id),
          eq(botSessionLinks.role, 'canonical'),
          isNull(botSessionLinks.archivedAt),
        ),
      )
    .limit(1);
    owner.assertCurrent();
    if (canonical) requestBotRuntimeEpochRefresh(canonical.sessionId,
      acceptsModelSelection ? 'model' : 'profile');
  }
  const profile = await readProfile(client, id);
  owner.assertCurrent();
  broadcastBotProfileChanged({ botId: id, change: 'updated' });
  return profile;
}

async function findExistingCindy(client: ReturnType<typeof getDbClient>) {
  const rows = await client.drizzle.select({ id: botProfiles.id, config: botProfileVersions.capabilitiesJson, identity: botProfileVersions.identitySource }).from(botProfiles).innerJoin(botProfileVersions, and(eq(botProfileVersions.botId, botProfiles.id), eq(botProfileVersions.version, botProfiles.currentVersion))).where(ne(botProfiles.status, 'archived')).orderBy(botProfiles.createdAt);
  const existing = rows.find(row => parseJson(row.config).templateId === 'cindy' || inferBotTemplatePresetId(row.identity) === 'cindy');
  return existing ? readProfile(client, existing.id) : null;
}

/** Teammate history search; the local settings IPC and the remote settings host share it. */
export async function searchBotHistory(botId: string, query: string, limit: number) {
  const db = getDbClient().drizzle;
  const [profile] = await db
    .select({ id: botProfiles.id })
    .from(botProfiles)
    .where(eq(botProfiles.id, botId))
    .limit(1);
  if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
  // Group / IM channel lanes only hold hidden channel turns; the group chat or
  // the IM conversation itself is the user's record.
  const links = await db
    .select({ sessionId: botSessionLinks.sessionId })
    .from(botSessionLinks)
    .where(and(
      eq(botSessionLinks.botId, botId),
      ne(botSessionLinks.role, 'group'),
      ne(botSessionLinks.role, 'channel'),
    ));
  return searchConversations(
    {
      query,
      limit,
      semanticMode: 'hybrid',
      filters: {
        status: 'all',
        sessionIds: links.map((row) => row.sessionId),
      },
    },
    // The Bot-owned Session id set above is authoritative. Passing null here
    // allows migrated IM history to retain its original source while keeping
    // the renderer unable to widen the search scope.
    { sessionSources: null },
  );
}

export function registerBotIpc(): void {
  ipcMain.handle('local-db:bots:generate-avatar', async (event, token: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (typeof token !== 'string') throwIpcError('INVALID_PARAMS', 'Invalid draft');
    try { return await generateBotCreationAvatar(token); }
    catch { throwIpcError('INTERNAL', '头像生成失败，可以继续使用当前头像'); }
  });
  ipcMain.handle('local-db:bots:generate-draft', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const owner = captureBotOperationOwner();
    const profiles = await getDbClient().drizzle.select({ name: botProfiles.displayName }).from(botProfiles).where(ne(botProfiles.status, 'archived'));
    owner.assertCurrent();
    return generateBotCreationDraft(raw, profiles.map(p => p.name));
  });
  setRemoteBotSessionLookup(readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch);
  ipcMain.handle('local-db:bots:model-chain-settings-get', async (event) => {
    assertTrustedAppRendererEvent(event);
    const state = await readBotModelChainSettingsState();
    return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
  });

  ipcMain.handle('local-db:bots:model-chain-settings-set', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const state = await writeBotModelChainSettings(body.modelChain);
    return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
  });

  // Global model preferences are desktop-local settings, like get/set above.
  ipcMain.handle('local-db:bots:model-chain-settings-reset', async (event) => {
    assertTrustedAppRendererEvent(event);
    const owner = captureBotOperationOwner();
    try {
      const state = await resetBotModelChainSettings();
      owner.assertCurrent();
      return { modelChain: state.value.modelChain, isCustomized: state.isCustomized };
    } catch {
      owner.assertCurrent();
      throwIpcError('INTERNAL', 'Could not restore Bot model defaults');
    }
  });

  ipcMain.handle('local-db:bots:list', async (event, raw: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const client = tryGetDbClient();
    if (!client) return [];
    const owner = captureBotOperationOwner();
    const welcomeContext = !remote && raw && typeof raw === 'object'
      ? normalizeBotWelcomeContext((raw as Record<string, unknown>).welcomeContext) : undefined;
    const locale = !remote && raw && typeof raw === 'object'
      ? readBotInvitationLocale((raw as Record<string, unknown>).locale) : undefined;
    await provisionDefaultBotForList(client, owner, welcomeContext, locale);
    const db = client.drizzle;
    // Unread accounting is opt-in: the read position lives in the renderer, so
    // a caller that has none (device-link, first boot) simply gets zeros.
    const lastReadAtByBotId = remote ? new Map<string, number>() : readLastReadAtMap(raw);
    const profiles = await db
      .select({ id: botProfiles.id, status: botProfiles.status })
      .from(botProfiles)
      .orderBy(desc(botProfiles.updatedAt));
    // Resume persisted invitations only; listing existing teammates never seeds Skills.
    if (!remote) {
      for (const { id, status } of profiles) {
        if (status !== 'archived') queueBotInvitation(id);
      }
    }
    const results = [];
    for (const { id } of profiles) {
      owner.assertCurrent();
      results.push(await (remote
        ? readRemoteBotProfile(client, id)
        : readProfile(client, id, lastReadAtByBotId.get(id) ?? null)));
    }
    owner.assertCurrent();
    return results.filter((profile) => profile !== null);
  });

  ipcMain.handle('local-db:bots:get', async (event, rawId: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const client = getDbClient();
    const botId = requireString(rawId, 'botId');
    if (!remote) return readProfile(client, botId);
    const profile = await readRemoteBotProfile(client, botId);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    return profile;
  });

  // Source preparation is local-only and account-independent, including for a
  // Bot that has not been created yet. Saving still uses choose-avatar below.
  ipcMain.handle('local-db:bots:choose-avatar-source', async (event) => {
    assertTrustedAppRendererEvent(event);
    const boundary = captureBotOperationOwner();
    const owner = BrowserWindow.fromWebContents(event.sender);
    const source = await chooseAvatarSource({
      showAvatarOpenDialog: async () => {
        const options: OpenDialogOptions = {
          properties: ['openFile'],
          filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        };
        const selection = owner
          ? await dialog.showOpenDialog(owner, options)
          : await dialog.showOpenDialog(options);
        return selection.canceled ? null : selection.filePaths[0] ?? null;
      },
      readFile: (filePath) => fs.readFile(filePath),
      toSdrAvatar: toSdrAvatarImage,
    });
    boundary.assertCurrent();
    return source;
  });

  ipcMain.handle('local-db:bots:choose-avatar', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const ownerBoundary = captureBotOperationOwner();
    const client = getDbClient();
    const db = client.drizzle;
    const [initial] = await db
      .select({ status: botProfiles.status })
      .from(botProfiles)
      .where(eq(botProfiles.id, botId))
      .limit(1);
    if (!initial) throwIpcError('NOT_FOUND', 'Bot 不存在');
    if (initial.status === 'archived') {
      throwIpcError('PRECONDITION_FAILED', '已停止的 Bot 不能修改头像');
    }
    // Gallery selections use the same bounded byte validation as creation.
    // Omitted bytes retain the native file chooser for existing callers.
    let image = decodeBotAvatarImage(body.avatarImageBase64);
    if (!image) {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      };
      const selection = owner
        ? await dialog.showOpenDialog(owner, options)
        : await dialog.showOpenDialog(options);
      ownerBoundary.assertCurrent();
      if (selection.canceled || !selection.filePaths[0]) return { canceled: true };

      let buffer: Buffer;
      try {
        buffer = await fs.readFile(selection.filePaths[0]);
      } catch {
        throwIpcError('INVALID_PARAMS', '头像文件无法读取');
      }
      image = { buffer, mimeType: validateBotAvatarBuffer(buffer) };
    }
    ownerBoundary.assertCurrent();

    return { canceled: false, profile: await setBotProfileAvatar(botId, image) };
  });

  ipcMain.handle('local-db:bots:search-history', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    const query = readText(body.query, 'query', 500, true);
    const limit =
      typeof body.limit === 'number' && Number.isFinite(body.limit)
        ? Math.max(1, Math.min(50, Math.floor(body.limit)))
        : 20;
    return searchBotHistory(botId, query, limit);
  });

  ipcMain.handle('local-db:bots:create', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    if (body.prepareInvitation === true) {
      const owner = captureBotOperationOwner();
      const capabilities = body.capabilities && typeof body.capabilities === 'object' && !Array.isArray(body.capabilities)
        ? body.capabilities as Record<string, unknown> : {};
      const [primary] = await readEffectiveBotModelChain(capabilities);
      owner.assertCurrent();
      const available = primary && await validateTaskModel(primary);
      owner.assertCurrent();
      if (!available) throwIpcError('INVALID_PARAMS', 'Model route unavailable');
    }
    return createBotProfile(raw);
  });

  ipcMain.handle('local-db:bots:update', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    return updateBotProfile(raw, undefined, validateBotCapabilityAdditions);
  });

  const createBotCanonicalSessionUnlocked = async (
    input: CreateBotCanonicalSessionInput,
    beforeCommit?: () => Promise<void>,
  ): Promise<CreateBotCanonicalSessionResult> => {
    const botId = readText(input.botId, 'botId', 128, true);
    const expectedCanonicalSessionId = input.expectedCanonicalSessionId;
    if (!Number.isInteger(input.expectedProfileVersion) || input.expectedProfileVersion < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedProfileVersion 必须是正整数');
    }
    const expectedProfileVersion = input.expectedProfileVersion;
    const owner = captureBotOperationOwner();
    const client = getDbClient();
    const db = client.drizzle;
    const [profile] = await db.select().from(botProfiles).where(eq(botProfiles.id, botId)).limit(1);
    if (!profile) throwIpcError('NOT_FOUND', 'Bot 不存在');
    if (profile.status !== 'active' && profile.status !== 'paused') {
      throwIpcError('PRECONDITION_FAILED', `Bot 当前状态为 ${profile.status}`);
    }
    const canonicalResolution = await reconcileCanonicalLink(botId, client);
    const authoritativeCanonicalSessionId = canonicalResolution.canonicalSessionId;
    const recoverableCompatibilityMirror =
      input.recoverMissingOnly === true &&
      canonicalResolution.status === 'missing-session' &&
      profile.canonicalSessionId === expectedCanonicalSessionId;
    if (input.recoverMissingOnly) {
      if (
        !expectedCanonicalSessionId ||
        (authoritativeCanonicalSessionId !== expectedCanonicalSessionId &&
          !recoverableCompatibilityMirror)
      ) {
        throwIpcError('PRECONDITION_FAILED', 'Bot 主任务已变化，请刷新后重试');
      }
      const [existingCanonical] = await db
        .select({ id: sessions.id, status: sessions.status })
        .from(sessions)
        .where(eq(sessions.id, expectedCanonicalSessionId))
        .limit(1);
      if (existingCanonical && existingCanonical.status !== 'deleted') {
        throwIpcError('PRECONDITION_FAILED', 'Bot 主任务仍然存在，不能按丢失任务恢复');
      }
    }
    const [profileVersion] = await db
      .select()
      .from(botProfileVersions)
      .where(
        and(
          eq(botProfileVersions.botId, botId),
          eq(botProfileVersions.version, profile.currentVersion),
        ),
      )
      .limit(1);
    if (!profileVersion) throwIpcError('PRECONDITION_FAILED', 'Bot 当前 Profile 版本不存在');

    // Ensure the Profile-owned workspace before opening the SQLite write
    // transaction. It survives every Session generation and every lost CAS.
    const now = Date.now();
    const sessionId = resolveBusinessSessionId(undefined);
    const config = parseJson(profileVersion.capabilitiesJson);
    const invitation = botInvitationProgress(config.invitation);
    if (invitation && invitation.stage !== 'ready' && invitation.stage !== 'welcome')
      throwIpcError('PRECONDITION_FAILED', '伙伴正在准备见面');
    const primaryRoute = (await readEffectiveBotModelChain(config))[0] ?? null;
    if (!primaryRoute) throwIpcError('PRECONDITION_FAILED', '请先连接模型供应商或选择伙伴模型');
    const workspaceKind = 'dialogue' as const;
    const workingDir = await ensureBotWorkspaceDir(
      owner.userDataDir,
      botId,
      app.getPath('userData'),
    );
    const insertRow = {
      ...sessionCreateToRow(
        sessionId,
        {
          workspaceKind,
          workingDir,
          ...botSessionRouteFields(config, primaryRoute),
          remoteHostId: undefined,
          source: 'bot',
        },
        now,
      ),
      title: profile.displayName,
    };
    const gitSafety = readGitSafetySettings();
    await ensureProjectGitInitialized({
      workingDir,
      workspaceKind,
      remoteHostId: null,
      sessionId,
      autoSnapshotEnabled: gitSafety.autoSnapshotEnabled,
      autoInitProjectGit: gitSafety.autoInitProjectGit,
      source: 'local-db:bots:create-canonical-session',
    });

    let canonicalSessionId: string | null = null;
    let archivedCanonicalSessionId: string | null = null;
    let created = false;
    // Profile/model/workspace preparation can outlive the originating group
    // grant. Revalidate immediately before committing the Session/link CAS.
    await beforeCommit?.();
    owner.assertCurrent();
    const result = await client.tx<BotsReplaceCanonicalSessionResult>(
      'bots.replaceCanonicalSession',
      {
        botId,
        expectedCanonicalSessionId: recoverableCompatibilityMirror
          ? null
          : expectedCanonicalSessionId,
        compatibilityMissingCanonicalSessionId: recoverableCompatibilityMirror
          ? expectedCanonicalSessionId
          : null,
        expectedProfileVersion,
        session: {
          id: insertRow.id,
          title: insertRow.title,
          workingDir: insertRow.workingDir ?? null,
          workspaceKind: insertRow.workspaceKind,
          model: insertRow.model,
          effort: insertRow.effort,
          fastMode: insertRow.fastMode,
          permissionMode: insertRow.permissionMode,
          agentKind: insertRow.agentKind,
          remoteHostId: insertRow.remoteHostId ?? null,
          providerId: insertRow.providerId ?? null,
          agentDeviceId: insertRow.agentDeviceId ?? null,
          extraDirs: insertRow.extraDirs,
          source: insertRow.source,
          createdAt: insertRow.createdAt,
          updatedAt: insertRow.updatedAt,
        },
        now,
      },
    );
    canonicalSessionId = result.canonicalSessionId;
    archivedCanonicalSessionId = result.archivedCanonicalSessionId;
    created = result.created;

    owner.assertCurrent();
    if (!canonicalSessionId) {
      throwIpcError('PRECONDITION_FAILED', 'Bot 主任务创建失败');
    }
    if (archivedCanonicalSessionId) {
      // A missing/deleted canonical is infrastructure recovery, not a user cancellation.
      // Keep its active Session tasks alive, move their ownership to the replacement, and
      // recreate idempotent card anchors there. Explicit archive/delete paths still cancel.
      const reparented = await client.tx<BotsReparentDelegationsResult>(
        'bots.reparentDelegations',
        {
          botId,
          previousParentSessionId: archivedCanonicalSessionId,
          nextParentSessionId: canonicalSessionId,
          now: Date.now(),
        },
      );
      if (reparented.delegationIds.length > 0) {
        const rows = await db
          .select()
          .from(botDelegations)
          .where(inArray(botDelegations.id, reparented.delegationIds));
        for (const row of rows) {
          await createMessage(canonicalSessionId, {
            clientId: BOT_DELEGATION_CLIENT_ID.parentRequest(row.id),
            role: 'assistant',
            content: '',
            createdAt: row.createdAt,
            agentKind: null,
            agentMeta: {
              botCollaboration: {
                v: 1,
                role: 'delegation-request',
                delegationId: row.id,
                fromBotId: botId,
                fromBotName: profile.displayName,
                toBotId: null,
                toBotName: 'Cindy',
                parentSessionId: canonicalSessionId,
                childSessionId: row.childSessionId,
                objective: row.objective.slice(0, 400),
              },
            },
          });
        }
      }
      await getMakerIfReady()
        ?.closeSession(archivedCanonicalSessionId)
        .catch(() => undefined);
      // The Profile workspace survives recovery of a missing/deleted task.
    }
    const [canonical] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, canonicalSessionId))
      .limit(1);
    if (!canonical) throwIpcError('NOT_FOUND', 'Bot 主任务不存在');
    broadcastBotProfileChanged({ botId, change: 'updated' });
    return {
      created,
      canonicalSessionId,
      session: sessionToCamel({
        ...canonical,
        messageCount: 0,
        latestMessageContent: null,
        latestMessageRole: null,
      }),
    };
  };

  const createBotCanonicalSessionPrepared = async (input: CreateBotCanonicalSessionInput, beforeCommit?: () => Promise<void>) => {
    const owner = captureBotOperationOwner();
    // Bring legacy pointer-only profiles into the link registry before any
    // create/replace CAS. Once a canonical link exists, the worker transaction
    // compares against that link rather than trusting the compatibility mirror.
    await reconcileCanonicalLink(input.botId);
    owner.assertCurrent();
    const previousSessionId = input.expectedCanonicalSessionId;
    if (!previousSessionId) return createBotCanonicalSessionUnlocked(input, beforeCommit);
    return coordinateBotCanonicalReplacement(previousSessionId, () =>
      createBotCanonicalSessionUnlocked(input, beforeCommit),
    );
  };

  createBotCanonicalSessionImpl = async (input, beforeCommit) => {
    const owner = captureBotOperationOwner();
    /*
      解析主任务前先把家里的文件收进来。用户拿编辑器改完 SOUL.md、
      或者伙伴自己改完自己的灵魂,都在这一刻变成一个新版本;现有主任务
      的下一轮会按新版本组装，不需要更换任务。

      放在锁外面:它只读文件、按需派生版本,不碰 canonical 指针,与替换协调器
      要保护的东西不重叠。失败已在内部吞掉并记一笔,最坏是这一轮还用旧身份。
    */
    const derived = await reconcileBotProfileFolder(input.botId);
    owner.assertCurrent();
    if (!derived) return createBotCanonicalSessionPrepared(input, beforeCommit);
    // The host itself just folded the user's file edit into a new version. A caller
    // that saw the version before it is not racing a concurrent change; any other
    // mismatch still loses the create CAS.
    broadcastBotProfileChanged({ botId: input.botId, change: 'updated' });
    return createBotCanonicalSessionPrepared(input.expectedProfileVersion === derived.from
      ? { ...input, expectedProfileVersion: derived.to }
      : input, beforeCommit);
  };

  ipcMain.handle('local-db:bots:create-canonical-session', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const botId = readText(body.botId, 'botId', 128, true);
    if (!Object.prototype.hasOwnProperty.call(body, 'expectedCanonicalSessionId')) {
      throwIpcError('INVALID_PARAMS', 'expectedCanonicalSessionId 必须显式提供');
    }
    const expectedCanonicalSessionId =
      body.expectedCanonicalSessionId === null
        ? null
        : readText(body.expectedCanonicalSessionId, 'expectedCanonicalSessionId', 128, true);
    if (!Number.isInteger(body.expectedProfileVersion) || Number(body.expectedProfileVersion) < 1) {
      throwIpcError('INVALID_PARAMS', 'expectedProfileVersion 必须是正整数');
    }
    if (body.recoverMissingOnly !== undefined && typeof body.recoverMissingOnly !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'recoverMissingOnly 必须是 boolean');
    }
    return createBotCanonicalSession({
      botId,
      expectedCanonicalSessionId,
      expectedProfileVersion: Number(body.expectedProfileVersion),
      recoverMissingOnly: body.recoverMissingOnly === true,
    });
  });

  const memory = getBotMemoryService();
  /** Bind each memory operation to the account that started it. */
  const withMemoryOwner = async <T>(run: () => Promise<T>): Promise<T> => {
    const owner = captureBotOperationOwner();
    const result = await run();
    owner.assertCurrent();
    return result;
  };
  ipcMain.handle('local-db:bots:workbench:get', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const owner = captureBotOperationOwner();
    const responsibleSessionIds = await readBotResponsibleSessionIds(owner.userDataDir, botId);
    owner.assertCurrent();
    const workbench: BotWorkbench = { responsibleSessionIds };
    return workbench;
  });
  for (const operation of ['list', 'set'] as const) {
    ipcMain.handle(`local-db:bots:projects:${operation}`, async (event, rawBotId: unknown, rawId?: unknown, rawLinked?: unknown) => {
      assertTrustedAppRendererEvent(event);
      const botId = readText(rawBotId, 'botId', 128, true);
      const access = await botLinkedProjectAccess(botId);
      if (operation === 'list') return access.read();
      const id = readText(rawId, 'projectId', 64, true);
      if (typeof rawLinked !== 'boolean') throwIpcError('INVALID_PARAMS', 'linked must be a boolean');
      return access.set(id, rawLinked);
    });
  }
  for (const operation of ['list', 'update', 'act'] as const) {
    ipcMain.handle(`local-db:bots:todos:${operation}`, async (event, rawBotId: unknown, input: unknown) => {
      assertTrustedAppRendererEvent(event);
      const owner = captureBotOperationOwner();
      const access = await todoAccess(readText(rawBotId, 'botId', 128, true));
      owner.assertCurrent();
      const result = operation === 'list' ? await access.list() : operation === 'update' ? await access.patch(input as TodoPatch)
        : await access.act((input as {id:string}).id, (input as {revision:number}).revision, (input as {requestId:string}).requestId,(input as {locale?:string}).locale);
      owner.assertCurrent();return result;
    });
  }
  // 近况「每天帮我查一次」：不传 enabled 只读，传了就开 / 关「每天查待办」例行任务（没有就按默认内容新建）。返回当前是否开着。
  ipcMain.handle('local-db:bots:todos:daily-check', async (event, rawBotId: unknown, rawEnabled: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    if (rawEnabled !== undefined && typeof rawEnabled !== 'boolean') throw new Error('Invalid enabled');
    const owner = captureBotOperationOwner();
    const result = rawEnabled === undefined ? await routineTools.todoCheckEnabled(botId) : await routineTools.setTodoCheck(botId, rawEnabled);
    owner.assertCurrent();
    if (rawEnabled !== undefined) broadcastBotRemoteResourceChanged(botId);
    return result;
  });
  // Exact per-task responsibility IDs from the current owner, without message bodies.
  ipcMain.handle('local-db:bots:workbench:follow-scopes', async (event) => {
    assertTrustedAppRendererEvent(event);
    const owner = captureBotOperationOwner();
    const bots = await getDbClient().drizzle
      .select({ id: botProfiles.id })
      .from(botProfiles)
      .where(ne(botProfiles.status, 'deleting'));
    // Older renderers receive empty directories rather than claiming projects.
    const scopes = await collectTaskResponsibilityScopes(
      bots.map((bot) => bot.id),
      (botId) => readBotResponsibilityScope(owner.userDataDir, botId),
    );
    owner.assertCurrent();
    return scopes;
  });
  // 工作台详情视图:只读一件任务的最近内容(有界)。范围限于该伙伴已接手的项目,
  // 外部会话只读转录尾部,不写库、不导入。
  ipcMain.handle('local-db:bots:workbench:read-task', async (event, rawBotId: unknown, rawTaskId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const taskId = readText(rawTaskId, 'taskId', 256, true);
    const owner = captureBotOperationOwner();
    const result = await readBotWorkbenchTaskForOwner(botId, taskId);
    owner.assertCurrent();
    return result;
  });
  // Local settings read; remote clients already use settings:<botId>/skills.
  ipcMain.handle('local-db:bots:skills:list', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const owner = captureBotOperationOwner();
    await getBotRemoteSettingsSource(botId);
    owner.assertCurrent();
    const skills = await listBotSkillsForBot(botId);
    owner.assertCurrent();
    return skills;
  });
  ipcMain.handle('local-db:bots:memory:list', async (event, rawBotId: unknown, rawQuery: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const query = rawQuery === undefined || rawQuery === null ? '' : readText(rawQuery, 'query', 200);
    return withMemoryOwner(() => memory.list(botId, query));
  });
  ipcMain.handle('local-db:bots:memory:read', async (event, rawBotId: unknown, rawFilename: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    return withMemoryOwner(() => memory.read(botId, rawFilename));
  });
  ipcMain.handle('local-db:bots:memory:update', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw);
    const botId = readText(body.botId, 'botId', 128, true);
    if (typeof body.title !== 'string' || typeof body.body !== 'string') {
      throwIpcError('INVALID_PARAMS', 'Invalid memory');
    }
    return withMemoryOwner(() =>
      memory.update({
        botId,
        filename: body.filename as string,
        title: body.title as string,
        body: body.body as string,
        expectedUpdatedAt: body.expectedUpdatedAt as string,
      }),
    );
  });
  ipcMain.handle('local-db:bots:memory:delete', async (event, raw: unknown) => {
    assertTrustedAppRendererEvent(event);
    const body = requireObject(raw);
    const botId = readText(body.botId, 'botId', 128, true);
    await withMemoryOwner(() =>
      memory.delete({
        botId,
        filename: body.filename as string,
        expectedUpdatedAt: body.expectedUpdatedAt as string,
      }),
    );
  });

  // 私聊话题：打开话题时建（或复用）它的隐藏 Session；时间线读本私聊的话题入口。
  ipcMain.handle('local-db:bots:dm-thread:ensure', async (event, raw: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'body');
    const botId = readText(body.botId, 'botId', 128, true);
    if (remote && await readRemoteBotSessionAccess(botId, 'bot') !== 'visible') throwIpcError('NOT_FOUND', 'Bot 不存在');
    const rootSessionId = readText(body.rootSessionId, 'rootSessionId', 128, true);
    const rootClientId = readText(body.rootClientId, 'rootClientId', 256, true);
    if (!parseBotDmThreadRouteKey(`dm-thread:${rootSessionId}:${rootClientId}`)) {
      throwIpcError('INVALID_PARAMS', '话题的原消息无效');
    }
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : '';
    return ensureBotDmThreadSession({ botId, rootSessionId, rootClientId, title: title || '话题' });
  });
  ipcMain.handle('local-db:bots:dm-thread:list', async (event, raw: unknown) => {
    const remote = isDeviceLinkInvoke();
    if (!remote) assertTrustedAppRendererEvent(event);
    const body = requireObject(raw, 'body');
    const botId = readText(body.botId, 'botId', 128, true);
    if (remote && await readRemoteBotSessionAccess(botId, 'bot') !== 'visible') throwIpcError('NOT_FOUND', 'Bot 不存在');
    const rootSessionId = readText(body.rootSessionId, 'rootSessionId', 128, true);
    return listBotDmThreads(botId, rootSessionId);
  });

  ipcMain.handle('local-db:bots:history', async (event, rawBotId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const botId = readText(rawBotId, 'botId', 128, true);
    const db = getDbClient().drizzle;
    const links = await db
      .select()
      .from(botSessionLinks)
      .where(and(eq(botSessionLinks.botId, botId), eq(botSessionLinks.role, 'history')))
      .orderBy(desc(botSessionLinks.archivedAt));
    const result = [];
    for (const link of links) {
      const [row] = await db
        .select()
        .from(sessions)
        .where(eq(sessions.id, link.sessionId))
        .limit(1);
      if (!row) continue;
      result.push(
        sessionToCamel({
          ...row,
          messageCount: 0,
          latestMessageContent: null,
          latestMessageRole: null,
        }),
      );
    }
    return result;
  });
  // 伙伴自主跟进：工作台「一眼」与「自动跟进所有任务」设置。
  registerBotAutonomyIpc();
}
