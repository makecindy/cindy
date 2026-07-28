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

import { DEFAULT_CUSTOM_CONTEXT_WINDOW } from '@cindy/model-providers';
import type {
  AgentKind,
  CatalogModel,
  CustomProviderConfig,
  ProviderView,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

/** per-runtime 密钥输入：键为 agent，值为该 runtime 的 API key（空串 = 不改 / 不存）。 */
export type RuntimeKeys = Partial<Record<AgentKind, string>>;

/**
 * 模型 id 代表模型身份；一旦改变，旧模型携带的 contextWindow 等隐藏元数据不再可信。
 * id 未变时保留原引用，避免无意义地丢掉仍有效的预设元数据。
 */
export function replaceCustomProviderModelId(
  model: ProviderRuntimeModelConfig,
  nextId: string,
): ProviderRuntimeModelConfig {
  if (nextId === model.id) return model;
  return { id: nextId, name: model.name };
}

/**
 * 运行期 CatalogModel 已把缺省 contextWindow 物化为通用默认值；转回用户配置时不能把该
 * 默认快照写成 override，否则未来默认升级后老配置无法跟随。厂商明确的非默认值则保留。
 */
export function customProviderModelConfigFromCatalogModel(
  model: Pick<CatalogModel, 'id' | 'name' | 'contextWindow' | 'defaultEnabled'>,
): ProviderRuntimeModelConfig {
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindow !== DEFAULT_CUSTOM_CONTEXT_WINDOW
      ? { contextWindow: model.contextWindow }
      : {}),
    ...(model.defaultEnabled === false ? { defaultEnabled: false } : {}),
  };
}

/** ProviderView → 编辑表单配置；必须无损保留所有非密钥路由/鉴权字段。 */
export function providerViewToCustomProviderConfig(p: ProviderView): CustomProviderConfig {
  const runtimes: CustomProviderConfig['runtimes'] = {};
  for (const agent of p.agents) {
    const routing = p.routing[agent];
    const models = p.models[agent] ?? [];
    runtimes[agent] = {
      baseUrl: routing?.upstream ?? '',
      ...(routing?.requestPath ? { requestPath: routing.requestPath } : {}),
      ...(routing?.wireProtocol ? { wireProtocol: routing.wireProtocol } : {}),
      models: models.map(customProviderModelConfigFromCatalogModel),
      ...(routing?.headerOverride && Object.keys(routing.headerOverride).length > 0
        ? { headers: { ...routing.headerOverride } }
        : {}),
      ...(routing?.modelsUrl ? { modelsUrl: routing.modelsUrl } : {}),
    };
  }
  return {
    id: p.id,
    name: p.name,
    ...(p.auth.method === 'oauth' && p.auth.oauth
      ? { auth: { method: 'oauth' as const, oauth: p.auth.oauth } }
      : p.auth.method === 'none'
        ? { auth: { method: 'none' as const } }
        : {}),
    runtimes,
  };
}

/** 刷新时只追加接口新发现的模型，并让新增模型默认隐藏。 */
export function appendDiscoveredCustomProviderModels(
  existing: readonly ProviderRuntimeModelConfig[],
  discovered: readonly Pick<ProviderRuntimeModelConfig, 'id' | 'name'>[],
): { models: ProviderRuntimeModelConfig[]; addedIds: string[] } {
  const known = new Set(existing.map((m) => m.id));
  const models = [...existing];
  const addedIds: string[] = [];
  for (const model of discovered) {
    if (!model.id || !model.name || known.has(model.id)) continue;
    models.push({ id: model.id, name: model.name, defaultEnabled: false });
    known.add(model.id);
    addedIds.push(model.id);
  }
  return { models, addedIds };
}

/**
 * 读取该自定义供应商**某 runtime** 本机已存的明文密钥（用户自己的 key）；无 / 读失败返回 null。
 * 用于编辑态回填(「能看」)与已保存探测。明文仅在 renderer 本地用于回显 / 核对,不外发。
 */
export async function readCustomProviderKey(
  providerId: string,
  agent: AgentKind,
): Promise<string | null> {
  try {
    const v = await window.electronAPI.safeStorageRead(
      customProviderSecretStorageKey(providerId, agent),
    );
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** 新建：配置与 runtime 密钥交给 main 的同一 provider mutation queue。 */
export async function createCustomProvider(
  config: CustomProviderConfig,
  keys: RuntimeKeys,
): Promise<void> {
  await window.electronAPI.maker.createCustomProvider(config, keys);
}

/** 编辑：main 在同一 provider mutation queue 内提交配置与 runtime 密钥。 */
export async function updateCustomProvider(
  config: CustomProviderConfig,
  keys: RuntimeKeys,
): Promise<void> {
  await window.electronAPI.maker.updateCustomProvider(config, keys);
}

/** 删除：main 在同一 provider mutation queue 内清配置与所有凭证。 */
export async function deleteCustomProvider(providerId: string): Promise<void> {
  await window.electronAPI.maker.deleteCustomProvider(providerId);
}
