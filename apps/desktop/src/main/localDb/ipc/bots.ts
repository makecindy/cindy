import {registerBotContentHandlers} from '@cindy/app-runtime/botContentHandlers';
import {registerBotProfileHandlers} from '@cindy/app-runtime/botProfileHandlers';
import { todoAccess } from '../../maker-ipc/botTodoAccess.js';
import { botLinkedProjectAccess } from '../../maker-ipc/botLinkedProjects.js';
import type { TodoPatch } from '@cindy/maker-shared/teammate-todo';
import { listBotSkillsForBot } from '../../maker-ipc/botSkillService.js';
import { provisionDefaultBot } from '../../maker-ipc/botDefaultProvisioning.js';

import fs from 'node:fs/promises';
import { chooseAvatarSource } from '../../profileEdit.js';
import { toSdrAvatarImage } from '../../hdrAvatarToSdr.js';


import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import type { OpenDialogOptions } from 'electron';
import { and, desc, eq, ne } from 'drizzle-orm';
import { getDbClient, tryGetDbClient } from '../client/current';
import { notifyAgentIslandCompanionChanged } from '../agentIslandSessionPatch.js';

import { botProfiles, botSessionLinks, sessions } from '../schema';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import { requireObject, requireString, throwIpcError } from '../../utils/ipcValidate.js';

import { readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch } from './botRemoteSessionAccess.js';
import { setRemoteBotSessionLookup } from '../../device-link/remoteBotSessionBoundary.js';
import { resolveBusinessSessionId } from '../../sessionIds.js';
import { ensureProjectGitInitialized } from '../../git-snapshot/projectGitBootstrap.js';
import { readGitSafetySettings } from '../../maker-host/git-safety-settings-store.js';
import { readBotModelChainSettingsState, resetBotModelChainSettings, readEffectiveBotModelChain, writeBotModelChainSettings } from '../../maker-host/bot-model-chain-settings-store.js';
import { extractMessagePreview, sessionCreateToRow, sessionToCamel } from '../mapper.js';

import type { BotWorkbench } from '../../../shared/botWorkbench.js';



import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { createLogger } from '../../logger.js';
import { collectTaskResponsibilityScopes } from '../../maker-ipc/botTaskResponsibility.js';
import { readBotWorkbenchTaskForOwner, readBotResponsibilityScope, readBotResponsibleSessionIds } from '../../maker-ipc/botWorkbenchTools.js';


import { validateTaskModel } from '../../maker-ipc/appDefaultModelControl.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending, ownerScopedUserDataPath } from '../../appSessionState.js';

import { migrateLegacyTeammateAvatar } from './legacyTeammateAvatar.js';
import { MAKER_PUSH } from '../../maker-ipc/channels.js';
import { decodeBotAvatarImage, validateBotAvatarBuffer, storeTeammateAvatarImage, readDefaultTeammatePortrait } from './botAvatarSelection.js';

import { createMessage } from './messages.js';
import { broadcastSessionPatched } from './sessions.js';

import { generateBotCreationDraft, readBotCreationDraft, generateBotCreationAvatar } from '../../maker-ipc/botCreationDraft.js';


import { parseBotDmThreadRouteKey } from '../../../shared/botDmThread.js';

import { queueBotInvitation as enqueueBotInvitation } from '../../maker-ipc/botInvitation.js';
import { getMakerIfReady, validateBotCapabilityAdditions } from '../../maker-host/index.js';

import { getResolvedMainLocale } from '../../i18n.js';

import { normalizeBotWelcomeContext } from '../../../shared/botWelcomeContext';
import { broadcastBotRemoteResourceChanged } from '../../maker-ipc/botRemoteResourceInvalidation.js';
import { routineTools } from '../../routines/service.js';
import { createBotMemoryService } from '../../maker-ipc/botMemoryService.js';

import { coordinateBotCanonicalReplacement } from '../../maker-ipc/botCanonicalReplacementCoordinator.js';
import { searchConversations } from '../conversationSearch.js';
import { registerBotAutonomyIpc } from '../../bot-autonomy/ipc.js';
import { signalBotAutonomyBotsChanged } from '../../bot-autonomy/botsChangedSignal.js';


