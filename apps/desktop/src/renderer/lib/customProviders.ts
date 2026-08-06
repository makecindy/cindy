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

import { DEFAULT_CUSTOM_CONTEXT_WINDOW, PI_REASONING_EFFORTS } from '@cindy/model-providers';
import type {
  AgentKind,
  CatalogModel,
  CustomProviderConfig,
  PiReasoningEffort,
  ProviderView,
  ProviderRuntimeModelConfig,
} from '@cindy/model-providers';

/** 开启 Pi reasoning 时的保守常用档位；xhigh/max 仍需用户明确勾选。 */
export const DEFAULT_PI_CUSTOM_REASONING_EFFORTS: readonly PiReasoningEffort[] = [
  'minimal',
  'low',
  'medium',
  'high',
];

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

export function setCustomProviderModelSupportsImageInput(
  models: readonly ProviderRuntimeModelConfig[],
  targetIndex: number,
  supportsImageInput: boolean,
): ProviderRuntimeModelConfig[] {
  return models.map((model, index) => {
    if (index !== targetIndex) return model;
    return { ...model, supportsImageInput };
  });
}

export function setCustomProviderModelReasoning(
  models: readonly ProviderRuntimeModelConfig[],
  targetIndex: number,
  reasoning: boolean,
): ProviderRuntimeModelConfig[] {
  return models.map((model, index) => {
    if (index !== targetIndex) return model;
    if (!reasoning) {
      const { reasoning: _reasoning, reasoningEfforts: _reasoningEfforts, ...rest } = model;
      return rest;
    }
    return {
      ...model,
      reasoning: true,
      reasoningEfforts: model.reasoningEfforts?.length
        ? [...model.reasoningEfforts]
        : [...DEFAULT_PI_CUSTOM_REASONING_EFFORTS],
    };
  });
}

