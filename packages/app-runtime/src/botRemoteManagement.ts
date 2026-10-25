import type {RemoteResourceHostContext} from '@cindy/device-link';
import type {BotModelRoute} from '@cindy/companion-core/botModelChain';
import type {BotLifecycleActionRequest,BotLifecycleActionResult} from '@cindy/companion-core/botLifecycle';
import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import {botRemoteResourceFromSource} from './botRemoteResourceProjection.js';
import {createBotRemoteSettingsResource} from './botRemoteSettingsResource.js';
import {createBotRemoteEditors,type BotRemoteEditorDeps} from './botRemoteEditors.js';
import {decodeBotAvatarImage} from './botAvatarSelection.js';
import type {createBotProfileService,BotProfileServiceHost} from './botProfileService.js';
import type {createBotModelChainSettings} from './botModelChainSettings.js';
import type {createAppDefaultModelControl} from './appDefaultModelControl.js';
import type {createBotSkillService} from './botSkillService.js';
import type {createBotMemoryService} from './botMemoryService.js';
import type {createBotCapabilityRuntime} from './botCapabilityService.js';
type CapabilityService=ReturnType<ReturnType<typeof createBotCapabilityRuntime>['createBotCapabilityService']>;
type Projects=NonNullable<BotRemoteEditorDeps['projects']>;
export interface BotRemoteManagementHost extends
 Pick<ReturnType<typeof createBotProfileService>,'createBotProfile'|'createBotCanonicalSession'|'getBotRemoteResourceSource'|'getBotRemoteSettingsSource'|'setBotProfileAvatar'|'updateBotProfile'>,
 Pick<ReturnType<typeof createBotModelChainSettings>,'readEffectiveBotModelChain'>,
 Pick<ReturnType<typeof createAppDefaultModelControl>,'resolveAvailableTaskModels'>,
 Pick<ReturnType<typeof createBotSkillService>,'listBotSkillsForBot'|'readBotSkillForBot'|'saveBotSkillForSession'|'deleteBotSkillForBot'>,
 Pick<BotProfileServiceHost,'activeOwnerScopeKey'|'isAppSessionBoundaryPending'|'requestBotRuntimeEpochRefresh'> {
 getBotAutonomySettingsView:NonNullable<BotRemoteEditorDeps['followUp']>['get'];
 setBotAutonomySchedulerBotId:NonNullable<BotRemoteEditorDeps['followUp']>['set'];
 getBotMemoryService():ReturnType<typeof createBotMemoryService>;
 runRegisteredBotLifecycleAction(input:BotLifecycleActionRequest,guard:()=>Promise<void>):Promise<BotLifecycleActionResult>;
 listBotSettingsCapabilities:CapabilityService['forSettings'];
 validateBotCapabilityAdditions:CapabilityService['validateAdditions'];
 botLinkedProjectAccess(botId:string):Promise<{read():ReturnType<Projects['list']>;set(id:string,linked:boolean):ReturnType<Projects['set']>}>;
}
export function createBotRemoteManagement(host:BotRemoteManagementHost) {
const {getBotAutonomySettingsView,setBotAutonomySchedulerBotId,readEffectiveBotModelChain,resolveAvailableTaskModels,createBotProfile,createBotCanonicalSession,getBotMemoryService,getBotRemoteResourceSource,getBotRemoteSettingsSource,setBotProfileAvatar,updateBotProfile,activeOwnerScopeKey,isAppSessionBoundaryPending,listBotSkillsForBot,readBotSkillForBot,saveBotSkillForSession,deleteBotSkillForBot,requestBotRuntimeEpochRefresh,runRegisteredBotLifecycleAction,listBotSettingsCapabilities,validateBotCapabilityAdditions,botLinkedProjectAccess}=host;
async function validateModelChain(chain: BotModelRoute[]) {
  const scope = activeOwnerScopeKey();
  const resolved = await resolveAvailableTaskModels(chain);
  if (isAppSessionBoundaryPending() || scope !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
  if (resolved.some(route => !route)) throwIpcError('INVALID_PARAMS', 'Model route unavailable');
}

/** Composition only: profile transactions, skill reads and lifecycle stay with their existing owners. */
const deps = {
  owner: activeOwnerScopeKey,
  assertOwner(owner: string) {
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
  },
  read: getBotRemoteSettingsSource,
  update: async (input: Record<string, unknown>, version: number) => {
    const owner = activeOwnerScopeKey();
    const capabilities = input.capabilities as { modelChainOverride?: BotModelRoute[] | null } | undefined;
    if (Array.isArray(capabilities?.modelChainOverride)) {
      await validateModelChain(capabilities.modelChainOverride);
    }
    if (isAppSessionBoundaryPending() || owner !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
    return updateBotProfile(input, version, validateBotCapabilityAdditions);
  },
  skills: listBotSkillsForBot,
};
const settings = createBotRemoteSettingsResource({ ...deps,
  lifecycle: (botId, action, confirmName, guard) => runRegisteredBotLifecycleAction({ botId, action, confirmName, keepTaskHistory: true, worktreeDisposition: 'retain' }, guard),
});
const getEditor = createBotRemoteEditors({ ...deps,
  projects: {
    list: async botId => (await botLinkedProjectAccess(botId)).read(),
    set: async (botId, id, linked) => (await botLinkedProjectAccess(botId)).set(id, linked),
  },
  followUp: { get: getBotAutonomySettingsView, set: setBotAutonomySchedulerBotId },
  async modelDefaults() {
    const owner = deps.owner();
    const chain = await readEffectiveBotModelChain({});
    deps.assertOwner(owner);
    if (!chain.length) return [];
    const [primary] = await resolveAvailableTaskModels(chain.slice(0, 1));
    deps.assertOwner(owner);
    // Creation shows the primary only. Do not silently promote a backup or
    // rewrite the persisted default when its primary is no longer usable.
    return primary ? [primary, ...chain.slice(1)] : [];
  },
  async create(input) {
    const owner = deps.owner(); deps.assertOwner(owner);
    let source;
    try { source = await getBotRemoteResourceSource(input.id); }
    catch (error) {
      // Only absence admits creation; a transient read failure must not start a second intent.
      if (!(error instanceof Error) || !error.message.includes('[NOT_FOUND]')) throw error;
    }
    deps.assertOwner(owner);
    if (!source) {
      if (input.capabilities) await validateModelChain(input.capabilities.modelChainOverride);
      else {
        const chain = await readEffectiveBotModelChain({});
        deps.assertOwner(owner);
        if (!chain.length) throwIpcError('INVALID_PARAMS', 'Model route unavailable');
        // Match the primary advertised by the creation form, without rejecting
        // an otherwise usable default because an optional backup is unavailable.
        await validateModelChain(chain.slice(0, 1));
      }
      deps.assertOwner(owner);
      await createBotProfile({ ...input, prepareInvitation: true });
      deps.assertOwner(owner);
      source = await getBotRemoteResourceSource(input.id);
    }
    deps.assertOwner(owner);
    if (source.status !== 'active') throwIpcError('PRECONDITION_FAILED', 'Teammate unavailable');
    if (!source.canonicalSessionId && (!source.invitation || source.invitation.stage === 'ready')) await createBotCanonicalSession({ botId: source.id, expectedCanonicalSessionId: null, expectedProfileVersion: source.currentVersion });
    deps.assertOwner(owner);
  },
  async avatar(botId, bytes, version, expectedAvatar) {
    const image = decodeBotAvatarImage(bytes);
    if (!image) throwIpcError('INVALID_PARAMS', 'Avatar required');
    await setBotProfileAvatar(botId, image, version, expectedAvatar);
  },
  skill: readBotSkillForBot,
  async saveSkill(botId, skill) {
    const owner = deps.owner();
    const { source } = await deps.read(botId);
    deps.assertOwner(owner);
    if (!source.canonicalSessionId) throwIpcError('PRECONDITION_FAILED', 'Teammate unavailable');
    const result = await saveBotSkillForSession({ callerSessionId: source.canonicalSessionId, ...skill });
    if (!result.ok) throwIpcError('PRECONDITION_FAILED', 'Skill could not be saved; refresh before retrying');
  },
  async removeSkill(botId, slug) {
    const owner = deps.owner(); const { source } = await deps.read(botId); deps.assertOwner(owner);
    await deleteBotSkillForBot(botId, slug); deps.assertOwner(owner);
    if (source.canonicalSessionId) await requestBotRuntimeEpochRefresh(source.canonicalSessionId, 'resource');
  },
  async capabilities(callerSessionId, kind) {
    return listBotSettingsCapabilities({ callerSessionId, kind });
  },
  // Resolved per call: the same service (locks, refresh coalescing) as the local Memory page.
  memory: {
    list: (botId, query) => getBotMemoryService().list(botId, query),
    read: (botId, filename) => getBotMemoryService().read(botId, filename),
    update: input => getBotMemoryService().update(input),
    delete: input => getBotMemoryService().delete(input),
  },
}, settings.bindResource);
async function getInvitation(context: RemoteResourceHostContext, botId: string) {
  const owner = deps.owner();
  const source = await getBotRemoteResourceSource(botId); deps.assertOwner(owner);
  const resource = botRemoteResourceFromSource(source);
  if (source.invitation?.stage !== 'failed' || source.status !== 'active') return resource;
  const revision = `${source.currentVersion}:${source.invitation.stage}:${source.status}`;
  return settings.bindResource(context, { ...resource, revision, actions: [{ id: 'retry-invitation', label: { fallback: 'Try Again', translations: { 'zh-CN': '重试', 'zh-TW': '重試', ja: '再試行', ko: '다시 시도' } } }] }, async () => {
    const current = await getBotRemoteResourceSource(botId); deps.assertOwner(owner);
    return `${current.currentVersion}:${current.invitation?.stage}:${current.status}`;
  }, async request => {
    if (request.actionId !== 'retry-invitation' || Object.keys(request.input ?? {}).length) throwIpcError('INVALID_PARAMS', 'Invalid invitation retry');
    deps.assertOwner(owner);
    await updateBotProfile({ id: botId, retryInvitation: true }); deps.assertOwner(owner);
    return { effects: [{ kind: 'refresh-collection', collectionId: 'teammates' }] };
  });
}
return { ...settings, getEditor, getInvitation };

}
