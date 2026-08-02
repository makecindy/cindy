/**
 * providerModels —— 从 live `useProviders()` 派生某 agent 的模型清单（renderer 侧）。
 *
 * 这是 main 的 `maker-host/catalog-to-descriptors.ts:deriveAvailableModels` 的 **renderer live 版**：
 * 模型清单 SSoT 是 provider catalog；picker 改为直接从 `useProviders()`（实时读 active-catalog）
 * 派生，而非读 agent 构造时冻结的 `capabilities.availableModels`。这样：
 *   - 内置部分与冻结快照**逐字节相同**（同一 active-catalog 源、同 provider 序、同 first-wins 去重）→ no-break；
 *   - 自定义供应商的模型自动并入、增删改即时反映（PROVIDER_CHANGED 广播 → useProviders refetch），无需重启。
 *
 * 顺序契约：按 `providers` 数组序（= catalog 序：anthropic → openai → xd → 自定义…）flatMap
 * 各 provider 的 `models[agent]`，按 id 首见胜出去重。
 */

import {
  isAgentSelectableModel,
  isModelVisible,
  providerOffersModel,
  providersForAgent,
  sessionModelSupportsFastMode,
  type AgentKind,
  type CatalogModel,
  type ProviderView,
} from '@cindy/model-providers';

// 用 renderer 自己的 ModelDescriptor（Effort=string，宽松）—— 与 capabilities.availableModels
// 同型，picker 现有代码（effortDisplayNames 按 string 索引等）零改动即可消费。
import type { AgentCapabilities, ModelDescriptor } from '@/hooks/useAgentCapabilities';
import { isSubscriptionDirectModel } from '../../shared/subscriptionModels';

/** CatalogModel → renderer ModelDescriptor（name→displayName；group/sortOrder 不在 renderer 型里——
 *  picker 的分组走 categorize(id 前缀)，与既有内置模型一致）。 */
function toDescriptor(m: CatalogModel): ModelDescriptor {
  const d: ModelDescriptor = {
    id: m.id,
    displayName: m.name,
    contextWindow: m.contextWindow,
    efforts: m.efforts,
    defaultEffort: m.defaultEffort,
  };
  if (m.description !== undefined) d.description = m.description;
  if (m.effortDisplayNames !== undefined) d.effortDisplayNames = m.effortDisplayNames;
  if (m.supportsFastMode !== undefined) d.supportsFastMode = m.supportsFastMode;
  if (m.mode !== undefined) d.mode = m.mode;
  return d;
}

/**
 * Fast 可用判定的**唯一渲染层入口** —— 本地会话与 device-link 远程会话统一走同一套共享纯逻辑
 * （`sessionModelSupportsFastMode`，per-(provider, model) 唯一真相），**控制端不另写远程判断逻辑**。
 *
 * 数据源选择遵守 device-link「以被控端为准」契约:
 *   - device-link 远程会话（deviceId 非空）→ 用被控端经隧道(`maker:provider:list`)带来的 `deviceProviders`；
 *   - 本机会话 → 用本地 `localProviders`。
 *
 * **旧被控端回退（no-break 硬约束）**:旧版被控端不支持 `maker:provider:list` ⇒ `deviceProviders` 为空,
 * 此时回退到拍平的 `capabilities.availableModels[].supportsFastMode`（与本次改造前 device-link 行为逐字节一致）,
 * 否则 fast 开关会被误隐藏。注:device providers 加载首帧也可能为空 → 暂走拍平回退;现内置目录无 per-provider
 * 分叉，拍平==per-provider，无可见跳变。
 *
 * 本函数**已包含 agent 级 `hasFastMode` 粗粒度 gate**，调用点不要再叠一次。
 */
export function resolveFastSupported(params: {
  deviceId: string | undefined;
  deviceProviders: ProviderView[];
  localProviders: ProviderView[];
  capabilities: AgentCapabilities | null;
  providerId: string | null | undefined;
  modelId: string;
  agentKind: AgentKind | null;
}): boolean {
  const { deviceId, deviceProviders, localProviders, capabilities, providerId, modelId, agentKind } =
    params;
  if (!agentKind) return false;
  // agent 级粗粒度 gate（agent 运行时是否实现 fast 管道）。
  if (!capabilities?.hasFastMode) return false;

  const effectiveProviders = deviceId ? deviceProviders : localProviders;

  // 旧被控端（或 device providers 加载首帧）→ 无 per-provider 数据 → 回退拍平 caps。
  if (deviceId && effectiveProviders.length === 0) {
    return !!capabilities.availableModels.find((m) => m.id === modelId)?.supportsFastMode;
  }

  // 本地 + 现代被控端:统一走共享 per-provider 纯函数（含生效来源解析）。
  return sessionModelSupportsFastMode(effectiveProviders, providerId ?? null, modelId, agentKind);
}