export function setCustomProviderModelReasoningEffort(
  models: readonly ProviderRuntimeModelConfig[],
  targetIndex: number,
  effort: PiReasoningEffort,
  enabled: boolean,
): ProviderRuntimeModelConfig[] {
  return models.map((model, index) => {
    if (index !== targetIndex || model.reasoning !== true) return model;
    const current = model.reasoningEfforts ?? [];
    if (!enabled && current.length <= 1 && current.includes(effort)) return model;
    const selected = new Set(current);
    if (enabled) selected.add(effort);
    else selected.delete(effort);
    return {
      ...model,
      reasoningEfforts: PI_REASONING_EFFORTS.filter((candidate) => selected.has(candidate)),
    };
  });
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
    | 'maxOutput'
    | 'mode'
    | 'defaultEnabled'
    | 'supportsImageInput'
    | 'modalities'
    | 'capabilities'
  > &
    Partial<Pick<CatalogModel, 'efforts'>>,
  agent?: AgentKind,
): ProviderRuntimeModelConfig {
  const reasoningEfforts =
    agent === 'pi'
      ? (model.efforts ?? []).filter((effort): effort is PiReasoningEffort =>
          (PI_REASONING_EFFORTS as readonly string[]).includes(effort),
        )
      : [];
  return {
    id: model.id,
    name: model.name,
    ...(model.contextWindowExplicit === true || model.contextWindow !== DEFAULT_CUSTOM_CONTEXT_WINDOW
      ? { contextWindow: model.contextWindow }
      : {}),
    ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
    ...(model.mode !== undefined ? { mode: model.mode } : {}),
    // 厂商自报的模态/能力随编辑往返保留(与 contextWindow 同理,缺省不写)。
    ...(model.modalities ? { modalities: model.modalities } : {}),
    ...(model.capabilities ? { capabilities: model.capabilities } : {}),
    ...(model.defaultEnabled === false ? { defaultEnabled: false } : {}),
    ...(model.supportsImageInput === true ? { supportsImageInput: true } : {}),
    ...(reasoningEfforts.length > 0 ? { reasoning: true, reasoningEfforts } : {}),
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
      models: models.map((model) => customProviderModelConfigFromCatalogModel(model, agent)),
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

/**
 * 厂商 /v1/models 自报的分类/能力事实**入参形状**(对齐 fetch 结果的
 * ProviderReportedModelHints):capabilities 是宽松的 `Record<string, unknown>`(上游可能报
 * 任意键),持久化前再收窄。
 */
export interface DiscoveredReportedInput {
  mode?: string;
  contextWindow?: number;
  maxOutput?: number;
  modalities?: { input: string[]; output: string[] };
  capabilities?: Record<string, unknown>;
}

/** 收窄后、可直接写进配置的能力事实(与 ProviderRuntimeModelConfig 同形)。 */
export interface DiscoveredProviderReported {
  mode?: string;
  contextWindow?: number;
  maxOutput?: number;
  modalities?: ProviderRuntimeModelConfig['modalities'];
  capabilities?: ProviderRuntimeModelConfig['capabilities'];
}

/**
 * `maxOutput` 是上游硬上限而非可编辑偏好。刷新只能维持或收紧限制，不能因较大的新值
 * 自动放宽；这样供应商降限后不会继续发送超预算请求，升限则等待明确的配置迁移。
 */
function conservativeMaxOutput(
  existing: number | undefined,
  reported: number | undefined,
): number | undefined {
  if (existing === undefined) return reported;
  if (reported === undefined) return existing;
  return Math.min(existing, reported);
}

/** 已知能力键(对齐 CatalogModel.capabilities);上游宽松 capabilities 只取这些 boolean。 */
const MODEL_CAPABILITY_KEYS = ['reasoning', 'toolCall', 'attachment', 'temperature'] as const;

/** 从一次上报里提取可持久化的分类/能力字段。 */
export function persistableProviderReportedModelHints(
  pr: DiscoveredReportedInput | undefined,
): DiscoveredProviderReported {
  const out: DiscoveredProviderReported = {};
  if (!pr) return out;
  if (typeof pr.mode === 'string') {
    const mode = pr.mode.trim();
    if (mode.length > 0 && mode.length <= 128) out.mode = mode;
  }
  if (typeof pr.contextWindow === 'number' && pr.contextWindow > 0) out.contextWindow = pr.contextWindow;
  if (typeof pr.maxOutput === 'number' && Number.isFinite(pr.maxOutput) && pr.maxOutput > 0) {
    out.maxOutput = pr.maxOutput;
  }
  if (pr.modalities && Array.isArray(pr.modalities.input) && Array.isArray(pr.modalities.output)) {
    out.modalities = { input: [...pr.modalities.input], output: [...pr.modalities.output] };
  }
  if (pr.capabilities) {
    const caps: NonNullable<ProviderRuntimeModelConfig['capabilities']> = {};
    for (const k of MODEL_CAPABILITY_KEYS) {
      if (typeof pr.capabilities[k] === 'boolean') caps[k] = pr.capabilities[k] as boolean;
    }
    if (Object.keys(caps).length > 0) out.capabilities = caps;
  }
  return out;
}

/**
 * 用发现 / resolve 的能力事实更新表单行。mode 没有手工编辑入口，最新有效上报是权威事实，
 * 可覆盖旧值；contextWindow 与能力字段仍只 gap-fill。maxOutput 是隐藏的安全上限，取已有
 * 值与新上报值的较小者，允许供应商降限但不自动放宽。
 * 上游宽松 capability map 会先收窄成客户端可持久化的四个 boolean 键。
 */
export function fillCustomProviderModelMetadata(
  model: ProviderRuntimeModelConfig,
  reported: DiscoveredReportedInput | undefined,
): ProviderRuntimeModelConfig {
  const picked = persistableProviderReportedModelHints(reported);
  const maxOutput = conservativeMaxOutput(model.maxOutput, picked.maxOutput);
  return {
    ...model,
    ...(picked.mode !== undefined && model.mode !== picked.mode ? { mode: picked.mode } : {}),
    ...(model.contextWindow === undefined && picked.contextWindow !== undefined
      ? { contextWindow: picked.contextWindow }
      : {}),
    ...(maxOutput !== undefined && maxOutput !== model.maxOutput
      ? { maxOutput }
      : {}),
    ...(model.modalities === undefined && picked.modalities !== undefined
      ? { modalities: picked.modalities }
      : {}),
    ...(model.capabilities === undefined && picked.capabilities !== undefined
      ? { capabilities: picked.capabilities }
      : {}),
  };
}

/** CustomProviderDialog 保存 / picker 重建行时的唯一可持久化投影。 */
export function customProviderModelConfigForSave(
  model: ProviderRuntimeModelConfig,
): ProviderRuntimeModelConfig {
  const persisted = persistableProviderReportedModelHints({
    mode: model.mode,
    maxOutput: model.maxOutput,
  });
  return {
    id: model.id.trim(),
    name: model.name.trim(),
    ...(persisted.mode !== undefined ? { mode: persisted.mode } : {}),
    ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
    ...(persisted.maxOutput !== undefined ? { maxOutput: persisted.maxOutput } : {}),
    ...(model.modalities !== undefined
      ? {
          modalities: {
            input: [...model.modalities.input],
            output: [...model.modalities.output],
          },
        }
      : {}),
    ...(model.capabilities !== undefined
      ? { capabilities: { ...model.capabilities } }
      : {}),
    ...(model.defaultEnabled === false ? { defaultEnabled: false } : {}),
    ...(model.supportsImageInput === true ? { supportsImageInput: true } : {}),
    ...(model.reasoning === true && model.reasoningEfforts?.length
      ? { reasoning: true, reasoningEfforts: [...model.reasoningEfforts] }
      : {}),
  };
}

/**
 * 刷新时把接口发现结果合并进配置:新模型追加(默认隐藏),已存在模型保持成员资格不变。
 *
 * 厂商自报的分类/能力事实(mode / contextWindow / maxOutput / modalities / capabilities,来自 OpenRouter 等
 * /v1/models)会持久化进配置,离线/重启后仍在,并让「保存即 resolve」把它作为 providerReported
 * 上传——未命中知识库的第三方模型也能保留厂商自报的真实窗口与能力,而非在 resolve 时落保守默认。
 *
 * **关键**:不仅新模型,已存在模型也会更新。mode 没有手工编辑入口,最新有效上报覆盖旧值；
 * contextWindow/能力字段只在缺失时 gap-fill；maxOutput 取新旧较小值。否则老 provider 首次在新版刷新时,存量模型
 * 永远拿不到这些字段,重启后 boot 的 config-resolve 仍是稀疏输入 → 又落默认。
 *
 * `changed` 标记配置是否实际变化(新增 或 任一字段回填)。调用方据此决定是否落盘持久化:仅看
 * `addedIds` 会漏掉「无新增、仅回填」的刷新,导致回填不被保存。
 */
export function appendDiscoveredCustomProviderModels(
  existing: readonly ProviderRuntimeModelConfig[],
  discovered: readonly (Pick<ProviderRuntimeModelConfig, 'id' | 'name'> & {
    providerReported?: DiscoveredReportedInput;
  })[],
): { models: ProviderRuntimeModelConfig[]; addedIds: string[]; changed: boolean } {
  // 厂商这次上报的能力字段按 id 索引(首次出现胜出),供新增写入 + 存量回填共用。
  const reported = new Map<string, DiscoveredProviderReported>();
  for (const model of discovered) {
    if (!model.id || reported.has(model.id)) continue;
    const picked = persistableProviderReportedModelHints(model.providerReported);
    if (
      picked.mode !== undefined ||
      picked.contextWindow !== undefined ||
      picked.maxOutput !== undefined ||
      picked.modalities !== undefined ||
      picked.capabilities !== undefined
    ) {
      reported.set(model.id, picked);
    }
  }
  let changed = false;
  // 回填:除 maxOutput 按硬上限取较小值外，其余存量字段只补缺口。
  const models: ProviderRuntimeModelConfig[] = existing.map((model) => {
    const r = reported.get(model.id);
    if (!r) return model;
    let next = model;
    if (r.mode !== undefined && next.mode !== r.mode) {
      next = { ...next, mode: r.mode };
      changed = true;
    }
    if (next.contextWindow === undefined && r.contextWindow !== undefined) {
      next = { ...next, contextWindow: r.contextWindow };
      changed = true;
    }
    const maxOutput = conservativeMaxOutput(next.maxOutput, r.maxOutput);
    if (maxOutput !== undefined && maxOutput !== next.maxOutput) {
      next = { ...next, maxOutput };
      changed = true;
    }
    if (next.modalities === undefined && r.modalities !== undefined) {
      next = { ...next, modalities: r.modalities };
      changed = true;
    }
    if (next.capabilities === undefined && r.capabilities !== undefined) {
      next = { ...next, capabilities: r.capabilities };
      changed = true;
    }
    return next;
  });
  const known = new Set(existing.map((m) => m.id));
  const addedIds: string[] = [];
  for (const model of discovered) {
    if (!model.id || !model.name || known.has(model.id)) continue;
    const r = reported.get(model.id);
    models.push({
      id: model.id,
      name: model.name,
      defaultEnabled: false,
      ...(r?.mode !== undefined ? { mode: r.mode } : {}),
      ...(r?.contextWindow !== undefined ? { contextWindow: r.contextWindow } : {}),
      ...(r?.maxOutput !== undefined ? { maxOutput: r.maxOutput } : {}),
      ...(r?.modalities !== undefined ? { modalities: r.modalities } : {}),
      ...(r?.capabilities !== undefined ? { capabilities: r.capabilities } : {}),
    });
    known.add(model.id);
    addedIds.push(model.id);
    changed = true;
  }
  return { models, addedIds, changed };
}

/**
 * 把同一请求的 resolve 结果按 id 回填到 picker 行。调用方可先缓存早到的 push，再在
 * fetch IPC 返回并创建 picker 时调用，避免内存/磁盘 cache 命中导致 metadata 丢失。
 */
export function fillCustomProviderModelsMetadata(
  models: readonly ProviderRuntimeModelConfig[],
  resolved: readonly ({ id: string } & DiscoveredReportedInput)[] | undefined,
): ProviderRuntimeModelConfig[] {
  if (!resolved || resolved.length === 0) return [...models];
  const byId = new Map(resolved.map((model) => [model.id, model]));
  return models.map((model) => fillCustomProviderModelMetadata(model, byId.get(model.id)));
}

/**
 * Apply a model-picker selection to the latest form rows without losing hidden provider facts.
 * Picker-seen unchecked ids are removed; rows added after discovery stay intact. For selected ids,
 * edits made while the picker was open win over its snapshot, while newly resolved metadata fills
 * gaps. Nested capability values are cloned before entering form state.
 */
export function mergeCustomProviderPickerSelection(
  previousModels: readonly ProviderRuntimeModelConfig[],
  pickerModels: readonly ProviderRuntimeModelConfig[],
  selectedIds: ReadonlySet<string>,
): ProviderRuntimeModelConfig[] {
  const chosen = pickerModels.filter((model) => selectedIds.has(model.id));
  const pickerIds = new Set(pickerModels.map((model) => model.id));
  const latestById = new Map<string, ProviderRuntimeModelConfig>();
  for (const model of previousModels) {
    const id = model.id.trim();
    if (id && !latestById.has(id)) latestById.set(id, model);
  }

  const merged = chosen.map((model): ProviderRuntimeModelConfig => {
    const latest = latestById.get(model.id);
    const contextWindow = latest?.contextWindow ?? model.contextWindow;
    const maxOutput = conservativeMaxOutput(latest?.maxOutput, model.maxOutput);
    const defaultEnabled = latest?.defaultEnabled ?? model.defaultEnabled;
    const mode = latest?.mode ?? model.mode;
    const supportsImageInput = latest ? latest.supportsImageInput : model.supportsImageInput;
    const reasoning = latest ? latest.reasoning : model.reasoning;
    const reasoningEfforts = latest ? latest.reasoningEfforts : model.reasoningEfforts;
    const modalities = latest?.modalities ?? model.modalities;
    const capabilities = latest?.capabilities ?? model.capabilities;
    return {
      id: model.id,
      name: latest?.name.trim() ? latest.name.trim() : model.name,
      ...(mode !== undefined ? { mode } : {}),
      ...(contextWindow !== undefined ? { contextWindow } : {}),
      ...(maxOutput !== undefined ? { maxOutput } : {}),
      ...(modalities !== undefined
        ? { modalities: { input: [...modalities.input], output: [...modalities.output] } }
        : {}),
      ...(capabilities !== undefined ? { capabilities: { ...capabilities } } : {}),
      ...(defaultEnabled === false ? { defaultEnabled: false } : {}),
      ...(supportsImageInput === true ? { supportsImageInput: true } : {}),
      ...(reasoning === true && reasoningEfforts?.length
        ? { reasoning: true, reasoningEfforts: [...reasoningEfforts] }
        : {}),
    };
  });

  for (const model of previousModels) {
    const id = model.id.trim();
    if (!id || pickerIds.has(id) || merged.some((row) => row.id === id)) continue;
    merged.push({
      id,
      name: model.name.trim() || id,
      ...(model.mode !== undefined ? { mode: model.mode } : {}),
      ...(model.contextWindow !== undefined ? { contextWindow: model.contextWindow } : {}),
      ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
      ...(model.modalities !== undefined
        ? {
            modalities: {
              input: [...model.modalities.input],
              output: [...model.modalities.output],
            },
          }
        : {}),
      ...(model.capabilities !== undefined ? { capabilities: { ...model.capabilities } } : {}),
      ...(model.defaultEnabled === false ? { defaultEnabled: false } : {}),
      ...(model.supportsImageInput === true ? { supportsImageInput: true } : {}),
      ...(model.reasoning === true && model.reasoningEfforts?.length
        ? { reasoning: true, reasoningEfforts: [...model.reasoningEfforts] }
        : {}),
    });
  }
  return merged;
}

/**
 * 只把 resolve push 应用到创建它的 picker。单靠 agent 不足以隔离连续两次同 runtime 拉取：
 * 后一次请求的缓存命中 push 可能在新 picker 创建前到达，此时旧 picker 仍可能存在。
 */
export function fillMatchingCustomProviderPickerModels<
  T extends { requestId: string; agent: string; models: ProviderRuntimeModelConfig[] },
>(
  picker: T | null,
  requestId: string,
  agent: string,
  resolved: readonly ({ id: string } & DiscoveredReportedInput)[],
): T | null {
  if (!picker || picker.requestId !== requestId || picker.agent !== agent) return picker;
  return { ...picker, models: fillCustomProviderModelsMetadata(picker.models, resolved) };
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

// 鉴权请求头是 main-only 密文(isRendererAccessibleSafeStorageKey 明确拒 provider_headers_
// 前缀,与 API key 不同),renderer 不得回读明文。编辑时不再向 renderer 暴露头值:未在
// 表单显式改动请求头,update 由 main 侧保留旧值(planProviderHeaderMutations 'update' 分支)。

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

export interface CustomProviderModelRefreshResult {
  ok: boolean;
  added: number;
  changed: boolean;
}

/**
 * Refresh every configured runtime first, then resolve provider metadata once.
 *
 * Fetch remains per runtime because upstream endpoints and wire-specific headers can differ. The
 * Model Access enrichment step is provider-scoped: individual fetch IPC calls defer resolve, then
 * either the persisted config update triggers the existing save-resolve batch or an unchanged
 * config explicitly asks Main to resolve all saved entries in one request.
 */
export async function refreshCustomProviderModels(
  provider: ProviderView,
): Promise<CustomProviderModelRefreshResult> {
  const config = providerViewToCustomProviderConfig(provider);
  const authMethod =
    provider.auth.method === 'none'
      ? 'none'
      : provider.auth.method === 'oauth'
        ? 'oauth'
        : 'apiKey';
  const fetched = await Promise.all(provider.agents.map(async (agent) => {
    const runtime = config.runtimes[agent];
    if (!runtime?.baseUrl) return null;
    const apiKey = authMethod === 'apiKey'
      ? await readCustomProviderKey(provider.id, agent)
      : null;
    const result = await window.electronAPI.maker.fetchProviderModels({
      agent,
      baseUrl: runtime.baseUrl,
      authMethod,
      ...(runtime.wireProtocol ? { wireProtocol: runtime.wireProtocol } : {}),
      modelsUrl: runtime.modelsUrl ?? null,
      apiKey,
      // Main pins the request back to this saved route and injects main-only header credentials.
      savedProviderId: provider.id,
      // Resolve is intentionally delayed until all agent discovery results have completed.
      deferResolve: true,
    });
    return { agent, result };
  }));

  let added = 0;
  let changed = false;
  let anyOk = false;
  for (const item of fetched) {
    if (!item?.result.ok || !item.result.models) continue;
    const runtime = config.runtimes[item.agent];
    if (!runtime) continue;
    anyOk = true;
    const merged = appendDiscoveredCustomProviderModels(runtime.models, item.result.models);
    runtime.models = merged.models;
    added += merged.addedIds.length;
    if (merged.changed) changed = true;
  }
  if (!anyOk) return { ok: false, added: 0, changed: false };

  if (changed) {
    // The update handler refreshes active-catalog, then invokes the existing provider-level
    // save-resolve path once with all supported agent entries.
    await updateCustomProvider(config, {});
  } else {
    // No persistence mutation means UPDATE would not run, so explicitly execute that same batch.
    await window.electronAPI.maker.resolveSavedProviderModels(provider.id);
  }
  return { ok: true, added, changed };
}

/** 删除：main 在同一 provider mutation queue 内清配置与所有凭证。 */
export async function deleteCustomProvider(providerId: string): Promise<void> {
  await window.electronAPI.maker.deleteCustomProvider(providerId);
}
