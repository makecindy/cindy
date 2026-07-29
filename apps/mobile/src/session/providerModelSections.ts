/**
 * providerModelSections —— 手机版 provider-aware 模型下拉的派生逻辑(**纯逻辑,零 react-native**)。
 *
 * 复用 `@cindy/model-providers` 的 `buildProviderSections` / `connectedProvidersForAgent` /
 * `nativeDefaultSourceId`,保证手机和桌面、IM /model 三端「同一 agent 看到同样的供应商 × 模型」。
 * 可见性口径 = **被控端用户**的「设置 → 模型供应商」显示开关:PROVIDER_LIST 隧道把被控端的
 * override 快照(modelVisibilityOverrides,key `${agent}:${providerId}:${modelId}`)一并回传,
 * 这里用共享 isModelVisible(override ?? 目录 defaultEnabled)判定,与被控端本机列表逐模型一致。
 * 旧被控端不回传该字段 → 不过滤(目录是啥显示啥),优雅降级。注意这**不是**控制端手机自己的
 * 偏好——手机没有本机模型开关,列表始终跟随被控电脑上的设置。
 *
 * 数据源是**被控端**的 `ProviderView[]`(隧道 maker:provider:list,见 useDeviceProviders),
 * 故 0 供应商 / 旧被控端时调用方应回退到 capabilities 扁平列表。
 */
import {
  actualSourceIdForModel,
  chatEligibleSourcesForModel,
  connectedProvidersForAgent,
  effectiveSourceIdForModel,
  getModel,
  modelSupportsFastMode,
  nativeDefaultSourceId,
  type ProviderView,
} from '@cindy/model-providers/registry';
import {
  buildProviderSections,
  isModelVisible,
  type ProviderSection,
  type SectionModel,
} from '@cindy/model-providers/sections';
import {
  resolveEffort,
  resolveProviderSwitchEffort,
} from '@cindy/model-providers/effort-resolution';
import type { AgentKind } from '@cindy/model-providers/types';

import type { MobileModelMemoryAccessors } from './draftModelMemory';

/** 下拉里平铺渲染的一行:某供应商 offer 的某个模型。 */
export interface ProviderModelRow {
  provider: ProviderView;
  model: SectionModel;
}

export interface MobileModelSections {
  /** 按已连接供应商分段(catalog 顺序,无二次排序)。 */
  sections: ProviderSection[];
  /** 该 agent 已连接的供应商(来源栏)。 */
  connected: ProviderView[];
  /**
   * 当前高亮的来源 id(按当前模型收窄,桌面 effectiveSourceIdForModel 同口径):
   * 显式选中且已连接且提供当前模型 → 用它;否则在提供该模型的已连接来源里取原生默认;
   * 没有任何已连接来源提供该模型 → null(药丸无来源图标、列表无 ✓)。
   */
  activeSourceId: string | null;
}

/**
 * 由被控端供应商目录派生「按供应商分段」的模型列表 + 当前来源高亮。
 * 可见性按被控端 override + 目录 defaultEnabled 判定(见文件头);当前选中行即使被隐藏也保留
 * (buildProviderSections 内建豁免,与桌面一致)。
 */
