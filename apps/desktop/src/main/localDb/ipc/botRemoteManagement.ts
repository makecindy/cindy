import { listTeammateMediaModels } from '../../vision-bridge/teammate-media-catalog.js';
import { getBotAutonomySettingsView, resetBotAutonomySchedulerSettings, setBotAutonomySchedulerBotId } from '../../bot-autonomy/hub.js';
import { readEffectiveBotModelChain } from '../../maker-host/bot-model-chain-settings-store.js';
import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { botRemoteResourceFromSource } from './botRemoteResourceProjection.js';
import { resolveAvailableTaskModels } from '../../maker-ipc/appDefaultModelControl.js';
import type { BotModelRoute } from '../../../shared/botModelChain.js';
import { createBotRemoteSettingsResource } from './botRemoteSettingsResource.js';
import { createBotProfile, createBotCanonicalSession, getBotMemoryService, getBotRemoteResourceSource, getBotRemoteSettingsSource, readBotSettingsProfile, searchBotHistory, setBotProfileAvatar, updateBotProfile } from './bots.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { listBotSkillsForBot, readBotSkillForBot, saveBotSkillForSession, deleteBotSkillForBot } from '../../maker-ipc/botSkillService.js';
import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { createBotRemoteEditors } from './botRemoteEditors.js';
import { decodeBotAvatarImage } from './botAvatarSelection.js';
import { runRegisteredBotLifecycleAction } from '../../maker-ipc/botLifecycleService.js';
import { listBotSettingsCapabilities, validateBotCapabilityAdditions } from '../../maker-host/index.js';
import { isProviderSharePeer, isSharedTaskPeer } from '@cindy/device-link';
import { readDeviceLinkSettings } from '../../device-link/settings-store.js';
import { readRemoteBotSessionAccess } from './botRemoteSessionAccess.js';
import { createBotRemoteSettingsHost } from './botRemoteSettingsHost.js';
import { createBotRemoteSettingsOps } from './botRemoteSettingsOps.js';
import { botLinkedProjectAccess } from '../../maker-ipc/botLinkedProjects.js';

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
  mediaModels: listTeammateMediaModels,
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
  return settings.bindResource(context, { ...resource, revision, actions: [{ id: 'retry-invitation', label: { fallback: 'Try Again', translations: { 'zh-CN': '重试', 'zh-TW': '重試', ja: '再試行', ko: '다시 시도' , "es":"Volver a intentar","fr":"Réessayer","de":"Erneut versuchen","pt-PT":"Tentar novamente","pt-BR":"Tentar novamente","zh-Hant-x-lzh":"再試","zh-Hans-x-lzh":"再试"} } }] }, async () => {
    const current = await getBotRemoteResourceSource(botId); deps.assertOwner(owner);
    return `${current.currentVersion}:${current.invitation?.stage}:${current.status}`;
  }, async request => {
    if (request.actionId !== 'retry-invitation' || Object.keys(request.input ?? {}).length) throwIpcError('INVALID_PARAMS', 'Invalid invitation retry');
    deps.assertOwner(owner);
    await updateBotProfile({ id: botId, retryInvitation: true }); deps.assertOwner(owner);
    return { effects: [{ kind: 'refresh-collection', collectionId: 'teammates' }] };
  });
}
/** The routine service is shared with the local routines IPC; load it when a routines page asks. */
const routineTools = async () => (await import('../../routines/service.js')).routineTools;

/** The messaging stack is only needed by a remote Desktop's channels page. */
const imRuntime = () => import('../../im/shared/botImConnectionRuntime.js');

/** Loaded on use: the voice stack is large and only a voice page of a remote Desktop needs it. */
async function settingsVoice() {
  const api = (await import('../../voice-conversation/index.js')).getVoiceSettingsHostApi();
  if (!api) throwIpcError('PRECONDITION_FAILED', 'Voice conversation is unavailable.');
  return api!;
}

/**
 * The teammate settings pages of a remote Desktop (`management:settings`): the same pages, with every read and
 * write executed here by the services the local IPC handlers call.
 */
