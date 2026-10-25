import {eq} from 'drizzle-orm';
import type {MakerMemoryManager} from '@cindy/maker-core';
import {botProfiles} from '@cindy/runtime-db/schema';
import {createBotProfileService,type BotProfileServiceHost} from '@cindy/app-runtime/botProfileService';
import {provisionDefaultBot} from '@cindy/app-runtime/botDefaultProvisioning';
import {resolveBusinessSessionId} from '@cindy/app-runtime/sessionIds';
import {createBotAvatarSelection,decodeBotAvatarImage} from '@cindy/app-runtime/botAvatarSelection';
import {createLegacyTeammateAvatar} from '@cindy/app-runtime/legacyTeammateAvatar';
import {createBotInvitationAvatar} from '@cindy/app-runtime/botInvitationAvatar';
import {createBotInvitationService,type BotInvitationHost} from '@cindy/app-runtime/botInvitation';
import {createBotCreationDraft,type BotCreationDraftHost} from '@cindy/app-runtime/botCreationDraft';
import {createBotCapabilityRuntime,type BotCapabilityServiceDeps,type BotCapabilityServiceHost} from '@cindy/app-runtime/botCapabilityService';
import {createBotSkillService} from '@cindy/app-runtime/botSkillService';
import {readChannelToolScope} from '@cindy/im-runtime/channelToolScope';
import {createGroupToolAuthorization,GroupToolAuthorizationError} from '@cindy/app-runtime/botGroupToolAuthorization';
import {createBotMemoryService} from '@cindy/app-runtime/botMemoryService';
import {createBotAttentionService} from '@cindy/app-runtime/botAttentionService';
import {createBotProfileRuntime} from '@cindy/app-runtime/botProfileRuntime';
import {createBotWorkspaceRuntime} from '@cindy/app-runtime/botWorkspaceRuntime';
import {buildTeammateGuide} from '@cindy/app-runtime/teammateGuide';
import {BOT_BASELINE_PLUGIN_IDS} from '@cindy/app-runtime/builtin-tools/types';
import {PROVIDER_NAME_TO_PLUGIN_ID} from '@cindy/app-runtime/builtinPluginIds';
import type {TerminalTaskMedia} from './media.js';
import type {TerminalMediaRuntime} from './media-runtime.js';

type SharedPorts = 'provisionDefaultBot'|'resolveBusinessSessionId'|'migrateLegacyTeammateAvatar'|'decodeBotAvatarImage'|'storeTeammateAvatarImage'|'readDefaultTeammatePortrait'|'readBotCreationDraft'|'enqueueBotInvitation';
export interface TerminalBotServicesHost extends Omit<BotProfileServiceHost,SharedPorts>, Pick<BotInvitationHost,'subscribeNewMakerDefaults'|'requestAuxiliaryText'|'captureDataOwnerBroadcastScope'>, Pick<BotCreationDraftHost,'getModelVisibilityOverride'|'waitForModelVisibilityMirror'|'getDesktopProviderService'|'requestUtilityText'>, Pick<BotCapabilityServiceHost,'inspectAppDefaultModel'|'changeAppDefaultModel'|'readExplicitBotModelChain'|'listCustomMcpServers'> {
 media:TerminalTaskMedia;
 mediaRuntime:TerminalMediaRuntime;
 resourceRoot():string;
 memory:MakerMemoryManager;
 capabilityDeps:BotCapabilityServiceDeps;
}

/** Node supplies owner/platform effects; profile, invitation, capability, Skill,
 * memory and hydration behavior are the same services used by the GUI host. */
export async function openTerminalBotServices(input:TerminalBotServicesHost) {
 let closed=false;
 const boundary=()=>closed||input.isAppSessionBoundaryPending();
 const host={...input,isAppSessionBoundaryPending:boundary};
 const persisted=await input.media.persisted();
 const avatars=createBotAvatarSelection({resourceRoot:host.resourceRoot,writeBlob:persisted.blobStore.writeBlob,recordBlob:persisted.ledger.recordBlob});
 const legacy=createLegacyTeammateAvatar({...avatars,resourceRoot:host.resourceRoot,logger:host.logger});
 const invitationAvatar=createBotInvitationAvatar({
  callCindyMedia:request=>host.mediaRuntime.callCindyMedia(request),
  resolveSafe:persisted.blobStore.resolveSafe,writeBlob:persisted.blobStore.writeBlob,recordBlob:persisted.ledger.recordBlob,
  cropPortrait:async buffer=>{
   const {default:sharp}=await import('sharp');
   return sharp(buffer).resize(256,256,{fit:'cover',position:'centre'}).png().toBuffer();
  },
 });
 const groups=createGroupToolAuthorization({error:temporary=>new GroupToolAuthorizationError(temporary,temporary?'Group authorization is temporarily unavailable':'Group authorization is required')});
 const invitations=createBotInvitationService({...host,...invitationAvatar});
 let creation:ReturnType<typeof createBotCreationDraft>;
 const profiles=createBotProfileService({
  ...host,...avatars,...legacy,provisionDefaultBot,resolveBusinessSessionId,decodeBotAvatarImage,
  readBotCreationDraft:token=>creation.readBotCreationDraft(token),
  enqueueBotInvitation:invitations.queueBotInvitation,
 });
 profiles.initializeCanonicalSession();
 const capabilities=createBotCapabilityRuntime({...host,...groups,updateBotProfile:profiles.updateBotProfile}).createBotCapabilityService(host.capabilityDeps);
 creation=createBotCreationDraft({...host,...invitationAvatar,resolveSafe:persisted.blobStore.resolveSafe,listBotCreationCapabilities:capabilities.forCreation});
 const skills=createBotSkillService({...host,...groups,readChannelToolScope});
 const attention=createBotAttentionService(host.getDbClient,host.broadcastBotRemoteResourceChanged);
 const runtime=createBotProfileRuntime({...host,...attention,providerNameToPluginId:PROVIDER_NAME_TO_PLUGIN_ID,baselinePluginIds:BOT_BASELINE_PLUGIN_IDS,buildBotCapabilityContextPrompt:buildTeammateGuide});
 const workspace=createBotWorkspaceRuntime(host);
 const memory=createBotMemoryService({
  getStore:scope=>{if(boundary())throw new Error('BOT_OWNER_CLOSED');return host.memory.getStore(scope,{skipDisabledCheck:true});},
  readBot:async id=>{
   const owner=profiles.captureBotOperationOwner(),client=host.getDbClient();
   const [row]=await client.drizzle.select({canonicalSessionId:botProfiles.canonicalSessionId,status:botProfiles.status}).from(botProfiles).where(eq(botProfiles.id,id)).limit(1);
   owner.assertCurrent();
   return row&&row.status!=='deleting'?{canonicalSessionId:row.canonicalSessionId,assertCurrent:owner.assertCurrent}:null;
  },
  requestRefresh:id=>host.requestBotRuntimeEpochRefresh(id,'resource'),
 });
 return {profiles,avatars,creation,invitations,capabilities,skills,memory,attention,runtime,workspace,groups,
  async close(){closed=true;memory.dispose();await invitations.close();},
 };
}
export type TerminalBotServices=Awaited<ReturnType<typeof openTerminalBotServices>>;
