import { mergeDiscoveredRuntimeModels, isOpenRouterModelsUrl, type DiscoveredModel } from '@cindy/model-providers';
/**
 * customProviders —— 自定义供应商「配置 + per-runtime 密钥」的 renderer 侧写入编排。
 *
 * 配置走 maker IPC（入 localDb）；密钥按 runtime 走通用 safeStorage IPC（`provider_key_<id>_<agent>`，
 * 本地加密，与内置 XD 网关 key 同机制；main 路由 resolve 时按 (id, agent) 读出注入鉴权头）。
 *
 * 顺序约定：
 *   - create / update / delete：配置 + 密钥一次提交给 main，由 main 的 per-provider queue
 *     串行暂存 / 回滚，跨窗口 mutation 不会被较早请求的迟到回滚覆盖。
 */

import { customProviderSecretStorageKey } from '@/../shared/providerSecrets';
import type {
  CustomProviderUpdateOptions,
  CustomProviderUpdateResult,
} from '@/../shared/customProviderUpdate';

import {
  DEFAULT_CUSTOM_CONTEXT_WINDOW,
  effectivePiWireProtocol,
  PI_REASONING_EFFORTS,
  preservesPiCatalogModels,
  storedCustomProviderId,
} from '@cindy/model-providers';
import type {
  AgentKind,
  CatalogModel,
  CustomProviderConfig,
  PiReasoningEffort,
  ProviderView,
  ProviderRuntimeModelConfig,
  ProviderWireProtocol,
} from '@cindy/model-providers';

interface PiCatalogRouteDraft {
  baseUrl: string;
  wireProtocol?: ProviderWireProtocol;
  piCatalogProviderId?: string;
  models?: readonly ProviderRuntimeModelConfig[];
}

/** The catalog marker is valid while the route and every existing model's capability fields stay unchanged. */
export function piCatalogProviderIdAfterRouteEdit(
  agent: AgentKind,
  previous: PiCatalogRouteDraft,
  next: PiCatalogRouteDraft,
): string | undefined {
  const marker = next.piCatalogProviderId;
  if (agent !== 'pi' || !marker || marker !== previous.piCatalogProviderId) return marker;
  const normalizeBaseUrl = (value: string) => value.trim().replace(/\/+$/, '');
  return normalizeBaseUrl(previous.baseUrl) === normalizeBaseUrl(next.baseUrl) &&
    effectivePiWireProtocol(previous.wireProtocol) === effectivePiWireProtocol(next.wireProtocol) &&
    preservesPiCatalogModels(previous.models, next.models)
    ? marker
    : undefined;
}

/** per-runtime 密钥输入：键为 agent，值为该 runtime 的 API key（空串 = 不改 / 不存）。 */
export type RuntimeKeys = Partial<Record<AgentKind, string>>;

/** PI always persists the selected protocol, including its common Chat default. */
export function customProviderWireProtocolForSave(
  agent: AgentKind,
  wireProtocol: ProviderWireProtocol,
  defaultWireProtocol: ProviderWireProtocol,
): ProviderWireProtocol | undefined {
  return agent === 'pi' || wireProtocol !== defaultWireProtocol ? wireProtocol : undefined;
}

/**
 * 运行期 CatalogModel 已把缺省 contextWindow 物化为通用默认值；转回用户配置时不能把该
 * 默认快照写成 override，否则未来默认升级后老配置无法跟随。判据以 contextWindowExplicit
 * 标记为准——用户显式填的值哪怕恰好等于当前默认（如 200K）也必须原样保留，不能靠等值
 * 推断（PR review P1）；无标记的旧视图快照回退等值判断,行为不变。
 */