export function buildMobileModelSections(args: {
  providers: readonly ProviderView[];
  agentKind: AgentKind;
  selectedModelId?: string;
  selectedProviderId?: string | null;
  query?: string;
  /** 被控端「模型显示/隐藏」override 快照;undefined/null = 旧被控端,不过滤。 */
  visibilityOverrides?: Record<string, boolean> | null;
  /**
   * true = 已建会话的选择器:当前来源按**实际路由口径**解析(不剔除停用拷贝,
   * 运行中会话跟真实扣费路由),并给被停用的当前来源保留选中行。缺省 false =
   * 新建草稿等**新路由选择**:按准入口径(effectiveSourceIdForModel)解析,停用
   * 拷贝不高亮也不可选(PR #744 review 第十二轮)。
   */
  existingSessionRoute?: boolean;
}): MobileModelSections {
  const connected = connectedProvidersForAgent([...args.providers], args.agentKind);

  // 生效来源必须按当前模型收窄(与桌面 0f75dd560 修复同口径):显式选中的来源要
  // 「已连接且**确实提供当前模型**」才用它;否则在提供该模型的已连接来源里取原生默认;
  // 一个都没有 → null(绝不拼出「来源 A 图标 + 只有来源 B 提供的模型」的不存在路由,
  // 也不再让断开/不提供该模型的显式来源粘在药丸上)。未传 selectedModelId(无从收窄)
  // 时保持旧口径:显式已连接来源 → agent 原生默认。
  // 口径 = **实际路由**(actualSourceIdForModel,不剔除停用拷贝,桌面同款):本函数
  // 服务的是已建会话的选择器,运行中会话继续走它真正在用的来源,高亮/药丸必须跟
  // 真实扣费路由,不能显示成准入过滤后的替代来源(PR #744 review 第十轮)。
  const resolveSourceId = args.existingSessionRoute
    ? actualSourceIdForModel
    : effectiveSourceIdForModel;
  const activeSourceId = args.selectedModelId
    ? resolveSourceId(
        [...args.providers],
        args.selectedProviderId ?? null,
        args.selectedModelId,
        args.agentKind,
      )
    : args.selectedProviderId && connected.some((p) => p.id === args.selectedProviderId)
      ? args.selectedProviderId
      : nativeDefaultSourceId(connected, args.agentKind);

  // 当前来源被供应商级停用(仍连接着,但 connected 剔除了它)时补进分段输入,
  // 并只保留选中行 —— 选中行豁免生效,其它模型不可作为新路由选择(桌面同款)。
  const suspendedActive =
    args.existingSessionRoute && activeSourceId && !connected.some((p) => p.id === activeSourceId)
      ? args.providers.find(
          (p) =>
            p.id === activeSourceId && p.connected && p.agents.includes(args.agentKind),
        )
      : undefined;
  const sectionProviders = suspendedActive ? [...connected, suspendedActive] : connected;
  const restrictSuspended = (pid: string, mid: string): boolean =>
    !(suspendedActive && pid === suspendedActive.id && mid !== args.selectedModelId);

  const overrides = args.visibilityOverrides;
  const sections = buildProviderSections({
    providers: sectionProviders,
    agent: args.agentKind,
    selectedModelId: args.selectedModelId,
    // 「选中行即使被隐藏也保留」的豁免必须指向真正会打 ✓ 的那行 —— 用解析后的
    // activeSourceId(桌面同口径),而不是可能失效的原始 selectedProviderId。
    selectedProviderId: activeSourceId,
    // key 形如 `${agent}:${providerId}:${modelId}`,与桌面 modelVisibilityPrefs.keyOf /
    // main model-visibility-mirror.keyOf 一致(三处需保持同步)。
    isVisible: overrides
      ? (pid, mid) => {
          if (!restrictSuspended(pid, mid)) return false;
          const p = sectionProviders.find((x) => x.id === pid);
          const cat = p ? getModel(p, mid, args.agentKind) : undefined;
          return isModelVisible(overrides[`${args.agentKind}:${pid}:${mid}`], cat?.defaultEnabled);
        }
      : (pid, mid) => restrictSuspended(pid, mid),
    query: args.query,
  });

  return { sections, connected, activeSourceId };
}

/** 供应商首字母 monogram(同桌面 providerMonogram:取 name 首字符大写)。 */
export function providerMonogram(name: string): string {
  const ch = Array.from(name.trim())[0] ?? '?';
  return ch.toUpperCase();
}

/** 把分段平铺成行列表(同供应商行因 builder 顺序天然相邻)。 */
export function flattenProviderSections(sections: readonly ProviderSection[]): ProviderModelRow[] {
  return sections.flatMap((section) =>
    section.models.map((model) => ({ provider: section.provider, model })),
  );
}

/**
 * Whether a persisted explicit source is known to be disconnected for the selected model.
 * Loading and fetch errors are unknown states, so they fail open instead of showing a false error.
 */
