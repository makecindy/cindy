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
  connectedProvidersForAgent,
  providerOffersModel,
  sourcesForModel,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';
import { CHATGPT_MODEL_PREFIX, XAI_MODEL_PREFIX } from '../../../shared/subscriptionModels';

// 仅用于二级菜单分组展示, 不参与持久化或 onModelChange 数据流。
// 对话厂商组(anthropic..china)在前;非对话类型组(image/audio/video/embedding/other)在后——
// 后者收纳网关多出的图像 / 语音 / 视频 / 向量等模型(它们默认关、不能当 agent 用,仅分类展示)。
export type ModelCategory =
  | 'anthropic'
  | 'gpt'
  | 'gpt-budget'
  | 'grok'
  | 'google'
  | 'china'
  | 'image'
  | 'audio'
  | 'video'
  | 'embedding'
  | 'other';

export const CATEGORY_ORDER: ModelCategory[] = [
  'anthropic',
  'gpt-budget',
  'gpt',
  'grok',
  'google',
  'china',
  'image',
  'audio',
  'video',
  'embedding',
  'other',
];

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
  image: 'newChat.modelSelector.category.image',
  audio: 'newChat.modelSelector.category.audio',
  video: 'newChat.modelSelector.category.video',
  embedding: 'newChat.modelSelector.category.embedding',
  other: 'newChat.modelSelector.category.other',
};

// 按 model.id 前缀粗分类: claude-* → Anthropic, gpt-* → GPT, codex/* → 折扣GPT (gateway 低价路由),
// gemini-* → Google, 其余 (moonshotai/qwen/glm/...) 一律落到 China。新增国产模型不需要改这里。
export function categorize(id: string): ModelCategory {
  if (id.startsWith('claude-')) return 'anthropic';
  // 非对话类型(向量/图像/音频语音/视频)必须在通用 gpt- / gemini- 厂商规则**之前**判定,
  // 否则 gpt-image-2 / gemini-3-pro-image / gpt-4o-transcribe 会被误归到 gpt / google。
  // 这些是网关多返回的、不能当 agent 用的模型,默认关、仅按类型归类展示。
  if (/embedding/.test(id) || id.startsWith('voyage/')) return 'embedding';
  if (/image/.test(id)) return 'image';
  if (
    id.startsWith('elevenlabs/') ||
    id.startsWith('gpt-4o-realtime') ||
    /transcribe|audio|speech|tts|whisper|asr|gemini-omni/.test(id)
  )
    return 'audio';
  if (/seedance|happyhorse|video|-t2v|-i2v|-r2v/.test(id)) return 'video';
  if (id === 'ai-gateway-doc') return 'other';
  // 订阅直连 GPT(chatgpt/ 前缀,经 responses-bridge)与网关 gpt- 同归 GPT 组;前缀常量走
  // shared/subscriptionModels 单一入口,防与路由 / 记账 gate 漂移。
  if (id.startsWith('gpt-') || id.startsWith(CHATGPT_MODEL_PREFIX)) return 'gpt';
  if (id.startsWith('codex/')) return 'gpt-budget';
  if (id.startsWith(XAI_MODEL_PREFIX) || id.startsWith('grok')) return 'grok';
  if (id.startsWith('gemini-')) return 'google';
  return 'china';
}

const KNOWN_CATEGORIES = new Set<string>(CATEGORY_ORDER);

/**
 * 决定一个模型的厂商分组 —— **数据优先**:目录里带了合法 `group` 就用它,
 * 否则回退到 id 前缀归类(categorize)。未知的 group 值(渲染层没有对应标签)也回退,
 * 避免出现没有 i18n 标签的空分组。
 */
export function groupOf(model: { id: string; group?: string }): ModelCategory {
  if (model.group && KNOWN_CATEGORIES.has(model.group)) return model.group as ModelCategory;
  return categorize(model.id);
}

/** groupModelsForDisplay 的最小模型形状(只需 id + 可选 group / sortOrder)。 */
export interface DisplayModel {
  id: string;
  group?: string;
  sortOrder?: number;
}

/**
 * 选择器右栏的「分组 + 排序」纯逻辑 —— **完全由目录数据驱动**:
 *   1. 先按 `sortOrder` 升序稳定排序(缺省排末尾,相等时保持入参顺序);
 *   2. 按 `groupOf`(group 字段优先 / 前缀兜底)分桶;
 *   3. 桶的先后 = 桶内首个模型在已排序列表里的出现序(= 该桶最小 sortOrder)。
 * 返回有序的 { category, models } 列表;不依赖写死的 CATEGORY_ORDER 决定展示顺序。
 */
export function groupModelsForDisplay<T extends DisplayModel>(
  models: readonly T[],
): Array<{ category: ModelCategory; models: T[] }> {
  const sorted = [...models].sort(
    (a, b) =>
      (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY),
  );
  const map = new Map<ModelCategory, T[]>();
  for (const m of sorted) {
    const cat = groupOf(m);
    const list = map.get(cat) ?? [];
    list.push(m);
    map.set(cat, list);
  }
  return [...map.entries()].map(([category, list]) => ({ category, models: list }));
}

/** resolveSourceSwitch 的最小模型形状(只需 id + 该模型支持的 effort 档)。 */
export interface SwitchModel {
  id: string;
  efforts: readonly Effort[];
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
    providerOffersModel(provider, remembered.model, agent) &&
    visibleModels.some((m) => m.id === remembered.model) &&
    isVisible(remembered.model);

  if (memUsable && remembered) {
    targetModel = remembered.model;
    const tm = visibleModels.find((m) => m.id === remembered.model);
    if (tm && tm.efforts.includes(remembered.effort)) targetEffort = remembered.effort;
  } else if (currentModelId && !providerOffersModel(provider, currentModelId, agent)) {
    const ordered = CATEGORY_ORDER.filter(
      (c) => c !== 'image' && c !== 'audio' && c !== 'video' && c !== 'embedding' && c !== 'other',
    ).flatMap((c) => visibleModels.filter((m) => categorize(m.id) === c));
    targetModel = ordered.find(
      (m) => providerOffersModel(provider, m.id, agent) && isVisible(m.id),
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
  const sources = sourcesForModel(providers, modelId, agent);
  return !sources.some((p) => p.id === selectedProviderId);
}

// 「按供应商分段」的列表派生 + 类型已下沉到共享包 `@cindy/model-providers`(让 main 侧 IM /model
// 复用同一份逻辑,两端模型列表口径一致)。这里 re-export 保持 renderer 既有 import 路径不变。
export { buildProviderSections } from '@cindy/model-providers';
export type { SectionModel, ProviderSection } from '@cindy/model-providers';