/**
 * 自定义供应商头像首字母（显示名首个字符大写；Array.from 正确处理 emoji / 代理对，空名兜底 `?`）。
 * 设置→供应商列表与对话模型选择器 trigger 共用，保证两处自定义 logo 一致。
 */
export function providerMonogram(name: string): string {
  const ch = Array.from(name.trim())[0] ?? '?';
  return ch.toUpperCase();
}

/**
 * 被控端模型可见性判定。override 缺失表示旧被控端，保持历史 fail-open；
 * 现代被控端则复用共享的「显式 override 优先，否则目录默认值」口径。
 */
export function isDeviceModelVisible(
  overrides: Record<string, boolean> | undefined,
  agent: AgentKind,
  providerId: string,
  model: Pick<CatalogModel, 'id' | 'defaultEnabled'>,
): boolean {
  if (overrides === undefined) return true;
  return isModelVisible(
    overrides[`${agent}:${providerId}:${model.id}`],
    model.defaultEnabled,
  );
}

/** Whether a provider relies on the local Responses-to-Chat handler for Codex. */
export function isChatBridgedCodexProvider(provider: ProviderView): boolean {
  return provider.routing?.codex?.wireProtocol === 'openai-chat';
}

export function filterChatBridgedCodexProviders(
  providers: ProviderView[],
  agent: AgentKind,
  exclude: boolean,
): ProviderView[] {
  return exclude && agent === 'codex'
    ? providers.filter((provider) => !isChatBridgedCodexProvider(provider))
    : providers;
}

/**
 * 派生某 agent 的可见模型清单：跨 provider union（数组序）+ 按 id 首见去重。
 *
 * `excludeProvider` 命中的供应商整条跳过（其模型不加入、也不占 seen），这样若同一
 * model id 另有可路由的供应商提供，仍能由后者补上——用于 SSH 远程排除仅本地可桥接的来源。
 *
 * `admissionFiltered` = 剔除停用轴不可路由的条目(suspended 供应商 / model.disabled /
 * 非 agent 分组的能力模型)。**只给「用户从零挑一个模型」的清单**用(IM 默认设置下拉、
 * SSH 候选,PR #744 review);按 id 找**当前会话已选模型**的元数据查询(ChatInput 的
 * effort 表、selectVisibleModels 的 currentModel)不要开 —— 运行中的会话可以正用着
 * 停用模型,过滤会把它的档位/显示信息一并弄丢。
 */
export function deriveModelsFromProviders(
  providers: ProviderView[],
  agent: AgentKind,
  opts?: {
    excludeProvider?: (provider: ProviderView) => boolean;
    admissionFiltered?: boolean;
  },
): ModelDescriptor[] {
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const provider of providersForAgent(providers, agent)) {
    if (opts?.excludeProvider?.(provider)) continue;
    if (opts?.admissionFiltered && provider.suspended) continue;
    for (const m of provider.models[agent] ?? []) {
      if (
        opts?.admissionFiltered &&
        (m.disabled === true ||
          // 非聊天模型同样不进 picker(issue #882 第 3 点):isAgentSelectableModel 现在
          // 内部就是 isChatEligible(+ userProvider 例外),与 main 侧
          // catalog-to-descriptors.ts deriveAvailableModels 用的同一份权威判定
          // 保持一致——但只在 admissionFiltered 时生效,不能无条件开(见上方函数
          // 文档:current-model 元数据查询不能被这个轴过滤掉)。
          !isAgentSelectableModel(m, { userProvider: provider.source === 'user' }))
      ) {
        continue;
      }
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      out.push(toDescriptor(m));
    }
  }
  return out;
}

/**
 * picker 模型清单来源选择 —— device-link「以被控端为准」契约的 SSoT。
 *
 *  - **device-link 远程会话(deviceId 非空)**:列**被控端**模型 —— 用 deviceId 作用域的
 *    `capabilities.availableModels`(隧道 `maker:get-capabilities` 拉到的被控端目录),
 *    **绝不读控制端本地 provider catalog**。否则控制端的自定义供应商 / 版本差异会让 picker
 *    列出被控端跑不了的模型(或漏掉被控端独有模型),且选中后 create / effort / fast 解析
 *    (按被控端能力 `getModelById(id, deviceId)`)与列表对不上 —— 见 useAgentCapabilities
 *    的「以被控端为准」契约。model-providers 重构曾把列表来源改成本地派生,无意中破坏了它。
 *  - **本机会话(deviceId === undefined)**:从 live `providers` 派生(provider-first,
 *    含自定义供应商),与重构后的本地行为逐字节一致。
 *
 * `agentKind` 锁定时取单边;为 null 时 cc + codex 按 id 首见去重并集(与历史合并口径一致)。
 * device 侧两个数组由调用方传 `cc/codex.capabilities.availableModels ?? []`(可空 → 空数组)。
 */