export function customProviderModelConfigFromCatalogModel(
  model: Pick<
    CatalogModel,
    | 'id'
    | 'name'
    | 'contextWindow'
    | 'contextWindowExplicit'
    | 'userModelConfig'
    | 'discoveredMetadata'
    | 'discoveredCost'
    | 'nameExplicit'
    | 'defaultEnabled'
    | 'supportsImageInput'
    | 'piApi'
    | 'route'
  > &
    Partial<Pick<CatalogModel, 'efforts' | 'defaultEffort'>>,
  agent?: AgentKind,
): ProviderRuntimeModelConfig {
  if (model.userModelConfig) return structuredClone(model.userModelConfig);
  const reasoningEfforts =
    agent === 'pi'
      ? (model.efforts ?? []).filter((effort): effort is PiReasoningEffort =>
          (PI_REASONING_EFFORTS as readonly string[]).includes(effort),
        )
      : [];
  return {
    id: model.id,
    name: model.name,
    discoveredMetadata: model.discoveredMetadata,
    discoveredCost: model.discoveredCost,
    nameExplicit: model.nameExplicit,
    ...(agent === 'pi' && model.piApi ? { piApi: model.piApi } : {}),
    ...(model.route ? { route: { ...model.route } } : {}),
    ...(model.contextWindowExplicit === true ||
    (model.contextWindowExplicit === undefined &&
      !model.discoveredMetadata &&
      model.contextWindow !== DEFAULT_CUSTOM_CONTEXT_WINDOW)
      ? { contextWindow: model.contextWindow }
      : {}),
    ...(model.defaultEnabled === false ? { defaultEnabled: false } : {}),
    ...(model.supportsImageInput === true ? { supportsImageInput: true } : {}),
    ...(reasoningEfforts.length > 0 ? { reasoning: true, reasoningEfforts } : {}),
    ...(agent === 'pi' &&
    model.defaultEffort &&
    reasoningEfforts.includes(model.defaultEffort as PiReasoningEffort)
      ? { reasoningDefaultEffort: model.defaultEffort as PiReasoningEffort }
      : {}),
  };
}

/** ProviderView → 编辑表单配置；必须无损保留所有非密钥路由/鉴权字段。 */
export function providerViewToCustomProviderConfig(p: ProviderView): CustomProviderConfig {
  if (p.auth.native) {
    const native = p.auth.native;
    return {
      id: storedCustomProviderId(p.id), name: p.name, auth: { method: 'oauth', native },
      runtimes: native === 'claude'
        ? { 'claude-code': { baseUrl: 'https://api.anthropic.com', wireProtocol: 'anthropic-messages', models: [] } }
        : { codex: { baseUrl: native === 'codex' ? 'https://chatgpt.com/backend-api/codex' : 'https://api.x.ai/v1', wireProtocol: 'openai-responses', models: native === 'codex' ? (p.models.codex ?? []).map(model => customProviderModelConfigFromCatalogModel(model, 'codex')) : [] } },
    };
  }
  const runtimes: CustomProviderConfig['runtimes'] = {};
  for (const agent of p.agents) {
    const routing = p.routing[agent];
    const models = p.models[agent] ?? [];
    runtimes[agent] = {
      baseUrl: routing?.upstream ?? '',
      ...(models[0]?.catalogPresetId ? { catalogPresetId: models[0].catalogPresetId } : {}),
      ...(routing?.requestPath ? { requestPath: routing.requestPath } : {}),
      ...(routing?.wireProtocol ? { wireProtocol: routing.wireProtocol } : {}),
      ...(agent === 'codex' && routing?.supportsImageGeneration === true
        ? { supportsImageGeneration: true }
        : {}),
      models: models.map((model) => customProviderModelConfigFromCatalogModel(model, agent)),
      ...(routing?.headerOverride && Object.keys(routing.headerOverride).length > 0
        ? { headers: { ...routing.headerOverride } }
        : {}),
      ...(routing?.headerOverrideState ? { headersState: routing.headerOverrideState } : {}),
      ...(routing?.modelsUrl ? { modelsUrl: routing.modelsUrl } : {}),
      ...(routing?.piCatalogProviderId ? { piCatalogProviderId: routing.piCatalogProviderId } : {}),
    };
  }
  return {
    id: storedCustomProviderId(p.id),
    name: p.name,
    ...(p.auth.method === 'oauth' && p.auth.oauth
      ? { auth: { method: 'oauth' as const, oauth: p.auth.oauth } }
      : p.auth.method === 'none'
        ? { auth: { method: 'none' as const } }
        : {}),
    runtimes,
  };
}

