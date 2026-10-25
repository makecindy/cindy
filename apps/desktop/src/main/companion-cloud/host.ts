import { app } from 'electron';
import { activeOwnerScopeKey, ownerScopedUserDataPath } from '../appSessionState.js';
import { getDbClient } from '../localDb/client/current.js';
import { createBotProfile, getBotMemoryService, setBotProfileAvatar, updateBotProfile } from '../localDb/ipc/bots.js';
import { createMessage } from '../localDb/ipc/messages.js';
import { commitChatImageUrls } from '../cindy-media/chatAttachments.js';
import { resolveBotCanonicalSession } from '../maker-ipc/botCanonicalSessionRegistry.js';
import { onBotRemoteResourceChanged } from '../maker-ipc/botRemoteResourceInvalidation.js';
import { deleteBotSkillForBot, listBotSkillSourcesForBot, readBotSkillSourceForBot, saveBotSkillSourceForBot } from '../maker-ipc/botSkillService.js';
import { companionTodoStore } from '../maker-ipc/botTodoAccess.js';
import { mergeCompanionWorkbench, readCompanionWorkbench } from '../maker-ipc/botWorkbenchService.js';
import { importCompanionRoutines, listCompanionRoutines } from '../routines/service.js';
import { companionHomes } from './homes.js';
import { createCompanionCloudLocalRuntime } from '@cindy/app-runtime/companionCloudHost';
export const {readCompanionValues,readMirrorRowsAfter,readLatestMirrorRows,companionInstallationId,companionShadowStore,createCompanionCloudHost} = createCompanionCloudLocalRuntime({
 getDbClient,activeOwnerScopeKey,ownerScopedUserDataPath,userDataPath:()=>app.getPath('userData'),getBotMemoryService,
 createBotProfile,setBotProfileAvatar,updateBotProfile,createMessage,commitChatImageUrls,resolveBotCanonicalSession,
 onBotRemoteResourceChanged,deleteBotSkillForBot,listBotSkillSourcesForBot,readBotSkillSourceForBot,saveBotSkillSourceForBot,
 companionTodoStore,mergeCompanionWorkbench,readCompanionWorkbench,importCompanionRoutines,listCompanionRoutines,companionHomes,
});
