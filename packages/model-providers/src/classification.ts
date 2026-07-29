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
// 对话厂商组(anthropic..china)在前;非对话类型组(image/tts/stt/realtime/video/embedding/
// compression/other)在后——后者收纳网关多出的图像/语音/视频/向量/压缩等模型(它们默认关、
// 不能当 agent 用,仅分类展示,见 isChatEligible)。
export type ModelCategory =
  | 'anthropic'
  | 'gpt'
  | 'gpt-budget'
  | 'grok'
  | 'google'
  | 'china'
  | 'image'
  | 'video'
  | 'tts'
  | 'stt'
  | 'realtime'
  | 'embedding'
  | 'compression'
  | 'other';

export const CATEGORY_ORDER: ModelCategory[] = [
  'anthropic',
  'gpt-budget',
  'gpt',
  'grok',
  'google',
  'china',
  'image',
  'video',
  'tts',
  'stt',
  'realtime',
  'embedding',
  'compression',
  'other',
];

/** 对话厂商组:属于其一即被 isChatEligible 判定为可进 Agent availableModels。 */
const CHAT_VENDOR_CATEGORIES = new Set<ModelCategory>([
  'anthropic',
  'gpt',
  'gpt-budget',
  'grok',
  'google',
  'china',
]);

/**
 * 对话厂商组,按 CATEGORY_ORDER 原有相对顺序派生(供切来源 reconcile 之类
 * 「只在聊天厂商组里找候选」的场景复用,不必各自手写排除非聊天分类的清单——
 * 那份清单每新增一个非聊天分类就要改一处,已经是本次要修的那类耦合)。
 */
export const CHAT_VENDOR_CATEGORY_ORDER: readonly ModelCategory[] = CATEGORY_ORDER.filter((c) =>
  CHAT_VENDOR_CATEGORIES.has(c),
);

/**
 * Gateway 原生 `mode` → 展示分类(issue #882:mode 是权威信号,取值即
 * LiteLLM/AIGateway 侧的原生字符串,未来新增值先落 other 并保留原串,不必
 * 为每个新值改这里的正则)。'chat' 与缺省不出现在这里 —— 它们仍按厂商
 * 前缀走 groupOf/categorize 归到 anthropic/gpt/grok/google/china 等分组,
 * 因为"是聊天模型"和"属于哪个厂商分组"是两个独立问题。
 * 取值以线上 Gateway 实际返回为准;这里先覆盖 LiteLLM 通用常见值,遇到确认
 * 的新取值(如压缩类的真实 mode 字符串)再补充映射,未覆盖时不会丢数据,只是
 * 先落 other 展示原始 mode。
 */
const MODE_TO_CATEGORY: Record<string, ModelCategory> = {
  embedding: 'embedding',
  image_generation: 'image',
  video_generation: 'video',
  audio_speech: 'tts',
  audio_transcription: 'stt',
  realtime: 'realtime',
};

// 按 model.id 前缀粗分类: claude-* → Anthropic, gpt-* → GPT, codex/* → 骨折GPT (gateway 低价路由),
// gemini-* → Google, 其余 (moonshotai/qwen/glm/...) 一律落到 China。新增国产模型不需要改这里。
// 这是**没有 mode 时**的兜底(旧缓存 / mode 尚未覆盖到的来源);mode 存在时一律用
// classifyModel,不再猜 id。
export function categorize(id: string): ModelCategory {
  if (id.startsWith('claude-')) return 'anthropic';
  // 非对话类型(向量/图像/语音/视频/压缩)必须在通用 gpt- / gemini- 厂商规则**之前**判定,
  // 否则 gpt-image-2 / gemini-3-pro-image / gpt-4o-transcribe 会被误归到 gpt / google。
  // 这些是网关多返回的、不能当 agent 用的模型,默认关、仅按类型归类展示。
  if (/embedding/.test(id) || id.startsWith('voyage/')) return 'embedding';
  if (/image/.test(id)) return 'image';
  if (/seedance|happyhorse|video|-t2v|-i2v|-r2v/.test(id)) return 'video';
  if (id === 'ai-gateway-doc') return 'compression';
  // STT/ASR 必须在 realtime 判定之前:qwen3-asr-flash-realtime / fun-asr-realtime-* /
  // gpt-realtime-whisper 的 id 里都含 "realtime",但语义是语音转写,不是实时多模态。
  // 不能只认 elevenlabs 前缀——否则 gpt-4o-mini-tts / qwen-tts 这类其它厂商的语音模型
  // 会漏网落进 gpt/china,被 isChatEligible 误判为可聊天(2026-07 review)。
  if (id.startsWith('elevenlabs/scribe') || /transcribe|whisper|asr/.test(id)) return 'stt';
  // 故意不认通用的 "audio" 关键词:isChatEligible 现在直接吃 categorize 的分类结果,
  // 落进 tts 就等于判定"不能聊天"——而 gpt-4o-audio-preview 这类模型 id 里带
  // "audio" 却是走 Chat Completions 的正常聊天模型(带音频输入/输出),不是纯语音
  // 合成端点。只认 speech/tts 这两个真正专指语音合成的关键词(2026-07 review:
  // 拆分前 audio 只影响展示分组,拆分后同一份 regex 还要决定聊天准入,精度要求变了)。
  if (id.startsWith('elevenlabs/eleven') || /speech|tts/.test(id)) return 'tts';
  // gpt-realtime-2 / gpt-realtime-mini / gpt-realtime-translate / gpt-4o-realtime-* /
  // gemini-omni-* —— 真正的实时多模态,已排除上面的 STT 特例。gpt-4o-realtime 前缀是
  // 旧一代命名,新一代改成了 gpt-realtime-*,兜底要同时认两种(2026-07 review)。
  if (/^gpt-realtime|^gpt-4o-realtime|gemini-omni/.test(id)) return 'realtime';
  // 订阅直连 GPT(chatgpt/ 前缀,经 responses-bridge)与网关 gpt- 同归 GPT 组;前缀常量与
  // 路由 / 记账 gate 同源(本文件顶部),防漂移。
  if (id.startsWith('gpt-') || id.startsWith(CHATGPT_MODEL_PREFIX)) return 'gpt';
  if (id.startsWith('codex/')) return 'gpt-budget';
  // x-ai/ 只是网关侧 grok 的命名空间前缀(展示分组用),与 XAI_MODEL_PREFIX
  // ('xai/',订阅直连 bridge 语义)是两件事,不要合并常量。
  if (id.startsWith(XAI_MODEL_PREFIX) || id.startsWith('x-ai/') || id.startsWith('grok'))
    return 'grok';
  if (id.startsWith('gemini-')) return 'google';
  return 'china';
}

