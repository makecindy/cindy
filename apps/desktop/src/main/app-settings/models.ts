import { manageAppPreferences } from './preferences.js';
import { isModelVisible } from '@cindy/model-providers';
import type { AppModelsRequest } from '@cindy/mcps';
import type { registerProviderHandlers } from '../maker-ipc/providerHandlers.js';
import { manageProviderConnection, type RequestProviderSecret } from './connections.js';
import { parseMediaInvocationGuide } from '../../shared/mediaInvocation.js';
import { getMediaGuide, fetchMediaInvocationGuide, localMediaGuides, resetExecutableMediaModelCache, supportsMediaCapability } from '../model-access/mediaModels.js';
import { providerMediaGuideScope, providerMediaGuideTarget } from '../cindy-media/providerMediaRuntime.js';
import { mediaGuideModel } from '../cindy-brain/customMediaConnection.js';

type Actions = ReturnType<typeof registerProviderHandlers>;
let actions: Actions | undefined;
/** 目录形状：对话模型按 agent 分列，媒体模型列在 provider 上。 */
type CatalogProviders = Awaited<ReturnType<Actions['list']>>['providers'];
/** Same shape the catalog uses for visibility overrides. */
function visibilityKey(target: { agent: string; providerId: string; modelId: string }): string {
  return `${target.agent}:${target.providerId}:${target.modelId}`;
}

/**
 * Agents whose visibility override a media entry can be stored under. `isCatalogMediaModelVisible`
 * (cindy-brain/mediaDisplayVisibility.ts) reads the explicit source when there is one, while the
 * mirror's legacy projection writes every media entry under the provider's first agent
 * (maker-host/model-visibility-mirror.ts). Media entries are not in the chat selector, but both
 * spellings use the same flat key, so either can collide with a chat target.
 */
function mediaEntryAgents(
  provider: CatalogProviders[number],
  entry: { sourceAgent?: string; sourceAgents?: readonly string[] },
): string[] {
  const agents = new Set<string>([provider.agents[0] ?? 'claude-code']);
  if (entry.sourceAgents?.length) for (const agent of entry.sourceAgents) agents.add(agent);
  else if (entry.sourceAgent) agents.add(entry.sourceAgent);
  return [...agents];
}

/**
 * Whether this target is the only catalog entry whose parts spell `visibilityKey(target)`.
 * The flat key is ambiguous when an id contains `:`, so a typo could otherwise clear
 * another model's stored preference.
 */
function visibilityKeyIsUnambiguous(
  providers: CatalogProviders,
  target: { agent: string; providerId: string; modelId: string },
): boolean {
  const wanted = visibilityKey(target);
  const prefix = `${target.agent}:`;
  for (const provider of providers) {
    // Entry scans miss retired models: `pi:custom:xai:foo` is spelled both by the live
    // provider `custom:xai` (model `foo`) and by `(pi, custom, xai:foo)`. Any live provider
    // id that fits the rest of the key makes the split ambiguous on its own.
    if (provider.id !== target.providerId && wanted.startsWith(`${prefix}${provider.id}:`)) return false;
    for (const [agent, list] of Object.entries(provider.models)) {
      for (const entry of list ?? []) {
        if (`${agent}:${provider.id}:${entry.id}` !== wanted) continue;
        if (agent === target.agent && provider.id === target.providerId && entry.id === target.modelId) continue;
        return false;
      }
    }
    // A media entry that spells this key always owns it: this switch refuses media entries of
    // the requested provider above, so the target can never be the entry being matched.
    for (const list of [provider.imageModels, provider.videoModels, provider.audioModels,
      provider.evaluationModels, provider.embeddingModels]) {
      for (const entry of list ?? []) {
        if (!mediaEntryAgents(provider, entry).some(agent => `${agent}:${provider.id}:${entry.id}` === wanted)) continue;
        return false;
      }
    }
  }
  return true;
}

export function configureModelSettingsActions(value: Actions): void { actions = value; }