export function isSelectedSourceDisconnected(args: {
  providers: readonly ProviderView[];
  providerId: string | null | undefined;
  modelId: string;
  agentKind: AgentKind;
  loading: boolean;
  error: string | null;
}): boolean {
  if (!args.providerId || args.loading || args.error !== null) return false;
  // chatEligibleSourcesForModel + includeDisabled(issue #882 第 3 点 与 PR #744
  // 停用轴合流,2026-07 review):与桌面 sourceSwitch.ts 的 isSelectedSourceDisconnected
  // 同一份口径——选中来源若还在但这个 id 在它上面已经不是聊天模型了,也要判"断连",
  // 不能只看 id 是否存在;但停用(disabled/suspended)是**另一根准入轴**,不打断已建
  // 会话 —— 按准入 rail 判会把停用当断开误报错误态(桌面同款),故传 includeDisabled。
  return !chatEligibleSourcesForModel([...args.providers], args.modelId, args.agentKind, {
    includeDisabled: true,
  }).some((provider) => provider.id === args.providerId);
}

/**
 * 选中某模型后把 effort reconcile 到合法档:当前 effort 仍受支持则保留,否则取该模型默认
 * effort(若在支持集内),再兜底首个支持档,最后空串(模型不支持 effort)。
 * 口径同 maker-shared `reconcileRuntimeDraftWithCapabilities`。仅供 flat 回退路径
 * (旧被控端无供应商结构、无记忆可用)消费;分段路径走 resolveRowSelection。
 */
export function reconcileEffortForModel(model: SectionModel, currentEffort: string): string {
  const efforts = model.efforts as readonly string[];
  if (efforts.length === 0) return '';
  if (efforts.includes(currentEffort)) return currentEffort;
  if (model.defaultEffort && efforts.includes(model.defaultEffort)) return model.defaultEffort;
  return efforts[0] ?? '';
}

/** resolveRowSelection 的落点:选行后应生效的 model + 来源 + effort + fast 四件套。 */
export interface RowSelectionResult {
  model: string;
  providerId: string;
  effort: string;
  fastMode: boolean;
}

/**
 * 点选某 (供应商, 模型) 行后解析落点 —— 纯函数,effort 优先级与桌面 ChatInput 完全同源
 * (共享包 resolveEffort / resolveProviderSwitchEffort):
 *   - **同模型只切来源**:严格 per-(供应商, 模型),有该来源记忆则恢复,否则模型默认,
 *     绝不沿用当前档(防跨来源串档,桌面实测 bug 的修复口径);
 *   - **换模型**:精确记忆 → 沿用当前档(仍受支持时)→ 模型默认。
 *     手机差异注记:桌面第 3 档 provider-agnostic per-model 记忆手机没有,恒 miss(不传)。
 *   - **fast**:fastEditable(agent hasFastMode × 该 (供应商, 模型) supportsFastMode)门控,
 *     恢复该行记忆,缺省 false。
 */
export function resolveRowSelection(args: {
  row: ProviderModelRow;
  agentKind: AgentKind;
  currentModelId: string;
  currentProviderId: string | null;
  currentEffort: string;
  hasFastModeCap: boolean;
  memory?: MobileModelMemoryAccessors;
}): RowSelectionResult {
  const { row, agentKind, memory } = args;
  const efforts = row.model.efforts;
  const defaultEffort = row.model.defaultEffort;
  const providerEffort = memory?.getEffort(agentKind, row.provider.id, row.model.id);

  const sameModelSourceSwitch =
    row.model.id === args.currentModelId &&
    args.currentProviderId !== null &&
    row.provider.id !== args.currentProviderId;

  // 手机语义:模型无 effort 档 → 空串(创建/切换时省略该字段),不是桌面的 'low' 占位。
  const effort = efforts.length === 0
    ? ''
    : sameModelSourceSwitch
    ? resolveProviderSwitchEffort({
        efforts,
        defaultEffort,
        providerEffort,
        fallbackEffort: args.currentEffort,
      })
    : resolveEffort({
        efforts,
        defaultEffort,
        activeEffort: args.currentEffort,
        providerEffort,
      });

  const fastEditable =
    args.hasFastModeCap && modelSupportsFastMode(row.provider, row.model.id, agentKind);
  const fastMode = fastEditable
    ? memory?.getFast(agentKind, row.provider.id, row.model.id) ?? false
    : false;

  return { model: row.model.id, providerId: row.provider.id, effort, fastMode };
}