const KNOWN_CATEGORIES = new Set<string>(CATEGORY_ORDER);

/**
 * 决定一个模型的厂商分组 —— **数据优先**:目录里带了合法 `group` 就用它,
 * 否则回退到 id 前缀归类(categorize)。未知的 group 值(渲染层没有对应标签)也回退,
 * 避免出现没有 i18n 标签的空分组。不感知 `mode`——mode 优先分类见 classifyModel。
 */
export function groupOf(model: { id: string; group?: string }): ModelCategory {
  if (model.group && KNOWN_CATEGORIES.has(model.group)) return model.group as ModelCategory;
  return categorize(model.id);
}

/**
 * 分类的**权威入口**(issue #882):`mode` 存在且不是 'chat' 时直接按
 * MODE_TO_CATEGORY 权威判定,忽略 id/group——网关明确说了这不是聊天模型,
 * 不该再让 id 正则有机会猜错(如 gpt-realtime-2 猜成 gpt、x-ai/grok-4.5 猜成
 * china)。`mode` 缺省或恰好是 'chat' 时,回退 groupOf(数据 group 优先 /
 * id 正则兜底)—— "是不是聊天模型"与"聊天模型属于哪个厂商分组"是两层判断,
 * mode='chat' 只回答第一层,第二层仍需 id/group。
 */
export function classifyModel(model: { id: string; group?: string; mode?: string }): ModelCategory {
  if (model.mode !== undefined && model.mode !== 'chat') {
    return MODE_TO_CATEGORY[model.mode] ?? 'other';
  }
  return groupOf(model);
}

/**
 * 该模型能不能进 Agent `availableModels` / 新对话模型选择器(issue #882 第 3 点)。
 * `mode` 存在时只信 mode==='chat';缺省时按 **id 正则**(categorize)判定,
 * 故意不走 groupOf ——`group` 是展示分组/品牌,不是能力类型(issue #882 明确
 * 要求两者独立),网关的展示元数据完全可能把 `gpt-image-2` 这类图像模型的
 * `group` 标成 'gpt'(品牌上归类到 GPT 家族,方便浏览),这里若信了 group 会把
 * 非聊天模型误判为可用(2026-07 review)。是否落进厂商聊天组
 * (anthropic/gpt/gpt-budget/grok/google/china)只用于兜底判断,保证"mode 还
 * 没覆盖到、但已经在正常工作的网关聊天模型"不会因为这次改动突然从
 * availableModels 消失(见 classification.test.ts 的回归锁)。
 */
export function isChatEligible(model: { id: string; group?: string; mode?: string }): boolean {
  if (model.mode !== undefined) return model.mode === 'chat';
  return CHAT_VENDOR_CATEGORIES.has(categorize(model.id));
}

/** groupModelsForDisplay 的最小模型形状(id + 可选 group / mode / sortOrder)。 */
export interface DisplayModel {
  id: string;
  group?: string;
  mode?: string;
  sortOrder?: number;
}

/**
 * 选择器右栏的「分组 + 排序」纯逻辑 —— **完全由目录数据驱动**:
 *   1. 先按 `sortOrder` 升序稳定排序(缺省排末尾,相等时保持入参顺序);
 *   2. 按 `classifyModel`(mode 优先 / group 字段次之 / id 前缀兜底)分桶;
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
    const cat = classifyModel(m);
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