/** 刷新时只追加接口新发现的模型，并让新增模型默认隐藏。端点声明的 contextWindow 随发现带入(#386)。 */
export function appendDiscoveredCustomProviderModels(
  existing: readonly ProviderRuntimeModelConfig[],
  discovered: readonly DiscoveredModel[],
  discoveryUrl?: string,
): { models: ProviderRuntimeModelConfig[]; addedIds: string[] } {
  let prior = existing;
  if (discoveryUrl && isOpenRouterModelsUrl(discoveryUrl)) {
    const actual = new Map(discovered.map(model => [model.id, model]));
    // Repair only discovery-created Anthropic wrappers confirmed by the complete
    // canonical response. Keep manual IDs and never guess another supplier's aliases.
    const canonicalId = (model: ProviderRuntimeModelConfig) => {
      if (actual.has(model.id) || !model.discoveredMetadata || model.nameExplicit || model.route || model.piApi || !model.id.startsWith('anthropic/')) return model.id;
      const candidate = model.id.slice('anthropic/'.length).replace(/\[1m\]$/, '');
      return actual.has(candidate) ? candidate : model.id;
    };
    const normalized = new Map(existing.filter(model => canonicalId(model) === model.id).map(model => [model.id, model]));
    for (const model of existing) {
      const id = canonicalId(model);
      if (id === model.id) continue;
      const canonical = normalized.get(id);
      normalized.set(id, { ...model, ...canonical, id,
        name: canonical?.nameExplicit ? canonical.name : actual.get(id)?.name ?? model.name });
    }
    prior = [...normalized.values()];
  }
  const models = mergeDiscoveredRuntimeModels(prior, discovered, true);
  const known = new Set(existing.map((model) => model.id));
  return {
    models,
    addedIds: models.filter((model) => !known.has(model.id)).map((model) => model.id),
  };
}

/**
 * 读取该自定义供应商**某 runtime** 本机已存的明文密钥（用户自己的 key）；无密钥返回 null，
 * IPC 读取失败则向调用方抛出，避免把“无法读取”误当成“没有密钥”。
 * 用于编辑态回填(「能看」)与已保存探测。明文仅在 renderer 本地用于回显 / 核对,不外发。
 */
export async function readCustomProviderKey(
  providerId: string,
  agent: AgentKind,
): Promise<string | null> {
  const value = await window.electronAPI.safeStorageRead(
    customProviderSecretStorageKey(storedCustomProviderId(providerId), agent),
  );
  return value && value.length > 0 ? value : null;
}

// 鉴权请求头是 main-only 密文(isRendererAccessibleSafeStorageKey 明确拒 provider_headers_
// 前缀,与 API key 不同),renderer 不得回读明文。编辑时不再向 renderer 暴露头值:未在
// 表单显式改动请求头,update 由 main 侧保留旧值(planProviderHeaderMutations 'update' 分支)。

/** 新建：配置与 runtime 密钥交给 main 的同一 provider mutation queue。 */
export async function createCustomProvider(
  config: CustomProviderConfig,
  keys: RuntimeKeys,
  options?: CustomProviderUpdateOptions,
): Promise<CustomProviderUpdateResult> {
  return options === undefined
    ? window.electronAPI.maker.createCustomProvider(config, keys)
    : window.electronAPI.maker.createCustomProvider(config, keys, options);
}

/** 编辑：main 在同一 provider mutation queue 内提交配置与 runtime 密钥。 */
export async function updateCustomProvider(
  config: CustomProviderConfig,
  keys: RuntimeKeys,
  options?: CustomProviderUpdateOptions,
): Promise<CustomProviderUpdateResult> {
  const storedConfig = { ...config, id: storedCustomProviderId(config.id) };
  return options === undefined
    ? window.electronAPI.maker.updateCustomProvider(storedConfig, keys)
    : window.electronAPI.maker.updateCustomProvider(storedConfig, keys, options);
}

/** 删除：main 在同一 provider mutation queue 内清配置与所有凭证。 */
export async function deleteCustomProvider(providerId: string, ownerScope?: { dataOwnerId: string | null; ownerGeneration: number }, options?: CustomProviderUpdateOptions): Promise<CustomProviderUpdateResult> {
  if (options !== undefined) return window.electronAPI.maker.deleteCustomProvider(storedCustomProviderId(providerId), ownerScope, options);
  if (ownerScope === undefined) return window.electronAPI.maker.deleteCustomProvider(storedCustomProviderId(providerId));
  return window.electronAPI.maker.deleteCustomProvider(storedCustomProviderId(providerId), ownerScope);
}
