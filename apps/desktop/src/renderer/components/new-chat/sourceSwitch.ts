/**
 * sourceSwitch —— 模型「厂商分类」与「切来源目标解析」的纯逻辑层。
 *
 * 从 ModelSelector.tsx 抽出,目的有二:
 *   1. 解耦:categorize / CATEGORY_ORDER 同时被 ModelSelector(分组展示)和 ChatInput
 *      (跨厂商切换确认弹窗)复用,避免两处 startsWith 规则发散。
 *   2. 可测:resolveSourceSwitch 是切来源时「该落到哪个 model / effort」的决策核心,
 *      抽成不依赖 React / UI 的纯函数,可在 node 环境直接单测。
 */

import type { Effort } from '@/lib/userPreferences.types';
import type { ProviderModelChoice } from '@/state/providerModelMemory';
import {
  CATEGORY_ORDER,
  CHAT_VENDOR_CATEGORY_ORDER,
  categorize,
  chatEligibleSourcesForModel,
  classifyModel,
  connectedProvidersForAgent,
  getModel,
  groupModelsForDisplay,
  groupOf,
  isModelSelectableForNewRoute,
  isChatEligible,
  type AgentKind,
  type DisplayModel,
  type ModelCategory,
  type ProviderView,
} from '@cindy/model-providers';

/**
 * 厂商分类 / 分组展示 / chat 准入判定的单点权威实现已收口到共享包
 * `@cindy/model-providers`(issue #882:mode 优先分类,id 正则只作兜底)。
 * 这里 re-export 保持 renderer 既有 import 路径(ModelSelector / ChatInput 等)不变,
 * 不再维护第二份 categorize/groupOf 拷贝——两份拷贝曾经各自修 bug、互相漂移。
 */
export {
  CATEGORY_ORDER,
  categorize,
  classifyModel,
  groupModelsForDisplay,
  groupOf,
  isChatEligible,
  type DisplayModel,
  type ModelCategory,
};

/**
 * 厂商分组小标题的 i18n key 表(规则 18)。多处复用:ModelSelector 右栏分组标题、
 * ChatInput 跨厂商确认弹窗、设置 → 模型供应商 展开列表的分组标题。集中放这里(纯逻辑层)
 * 避免各处硬编码英文常量或各自重复定义。
 */
export const CATEGORY_LABEL_KEY: Record<ModelCategory, string> = {
  anthropic: 'newChat.modelSelector.category.anthropic',
  gpt: 'newChat.modelSelector.category.gpt',
  'gpt-budget': 'newChat.modelSelector.category.budget',
  grok: 'newChat.modelSelector.category.grok',
  google: 'newChat.modelSelector.category.google',
  china: 'newChat.modelSelector.category.china',
  // `ungrouped` = 认不出厂商的对话模型(「未分组」);`other` = 不能对话的其它端点
  // (「其它端点」)。两者标签必须区分得开:前者可选、默认展开,后者是能力组、默认收起。
  ungrouped: 'newChat.modelSelector.category.ungrouped',
  image: 'newChat.modelSelector.category.image',
  video: 'newChat.modelSelector.category.video',
  tts: 'newChat.modelSelector.category.tts',
  stt: 'newChat.modelSelector.category.stt',
  realtime: 'newChat.modelSelector.category.realtime',
  embedding: 'newChat.modelSelector.category.embedding',
  compression: 'newChat.modelSelector.category.compression',
  other: 'newChat.modelSelector.category.other',
};

/**
 * resolveSourceSwitch 的最小模型形状:id + 该模型支持的 effort 档,外加可选的
 * `group`/`mode`——reconcile 候选过滤要靠 classifyModel 做 mode 优先判定
 * (issue #882 review:只传 id 时 mode 信号会丢,可能把非聊天模型选成 reconcile
 * 目标,见下方 resolveSourceSwitch 用法),不传时行为与历史一致(回退 id 正则)。
 */
export interface SwitchModel {
  id: string;
  efforts: readonly Effort[];
  group?: string;
  mode?: string;
}

/**
 * 切来源时决定「目标模型 + 目标 effort」—— 纯函数。优先级:
 *   1. 该来源上次记下的 model(remembered)仍被该来源 offer、当前 agent 可见、且未被用户
 *      在设置里隐藏 → 恢复它;若该模型仍支持 remembered.effort,一并带回恢复。
 *   2. 否则,当前模型不被新来源 offer → reconcile 到该来源下(按厂商 CATEGORY_ORDER)
 *      第一个可用**且未隐藏**的模型(无 effort 记忆,交给调用方按模型默认 reconcile)。
 *   3. 当前模型仍被 offer 且无可用记忆 → 不动模型(reconciledModelId 为空)。
 *
 * `isVisible`(可选):某 model 在该来源 / agent 下是否对用户可见(设置 → 模型供应商 的开关,
 * 见 modelVisibilityPrefs)。缺省全可见 —— 不传则行为与历史一致。切来源时绝不自动落到一个
 * 被用户隐藏的模型上(隐藏即「不想用」);但**当前已选模型**即便被隐藏仍由 ModelSelector 单独
 * 保底显示,不归本函数管(本函数只决定「要不要换、换到哪」)。
 *
 * 返回的 reconciledModelId 仅在「模型确实变化」时给出(等于当前模型视为不变,返 undefined);
 * reconciledEffort 仅在能从记忆恢复时给出。两者都为空 = 调用方保持当前 model/effort。
 */
