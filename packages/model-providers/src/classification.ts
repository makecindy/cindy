/**
 * classification —— 模型分类 / 来源徽章 / 展示格式的**单点语义**(纯逻辑,跨端共享)。
 *
 * 背景(2026-07 全仓盘点): 「骨折版 = `codex/` 前缀」在 desktop sourceSwitch.categorize、
 * ModelSelector.renderModelItem、mobile modelPickerRows、lizi-mcps list_available_models 各写
 * 一遍;「订阅」判定依赖分段模式的 provider 上下文,flat 清单下整个失效;`formatContextWindow`
 * 复制了 3 份。本模块把这些语义收成单点,i18n 标签表仍留各端(本包零依赖不碰 i18n)。
 *
 * categorize / groupOf / groupModelsForDisplay 从 apps/desktop renderer 的 sourceSwitch.ts
 * **原样下沉**(P1 期间 renderer 原实现暂留,有等价测试锁;P2 改 re-export 删旧)。
 */

import type { ProviderAccess } from './types.js';
import type { ModelSourceMeta } from './modelList.js';

/**
 * 订阅直连模型的 id 前缀(经本地 responses-bridge 翻译的 `chatgpt/` 与 `xai/`)。
 * 路由 gate、用量记账、SSH 远程排除必须共用这份前缀 —— 三者漂移会造成「列出了但发送必失败」
 * 或「记账记错通道」。原正本在 apps/desktop/src/shared/subscriptionModels.ts,下沉后该文件为
 * re-export shim(P2 落地)。
 */
export const CHATGPT_MODEL_PREFIX = 'chatgpt/';
export const XAI_MODEL_PREFIX = 'xai/';
export const SUBSCRIPTION_DIRECT_MODEL_PREFIXES = [
  CHATGPT_MODEL_PREFIX,
  XAI_MODEL_PREFIX,
] as const;

/**
 * model id 是否为「订阅直连」(bridge)模型。传归一化后或原始 id 均可(只看前缀)。
 * 签名与 apps/desktop/src/shared/subscriptionModels.ts 的历史实现逐字一致(下沉收口)。
 */
export function isSubscriptionDirectModel(model: string | null | undefined): boolean {
  if (!model) return false;
  return SUBSCRIPTION_DIRECT_MODEL_PREFIXES.some((prefix) => model.startsWith(prefix));
}

// 仅用于分组展示, 不参与持久化或 onModelChange 数据流。
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

// 按 model.id 前缀粗分类: claude-* → Anthropic, gpt-* → GPT, codex/* → 骨折GPT (gateway 低价路由),
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
  // 订阅直连 GPT(chatgpt/ 前缀,经 responses-bridge)与网关 gpt- 同归 GPT 组;前缀常量与
  // 路由 / 记账 gate 同源(本文件顶部),防漂移。
  if (id.startsWith('gpt-') || id.startsWith(CHATGPT_MODEL_PREFIX)) return 'gpt';
  if (id.startsWith('codex/')) return 'gpt-budget';
  if (id.startsWith(XAI_MODEL_PREFIX) || id.startsWith('grok')) return 'grok';
  if (id.startsWith('gemini-')) return 'google';
  return 'china';
}

const KNOWN_CATEGORIES = new Set<string>(CATEGORY_ORDER);

/**
 * 能作为 agent 对话模型被选择/路由的厂商分组(anthropic..china)。image / audio / video /
 * embedding / other 是网关多返回的**能力模型**:不能当 agent 用,永远不进对话模型选择面板
 * (硬排除,与显示开关无关),它们的「启用」只作用于媒体生成等专属链路。
 */
const AGENT_MODEL_CATEGORIES: ReadonlySet<ModelCategory> = new Set([
  'anthropic',
  'gpt',
  'gpt-budget',
  'grok',
  'google',
  'china',
]);