import { createBotProfileService } from '@cindy/app-runtime/botProfileService';
export type * from '@cindy/app-runtime/botProfileService';
const profiles = createBotProfileService({
  provisionDefaultBot: (...args) => provisionDefaultBot(...args), resolveBusinessSessionId: (...args) => resolveBusinessSessionId(...args),
  getDbClient: (...args) => getDbClient(...args), tryGetDbClient: (...args) => tryGetDbClient(...args), getMakerIfReady: (...args) => getMakerIfReady(...args), activeOwnerScopeKey: (...args) => activeOwnerScopeKey(...args), isAppSessionBoundaryPending: (...args) => isAppSessionBoundaryPending(...args), ownerScopedUserDataPath: (...args) => ownerScopedUserDataPath(...args), readEffectiveBotModelChain: (...args) => readEffectiveBotModelChain(...args), validateTaskModel: (...args) => validateTaskModel(...args), ensureProjectGitInitialized: (...args) => ensureProjectGitInitialized(...args), readGitSafetySettings: (...args) => readGitSafetySettings(...args), requestBotRuntimeEpochRefresh: (...args) => requestBotRuntimeEpochRefresh(...args), migrateLegacyTeammateAvatar: (...args) => migrateLegacyTeammateAvatar(...args), decodeBotAvatarImage: (...args) => decodeBotAvatarImage(...args), storeTeammateAvatarImage: (...args) => storeTeammateAvatarImage(...args), readDefaultTeammatePortrait: (...args) => readDefaultTeammatePortrait(...args), readBotCreationDraft: (...args) => readBotCreationDraft(...args), getResolvedMainLocale: (...args) => getResolvedMainLocale(...args), enqueueBotInvitation: (...args) => enqueueBotInvitation(...args), coordinateBotCanonicalReplacement: (...args) => coordinateBotCanonicalReplacement(...args), broadcastBotRemoteResourceChanged: (...args) => broadcastBotRemoteResourceChanged(...args), signalBotAutonomyBotsChanged: (...args) => signalBotAutonomyBotsChanged(...args), notifyAgentIslandCompanionChanged: (...args) => notifyAgentIslandCompanionChanged(...args), broadcastSessionPatched: (...args) => broadcastSessionPatched(...args), createMessage: (...args) => createMessage(...args),
  legacyUserDataPath: () => app.getPath('userData'), logger: createLogger('bots'),
  mapper: {extractMessagePreview,sessionCreateToRow,sessionToCamel},
  broadcastProfileChanged: payload => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      try { win.webContents.send(MAKER_PUSH.BOT_PROFILE_CHANGED, payload); }
      catch (error) { log.warn('Bot profile broadcast failed', {error: String(error)}); }
    }
  },
});
const log=createLogger('bots');
export const {createBotCanonicalSession, ensureBotGroupLaneSession, findBotChannelLaneSession, ensureBotChannelLaneSession, ensureBotDmThreadSession, listBotDmThreads, archiveBotChannelLanes, reconcileBotProfileFolder, listBotRemoteResourceSources, getBotRemoteResourceSource, getBotRemoteSettingsSource, broadcastBotProfileChanged, recoverActiveTeammateInvitations, setBotProfileAvatar, createBotProfile, prepareImportedBotInvitation, updateBotProfile} = profiles;
const {queueBotInvitation, captureBotOperationOwner, readText, readLastReadAtMap, readBotInvitationLocale, readProfile, findExistingCindy, provisionDefaultBotForList, fileExists, parseJson, readRemoteBotProfile, initializeCanonicalSession} = profiles;

let botMemoryService: ReturnType<typeof createBotMemoryService> | null = null;
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
export function registerBotIpc(): void {
  setRemoteBotSessionLookup(readRemoteBotSessionAccess, readRemoteBotSessionAccessBatch);
  registerBotProfileHandlers({
    ipcMain, isDeviceLinkInvoke, assertTrustedAppRendererEvent,
    getDbClient: (...args) => getDbClient(...args),
    tryGetDbClient: (...args) => tryGetDbClient(...args),
    ...profiles,
    readBotModelChainSettingsState: (...args) => readBotModelChainSettingsState(...args),
    writeBotModelChainSettings: (...args) => writeBotModelChainSettings(...args),
    resetBotModelChainSettings: (...args) => resetBotModelChainSettings(...args),
    readEffectiveBotModelChain: (...args) => readEffectiveBotModelChain(...args),
    validateTaskModel: (...args) => validateTaskModel(...args),
    validateBotCapabilityAdditions: (...args) => validateBotCapabilityAdditions(...args),
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


  initializeCanonicalSession();


  registerBotContentHandlers({ipcMain,assertTrustedAppRendererEvent,getDbClient,...profiles,generateBotCreationAvatar,generateBotCreationDraft,listBotSkillsForBot,sessionToCamel,searchConversations,memory:getBotMemoryService()});
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
  // 近况「每天帮我查一次」：不传 enabled 只读，传了就开 / 关内置「每天查待办」。返回当前是否开着。
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
      .where(eq(botProfiles.status, 'active'));
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
  // 伙伴自主跟进：工作台「一眼」与「自动跟进所有任务」设置。
  registerBotAutonomyIpc();
}