const settingsHost = createBotRemoteSettingsHost({
  owner: deps.owner,
  isOwnerCurrent: owner => !isAppSessionBoundaryPending() && owner === activeOwnerScopeKey(),
  // Same gate as the Skill / plugin management: a same-account controller the owner still allows.
  controllerAllowed: peer => {
    const current = readDeviceLinkSettings();
    return !isSharedTaskPeer(peer) && !isProviderSharePeer(peer) && current.remoteControlEnabled && !current.revokedControllers.includes(peer);
  },
  botVisible: async botId => (await readRemoteBotSessionAccess(botId, 'bot')) === 'visible',
  ops: createBotRemoteSettingsOps({
    mediaModels: listTeammateMediaModels,
    readProfile: readBotSettingsProfile,
    updateProfile: input => updateBotProfile(input, undefined, validateBotCapabilityAdditions),
    async setAvatar(botId, avatarImageBase64) {
      const image = decodeBotAvatarImage(avatarImageBase64);
      if (!image) throwIpcError('INVALID_PARAMS', 'Avatar required');
      return setBotProfileAvatar(botId, image!);
    },
    retryInvitation: botId => updateBotProfile({ id: botId, retryInvitation: true }),
    lifecycle: (request, guard) => runRegisteredBotLifecycleAction(request, guard),
    defaultModelChain: () => readEffectiveBotModelChain({}),
    memory: {
      list: (botId, query) => getBotMemoryService().list(botId, query),
      read: (botId, filename) => getBotMemoryService().read(botId, filename),
      update: input => getBotMemoryService().update(input),
      delete: input => getBotMemoryService().delete(input),
    },
    canonicalSessionId: async botId => (await getBotRemoteSettingsSource(botId)).source.canonicalSessionId ?? null,
    capabilities: (callerSessionId, kind) => listBotSettingsCapabilities({ callerSessionId, kind }),
    personalSkills: listBotSkillsForBot,
    autonomy: { get: getBotAutonomySettingsView, set: setBotAutonomySchedulerBotId, reset: resetBotAutonomySchedulerSettings },
    searchHistory: searchBotHistory,
    routines: {
      list: async (botId) => (await routineTools()).list(botId),
      sources: async () => (await routineTools()).sources(),
      deliveryTargets: async (botId) => (await routineTools()).deliveryTargets(botId),
      history: async (botId, id) => (await routineTools()).history(botId, id),
      save: async (botId, input, id) => (await routineTools()).save(botId, input, id),
      runNow: async (botId, id) => (await routineTools()).runNow(botId, id),
      remove: async (botId, id) => (await routineTools()).remove(botId, id),
    },
    channels: {
      im: {
        list: async () => (await imRuntime()).buildBotImConnectionListPayload(),
        remove: async (id) => (await imRuntime()).removeBotImConnection(id),
        listGroups: async (id) => (await imRuntime()).listBotImConnectionGroups(id),
        setGroupActivation: async (id, chatId, mode) => (await imRuntime()).setBotImConnectionGroupMode(id, chatId, mode),
        listLanes: async (id) => (await imRuntime()).listBotImConnectionLanesForSettings(id),
        resetLane: async (id, sessionId) => (await imRuntime()).resetBotImConnectionLaneForSettings(id, sessionId),
        listAdoptable: async () => (await import('../../im/shared/botImPersonalAdoption.js')).listAdoptablePersonalBots(),
        adopt: async (input) => (await import('../../im/shared/botImPersonalAdoption.js')).adoptPersonalBot(input),
      },
      wechat: async () => (await import('../../im/index.js')).getWechatSettingsApi(),
      x: {
        summary: async () => (await import('../../hook-control/ipc.js')).readXCompanionSummary(),
        setCompanion: async (botId, expected) => (await import('../../hook-control/ipc.js')).changeXCompanionBinding(botId, expected),
      },
    },
    voice: {
      models: async () => (await settingsVoice()).models(),
      voices: async selection => (await settingsVoice()).voices(selection),
      preference: async botId => (await settingsVoice()).preference(botId),
      setPreference: async (botId, selection, playback) => (await settingsVoice()).setPreference(botId, selection, playback),
    },
  }),
});
export const botRemoteManagement = { ...settings, getEditor, getInvitation, settingsHost };