/**
 * 该模型是否属于可被 agent 选择的对话厂商分组(见 AGENT_MODEL_CATEGORIES)。
 *
 * `opts.userProvider` = 该条目来自用户自定义供应商(Provider.source === 'user',由
 * 调用方注入 —— 本模块纯逻辑不持 provider 上下文):此时目录带的**未知 group**
 * (buildUserProvider 的 `custom:<providerId>`)= 用户显式配置的 agent 模型,直接放行,
 * 不让 groupOf 的未知组回退吃 id 启发式 —— 否则 `gpt-4o-audio-preview` 这类合法
 * 自定义对话模型会被误判成能力模型而从全部对话清单消失(PR #744 review)。
 *
 * 例外**只限用户供应商**:网关条目缺 group 时 active-catalog 会补 `custom:xd`
 * (active-catalog.ts),若无条件放行未知组,无分组下发的网关图像/音频/向量模型会
 * 绕过能力分类、重新漏进对话清单 —— 正是本过滤要堵的洞(PR #744 review 第二轮)。
 * 非用户供应商一律走 groupOf(显式已知组优先,未知/缺省回退 id 启发式)。
 */
export function isAgentSelectableModel(
  model: { id: string; group?: string },
  opts?: { userProvider?: boolean },
): boolean {
  if (opts?.userProvider === true && model.group && !KNOWN_CATEGORIES.has(model.group)) {
    return true;
  }
  return AGENT_MODEL_CATEGORIES.has(groupOf(model));
}

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

/**
 * 骨折版(网关 85% off 低价路由)判定 —— 与 groupOf 同一「数据优先」契约:目录带**合法**
 * `group` 时徽章完全跟 group 走(显式非 budget 分组不再被 `codex/` 前缀 override,否则会
 * 出现「显示 budget 徽章却归入非 budget 分组」的自相矛盾,2026-07 Greptile review);
 * group 缺失/未知时才用前缀兜底(网关旧数据可能没标 group)。替代 4 处独立的前缀判断。
 */
export function isBudgetModel(model: { id: string; group?: string }): boolean {
  if (model.group && KNOWN_CATEGORIES.has(model.group)) return model.group === 'gpt-budget';
  return model.id.startsWith('codex/');
}

/** 一行模型的来源徽章语义(渲染层只管画,不再自判)。 */
export interface ModelBadges {
  /** 订阅来源(Claude.ai / ChatGPT 等订阅额度)。 */
  subscription: boolean;
  /** 骨折版(网关低价路由)。 */
  budget: boolean;
}

/**
 * 徽章判定的**唯一口径**。
 *
 * 订阅: 分段模式传该段 `provider`;flat 清单不再有 provider 上下文,改读条目上的
 * `sourceAccess`(deriveModelList 附带的真实溯源)。两者都拿不到(device-link 旧被控端的
 * 拍平 capabilities)→ false,诚实降级不猜。
 */
export function modelBadges(
  model: { id: string; group?: string } & Partial<Pick<ModelSourceMeta, 'sourceAccess'>>,
  provider?: { access?: ProviderAccess } | null,
): ModelBadges {
  // 传了 provider(分段模式)就**只看**该段的 access —— 段供应商无 access 元数据时不得
  // 回读 model.sourceAccess:溯源可能来自另一家供应商(flat 首见者),混用会给当前段的行
  // 打上别家的订阅徽章(Copilot review)。仅 provider 缺席(flat)才读溯源。
  const access = provider != null ? provider.access : model.sourceAccess;
  return {
    subscription: access?.kind === 'subscription',
    budget: isBudgetModel(model),
  };
}

/**
 * 上下文窗口 tokens → 紧凑展示("1M" / "272K" / "8192")—— desktop ModelSelector /
 * UnifiedModelList 与 mobile modelPickerRows 三份副本的收口,实现从 ModelSelector 原样下沉,
 * 输出逐字一致。
 */
export function formatContextWindow(tokens: number): string {
  if (tokens >= 1_000_000) {
    const m = tokens / 1_000_000;
    return `${Number.isInteger(m) ? m : Number(m.toFixed(1))}M`;
  }
  if (tokens >= 1000) {
    const k = tokens / 1000;
    return `${Number.isInteger(k) ? k : Number(k.toFixed(0))}K`;
  }
  return String(tokens);
}
