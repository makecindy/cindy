import type { RemoteResourceHostContext } from '../../device-link/remoteResourceRegistry.js';
import { botRemoteResourceFromSource } from './botRemoteResourceProjection.js';
import { inspectAppDefaultModel } from '../../maker-ipc/appDefaultModelControl.js';
import type { BotModelRoute } from '../../../shared/botModelChain.js';
import { createBotRemoteSettingsResource } from './botRemoteSettingsResource.js';
import { createBotProfile, createBotCanonicalSession, getBotMemoryService, getBotRemoteResourceSource, getBotRemoteSettingsSource, setBotProfileAvatar, updateBotProfile } from './bots.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../../appSessionState.js';
import { throwIpcError } from '../../utils/ipcValidate.js';
import { listBotSkillsForBot, readBotSkillForBot, saveBotSkillForSession, deleteBotSkillForBot } from '../../maker-ipc/botSkillService.js';
import { requestBotRuntimeEpochRefresh } from '../../maker-ipc/botRuntimeEpochRefreshSignal.js';
import { createBotRemoteEditors } from './botRemoteEditors.js';
import { decodeBotAvatarImage } from './botAvatarSelection.js';
import { runRegisteredBotLifecycleAction } from '../../maker-ipc/botLifecycleService.js';
import { listBotSettingsCapabilities, validateBotCapabilityAdditions } from '../../maker-host/index.js';

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
      const scope = activeOwnerScopeKey();
      const catalog = await inspectAppDefaultModel();
      if (isAppSessionBoundaryPending() || scope !== activeOwnerScopeKey()) throwIpcError('PRECONDITION_FAILED', 'Account changed');
      for (const route of capabilities.modelChainOverride) {
        const entry = catalog.available.find(item => item.route.harness === route.harness && item.route.model === route.model && item.route.providerId === route.providerId);
        if (!entry || route.effort && !entry.efforts.some(effort => effort === route.effort) || route.fastMode && !entry.supportsFastMode) throwIpcError('INVALID_PARAMS', 'Model route unavailable');
      }
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
export const botRemoteManagement = { ...settings, getEditor, getInvitation };