export function selectVisibleModels(params: {
  agentKind: AgentKind | null;
  deviceId: string | undefined;
  providers: ProviderView[];
  deviceCcModels: ModelDescriptor[];
  deviceCodexModels: ModelDescriptor[];
  devicePiModels?: ModelDescriptor[];
  /**
   * SSH 远程会话(remoteHostId)传 true:订阅直连模型(chatgpt/ / xai/)不再被过滤,
   * 而是保留在清单中由调用方按 isSubscriptionDirectModel 标记禁用(置灰 + 原因提示)。
   * 远端 cc 不经本地 compat-proxy 的 responses-bridge,选了必失败;静默消失会让用户
   * 误以为订阅掉了。device-link 远程不受影响(被控端跑完整 app,其本地 proxy 上
   * bridge 可用,模型清单本就来自被控端)。
   */
  excludeSubscriptionDirect?: boolean;
  /**
   * 过滤 `wireProtocol: 'openai-chat'` 的 Codex 供应商(DeepSeek / Kimi / GLM 等):它们的
   * Responses→Chat 翻译只挂在本地 codex-proxy 的 localHandler 上。SSH 远程会话(remoteHostId)
   * 必须传 true:远程走 daemon transport、不经本地 proxy,未经桥接的 Chat-only 模型送到远端必失败。
   * 与 excludeSubscriptionDirect 同由 `!!remoteHostId` 驱动;device-link 远程不受影响(被控端跑完整 app)。
   */
  excludeChatBridgedCodex?: boolean;
}): ModelDescriptor[] {
  const {
    agentKind,
    deviceId,
    providers,
    deviceCcModels,
    deviceCodexModels,
    devicePiModels = [],
    excludeSubscriptionDirect,
    excludeChatBridgedCodex,
  } = params;
  // excludeSubscriptionDirect 不再过滤(见参数文档):行保留,准入由调用方按
  // isSubscriptionDirectModel 打 disabled。保留参数是为了不破坏既有调用签名。
  const pass = (list: ModelDescriptor[]): ModelDescriptor[] => list;
  const codexDeriveOpts = excludeChatBridgedCodex
    ? { excludeProvider: isChatBridgedCodexProvider }
    : undefined;
  const cc = pass(deviceId ? deviceCcModels : deriveModelsFromProviders(providers, 'claude-code'));
  const codex = pass(deviceId ? deviceCodexModels : deriveModelsFromProviders(providers, 'codex', codexDeriveOpts));
  const pi = pass(deviceId ? devicePiModels : deriveModelsFromProviders(providers, 'pi'));
  if (agentKind === 'claude-code') return cc;
  if (agentKind === 'codex') return codex;
  if (agentKind === 'pi') return pi;
  const merged = [...cc];
  const seen = new Set(merged.map((m) => m.id));
  for (const list of [codex, pi]) {
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      merged.push(m);
    }
  }
  return merged;
}

/**
 * Resolve one row's agent using the same first-wins order as `selectVisibleModels`.
 * This is deliberately row-scoped: a merged picker must not classify every row from the currently
 * selected model's agent when deciding whether the controlled device can route that row.
 */
export function resolveVisibleModelAgentKind(params: {
  modelId: string;
  agentKind: AgentKind | null;
  ccModels: ModelDescriptor[];
  codexModels: ModelDescriptor[];
  piModels?: ModelDescriptor[];
  providers: ProviderView[];
}): AgentKind | null {
  const { modelId, agentKind, ccModels, codexModels, piModels = [], providers } = params;
  if (agentKind) return agentKind;
  if (ccModels.some((model) => model.id === modelId)) return 'claude-code';
  if (codexModels.some((model) => model.id === modelId)) return 'codex';
  if (piModels.some((model) => model.id === modelId)) return 'pi';
  if (providers.some((provider) => providerOffersModel(provider, modelId, 'claude-code'))) {
    return 'claude-code';
  }
  if (providers.some((provider) => providerOffersModel(provider, modelId, 'codex'))) {
    return 'codex';
  }
  if (providers.some((provider) => providerOffersModel(provider, modelId, 'pi'))) {
    return 'pi';
  }
  return null;
}