/**
 * 目标 provider 上**这个具体条目**是否是聊天模型(issue #882 第 3 点,2026-07
 * review)。resolveSourceSwitch 决定的是"切到 provider 之后用哪个 model",必须验
 * provider 自己的那份数据——`visibleModels`(跨 provider 的并集)里的同 id 条目可能
 * 来自另一个 provider 的聊天分类,和目标 provider 自己的这份 mode 可能不一致;
 * providerOffersModel 同理只看 id 是否存在,不看 mode。两者都不能替代这个检查。
 */
function isModelChatEligibleOnProvider(
  provider: ProviderView,
  modelId: string,
  agent: AgentKind,
): boolean {
  const model = getModel(provider, modelId, agent);
  // provider-aware 谓词:用户自定义供应商显式配置的模型带未知 group,id 撞上能力
  // 启发式时不能被误杀(2026-07 review 第 25 轮)。
  return (
    model !== undefined &&
    isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })
  );
}

export function resolveSourceSwitch(args: {
  provider: ProviderView;
  agent: AgentKind;
  currentModelId: string | undefined;
  visibleModels: readonly SwitchModel[];
  remembered: ProviderModelChoice | undefined;
  isVisible?: (modelId: string) => boolean;
}): { reconciledModelId?: string; reconciledEffort?: Effort } {
  const { provider, agent, currentModelId, visibleModels, remembered } = args;
  const isVisible = args.isVisible ?? (() => true);
  let targetModel: string | undefined;
  let targetEffort: Effort | undefined;

  const memUsable =
    !!remembered &&
    isModelChatEligibleOnProvider(provider, remembered.model, agent) &&
    visibleModels.some((m) => m.id === remembered.model) &&
    isVisible(remembered.model);

  if (memUsable && remembered) {
    targetModel = remembered.model;
    const tm = visibleModels.find((m) => m.id === remembered.model);
    if (tm && tm.efforts.includes(remembered.effort)) targetEffort = remembered.effort;
  } else if (
    currentModelId &&
    !isModelChatEligibleOnProvider(provider, currentModelId, agent)
  ) {
    // 只在聊天厂商组里找候选(issue #882):非聊天类型(image/video/tts/stt/realtime/
    // embedding/compression/other)不该被 reconcile 选中。用 classifyModel(mode 优先,
    // 无 mode 才回退 id 正则)而不是纯 id 正则的 categorize——否则 mode 标为非聊天、
    // 但 id 落进 categorize 兜底组(ungrouped)的模型会绕过准入被选中(2026-07 review)。
    const ordered = CHAT_VENDOR_CATEGORY_ORDER.flatMap((c) =>
      visibleModels.filter((m) => classifyModel(m) === c),
    );
    targetModel = ordered.find(
      (m) => isModelChatEligibleOnProvider(provider, m.id, agent) && isVisible(m.id),
    )?.id;
  }

  const reconciledModelId =
    targetModel && targetModel !== currentModelId ? targetModel : undefined;
  return { reconciledModelId, reconciledEffort: targetEffort };
}

// resolveEffort / resolveProviderSwitchEffort(切模型 / 同模型切来源的落档优先级)已下沉到共享包
// `@cindy/model-providers`(手机版模型选择列表要用同一套口径)。这里 re-export 保持 renderer
// 既有 import 路径不变,语义与历史版本逐字一致。
export { resolveEffort, resolveProviderSwitchEffort } from '@cindy/model-providers';

/**
 * 「显式选中的来源已断开」判定 —— 纯函数。会话把来源(providerId)持久化在 DB 里,
 * 该来源的凭证之后可能被外部清除(如系统 Claude CLI 登出删掉订阅 OAuth);此时 trigger
 * 若静默回退显示默认来源图标,用户看到的来源与发送实际使用的来源就分叉了(实测事故:
 * 界面显示 XD 网关、发送却按 DB 里的 anthropic 报 no_oauth)。此函数给显示与发送门禁
 * 提供同一份「选中来源是否还连着」的判定。
 *
 * 只判「selectedProviderId 不在该 `(agent, model)` 的已连接来源内」;providersLoading 期间恒 false
 * (providers 首帧未就绪,避免闪断开态)。sessionId(排除草稿)/ deviceLinkDeviceId
 * (排除远程会话,其连接态在被控端)的 scoping 由调用方叠加。
 */
export function isSelectedSourceDisconnected(args: {
  providers: ProviderView[];
  agent: AgentKind | null;
  modelId: string;
  selectedProviderId: string | null | undefined;
  providersLoading: boolean;
}): boolean {
  const { providers, agent, modelId, selectedProviderId, providersLoading } = args;
  if (providersLoading || !agent || !selectedProviderId) return false;
  // chatEligibleSourcesForModel + includeDisabled:选中来源若还在但这个 id 在它上面
  // 已经不是聊天模型了(mode 变化),也要判"断连"——否则这里说"没断连"、
  // effectiveSourceIdForModel 却解析不出可用来源,界面显示能发、实际发不出去
  // (2026-07 review:UI 可用性判断与路由解析必须同一份口径)。但停用(suspended /
  // 该拷贝 disabled)是**另一根**准入轴,不打断运行中的会话 —— 按准入过滤后的
  // rail 判会把停用当断开,Send 被误禁(PR #744 review 第十轮),故传
  // includeDisabled。
  const sources = chatEligibleSourcesForModel(providers, modelId, agent, {
    includeDisabled: true,
  });
  return !sources.some((p) => p.id === selectedProviderId);
}

// 「按供应商分段」的列表派生 + 类型已下沉到共享包 `@cindy/model-providers`(让 main 侧 IM /model
// 复用同一份逻辑,两端模型列表口径一致)。这里 re-export 保持 renderer 既有 import 路径不变。
export { buildProviderSections } from '@cindy/model-providers';
export type { SectionModel, ProviderSection } from '@cindy/model-providers';