/** These are shared domain operations. IPC still performs its sender checks separately. */
export async function manageAppModels(input: AppModelsRequest, assertCurrent: () => Promise<void>,
  requestSecret: RequestProviderSecret = async () => { throw new Error('SECRET_INPUT_UNAVAILABLE'); }, signal?: AbortSignal) {
  // One budget for every input card and queued mutation, below Codex's 10-minute tool limit.
  const deadline = Date.now() + 9 * 60_000;
  const assertWaiting = () => {
    signal?.throwIfAborted();
    if (input.operation === 'connection' && Date.now() >= deadline) throw new Error('MODEL_CONNECTION_EXPIRED');
  };
  assertWaiting();
  if (!actions) throw new Error('MODEL_SETTINGS_NOT_READY');
  const api = actions;
  await assertCurrent();
  const owner = api.owner();
  const guard = async () => {
    assertWaiting();
    await assertCurrent();
    assertWaiting();
    const current = api.owner();
    if (current.dataOwnerId !== owner.dataOwnerId || current.ownerGeneration !== owner.ownerGeneration)
      throw new Error('OWNER_SCOPE_CHANGED');
  };
  if (input.operation === 'connection') return { scope: 'local', ...await manageProviderConnection(input.change, api.connections, guard,
    (name, endpoints) => requestSecret(name, endpoints, { signal, deadline })) };
  if (input.operation === 'mediaGuide') {
    const { change } = input;
    if (input.target.providerId === 'xd') {
      if (change.action !== 'get') return { ok: false, errorCode: 'GUIDE_OVERRIDE_NOT_SUPPORTED',
        message: 'Cindy AI 只使用官方 Guide，不支持自定义覆盖；无需配置其他模型连接。' };
      const result = await fetchMediaInvocationGuide(input.target.modelId);
      await guard();
      return { scope: 'local', target: input.target, status: 'available', source: 'official', guide: result.guide, customRevision: null };
    }
    const target = providerMediaGuideTarget(input.target);
    const catalog = await api.list(false);
    await guard();
    const model = mediaGuideModel(catalog.providers.find(provider => provider.id === target.providerId), target);
    const connectionScope = providerMediaGuideScope(target);
    if (!model || !connectionScope) return { ok: false, errorCode: 'MEDIA_DECLARATION_REQUIRED',
      message: '先通过 configure_model_connection 为这个实际连接的型号声明 image_generation/video_generation 和 modalities。' };
    try {
      if (change.action === 'get') {
        const result = await getMediaGuide(target, change.source);
        await guard();
        return { scope: 'local', target, customRevision: localMediaGuides.revision(target),
          ...(result ? { status: 'available', source: result.source, guide: result.value }
            : { status: 'missing', errorCode: 'GUIDE_NOT_AVAILABLE', message: '请用户提供接口文档、cURL 或提示，再通过 validate/save 补齐；不需要加载或重载。',
              example: { schemaVersion: 1, guideId: 'local-media', revision: 'draft', operations: [{
                capability: model.mode === 'video_generation' ? 'video.generate' : 'image.generate',
                request: { method: 'POST', path: '/replace-with-documented-path', bodyModelPath: ['model'], timeoutMs: 120000, maxRequestBytes: 33554432, maxResponseBytes: 33554432 },
                response: { mode: 'sync', media: [{ path: ['data', '*', 'url'], encoding: 'url', kind: model.mode === 'video_generation' ? 'video' : 'image', allowedUrlHosts: [] }] },
                instructions: '按用户资料填写实际参数和结果结构；异步接口须声明 taskIdPath 及 poll。',
                exampleBody: { prompt: 'example' }, inputSchema: { type: 'object', required: ['prompt'], properties: { prompt: { type: 'string', minLength: 1 } } },
              }] } }),
        };
      }
      const parsed = parseMediaInvocationGuide(change.guide);
      if (!parsed.ok) return { ok: false, errorCode: 'GUIDE_INVALID', message: parsed.error };
      if (Buffer.byteLength(JSON.stringify(parsed.value)) > 512 * 1024) return { ok: false, errorCode: 'GUIDE_TOO_LARGE' };
      if (parsed.value.operations.some(operation => !operation.capability.startsWith(model.mode === 'image_generation' ? 'image.' : 'video.') ||
          (model.modalities && !supportsMediaCapability(model.modalities, operation.capability))))
        return { ok: false, errorCode: 'GUIDE_TARGET_MISMATCH', message: 'Guide 的操作超出这个实际连接声明的媒体能力，请先核对声明或接口资料。' };
      if (change.action === 'validate') return { scope: 'local', target, valid: true, capabilities: parsed.value.operations.map(operation => operation.capability) };
      await guard();
      if (providerMediaGuideScope(target) !== connectionScope) throw new Error('CONNECTION_CHANGED');
      const saved = localMediaGuides.save(target, connectionScope, parsed.value, change.expectedRevision, change.evidence);
      resetExecutableMediaModelCache();
      return { scope: 'local', target, saved: true, source: 'custom', customRevision: saved.guide.revision,
        guide: saved.guide, verification: 'not_called', message: '已保存。再次 get/prepare 即可使用；若原调用已经提交，新 prepare 传 source_invocation_id=原调用，再按 next_action 直接 request/poll 复用回执，不要重新生成。配置与调用仍走当前权限。' };
    } catch (error) {
      return { ok: false, errorCode: error instanceof Error && error.message === 'GUIDE_REVISION_CONFLICT' ? 'GUIDE_REVISION_CONFLICT' : 'GUIDE_ACCESS_FAILED',
        message: 'Guide 操作未完成，请重新 get 核对最新定义和连接；不要通过文件或原始 HTTP 绕过。' };
    }
  }
  if (input.operation === 'get') {
    const [context, imageInput, price] = await Promise.all([
      api.getContext(input.target), api.getImageInput(input.target), api.getPrice(input.target),
    ]);
    await guard();
    const catalog = await api.list(false);
    await guard();
    const model = catalog.providers.find(provider => provider.id === input.target.providerId)?.models[input.target.agent]?.find(model => model.id === input.target.modelId);
    const override = catalog.modelVisibilityOverrides[`${input.target.agent}:${input.target.providerId}:${input.target.modelId}`];
    return { scope: 'local', target: input.target, context, imageInput, price,
      visibility: { visible: isModelVisible(override, model?.defaultEnabled), customized: override !== undefined, disabled: model?.disabled === true } };

  }
  if (input.operation === 'set') {
    const { target, change } = input;
    await guard();
    let result: unknown;
    switch (change.setting) {
      case 'visible': {
        const catalog = await api.list(false);
        await guard();
        const provider = catalog.providers.find(entry => entry.id === target.providerId);
        // Chat models are listed per agent; media models are listed once for the provider
        // and are handled by the media settings, never by this selector switch.
        const model = provider?.models[target.agent]?.find(model => model.id === target.modelId);
        // Media entries (image / video / audio / …) are listed once for the provider, are
        // not in the chat selector, and are read through their own source agent. This
        // tool's `visible` is the selector switch, so it never edits them: the media
        // settings page owns those. Refusing beats reporting a reset that cleaned a key
        // nobody reads.
        const mediaEntry = !model && [...(provider?.imageModels ?? []), ...(provider?.videoModels ?? []),
          ...(provider?.audioModels ?? []), ...(provider?.evaluationModels ?? []),
          ...(provider?.embeddingModels ?? [])].some(entry => entry.id === target.modelId);
        // A provider that left the catalog keeps its overrides. value=null only removes the
        // stored choice, so it must stay available for those orphan keys; an explicit on/off
        // choice still needs a catalog entry to resolve the default.
        if (!model && (change.value !== null || mediaEntry)) throw new Error('MODEL_NOT_IN_CATALOG');
        // Resetting a key that never existed is not a no-op: the renderer records every
        // reset in `followCatalogKeys` and nothing removes such a key again, so a typo
        // would accumulate in local storage forever. Only a stored override may be cleared
        // without a catalog entry.
        if (!model && catalog.modelVisibilityOverrides[visibilityKey(target)] === undefined) {
          throw new Error('MODEL_NOT_IN_CATALOG');
        }
        // The override map is flat and joins its parts with `:`, while provider and model
        // ids may contain `:` themselves (`custom:xai`, `xai:foo`). A stored `pi:custom:xai:foo`
        // is also produced by the different target `(pi, custom, xai:foo)`, so "the key
        // exists" cannot prove this target owns it: refuse keys any other catalog entry
        // would spell the same way.
        if (!model && !visibilityKeyIsUnambiguous(catalog.providers, target)) {
          throw new Error('MODEL_NOT_IN_CATALOG');
        }
        await guard();
        const receipt = await manageAppPreferences('model-visibility', undefined, { target, visible: change.value, defaultEnabled: model?.defaultEnabled });
        if (!receipt.modelVisibility || (change.value === null
          ? receipt.modelVisibility.customized !== false
          : receipt.modelVisibility.visible !== change.value)) throw new Error('MODEL_VISIBILITY_NOT_CONFIRMED');
        result = receipt.modelVisibility;
        break;
      }
      case 'contextLimit': result = await api.setContext(target, change.value, owner); break;
      case 'compactionPercent': result = await api.setCompaction(target, change.value, owner); break;
      case 'imageInput': result = await api.setImageInput(target, change.value, owner); break;
      case 'price': result = change.value === null ? await api.resetPrice(target) : await api.setPrice(target, change.value); break;
    }
    await guard();
    return { scope: 'local', target, setting: change.setting, result };
  }
  if (input.operation === 'provider') {
    const change = input.change;
    await guard();
    switch (change.action) {
      case 'subscriptionAccounts': {
        const { parseSubscriptionAccountCommand } = await import('../subscription-accounts/commands.js');
        const { executeSubscriptionAccountCommand } = await import('../subscription-accounts/service.js');
        await guard();
        const accounts = await executeSubscriptionAccountCommand(parseSubscriptionAccountCommand({ ...change.command, providerId: change.providerId }));
        await guard();
        return { scope: 'local', providerId: change.providerId, accounts };
      }
      case 'rename': case 'remove': case 'restore': await api.presentation({ ...owner, ...change }); break;
      case 'order': await api.order({ ...owner, providerIds: change.providerIds }); break;
      case 'visibility': await api.visibility({ providerId: change.providerId, kind: change.modelIds ? 'model' : 'provider',
        disabled: change.disabled, ...(change.modelIds ? { modelIds: change.modelIds } : {}) }); break;
      case 'resetVisibility': await api.visibility({ providerId: change.providerId, kind: 'reset' }); break;
      case 'rediscover': {
        const result = await api.rediscover(change.providerId);
        await guard();
        if (!result.ok) return { scope: 'local', ...result };
        break;
      }
    }
    await guard();
  }
  const state = await api.list(false);
  await guard();
  const providerId = input.operation === 'list' ? input.providerId
    : 'providerId' in input.change ? input.change.providerId : undefined;
  return { scope: 'local', ...state,
    providers: providerId ? state.providers.filter(provider => provider.id === providerId) : state.providers };
}
