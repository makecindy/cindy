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
// 对话厂商组(anthropic..ungrouped)在前;非对话类型组(image/tts/stt/realtime/video/embedding/
// compression/other)在后——后者收纳网关多出的图像/语音/视频/向量/压缩等模型(它们默认关、
// 不能当 agent 用,仅分类展示,见 isChatEligible)。
//
// `ungrouped` = **认不出厂商的对话模型**(categorize 的兜底)。它属于对话厂商组
// (CHAT_VENDOR_CATEGORIES),照常可选 —— 兜底放行的理由见 isChatEligible。
// 2026-08 前这个兜底是 `china`,于是 o3 / mistral-* / llama-* / command-r-* / gemma-* 这些
// 认不出的模型一律被标成「中国」;分组名是用户直接看见的断言,认不出就不该替它断言产地。
//
// 相应地,`china` 从此**只由目录数据产生** —— 服务端下发 `group:'china'` 才进「中国」
// (catalog/model-registry.json 里国产条目全部已标)。客户端不做国产厂商的 id 猜测:
// 产地不是 id 能可靠推断的属性,猜错的代价是把别家模型挂到「中国」下面。服务端漏标的
// 后果是它落进「未分组」——可自愈,补 group 即归位。
//
// `other` = **不能当对话模型用的其它端点**(moderation / rerank / 遗留 Completions /
// 未知 mode)。保留既有 wire 语义；认不出厂商的聊天模型使用 `ungrouped`。
export type ModelCategory =
  | 'anthropic'
  | 'gpt'
  | 'gpt-budget'
  | 'grok'
  | 'google'
  | 'china'
  | 'ungrouped'
  | 'image'
  | 'video'
  | 'tts'
  | 'stt'
  | 'realtime'
  | 'embedding'
  | 'compression'
  | 'other';

// `ungrouped` 紧跟 `china`、排在对话厂商组末位；能力端点 `other` 排在能力组末位。
export const CATEGORY_ORDER: ModelCategory[] = [
  'anthropic',
  'gpt-budget',
  'gpt',
  'grok',
  'google',
  'china',
  'ungrouped',
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
  // 认不出厂商 ≠ 不能对话:兜底组必须留在这里,否则「mode 还没覆盖到、但已经在正常
  // 工作的网关聊天模型」会整批从 availableModels 消失。
  'ungrouped',
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
 * 先落 other 展示原始 mode。未知 mode 已经明说它不是对话模型,不该混进「未分组」那一组。
 */
const MODE_TO_CATEGORY: Record<string, ModelCategory> = {
  embedding: 'embedding',
  image_generation: 'image',
  video_generation: 'video',
  audio_speech: 'tts',
  audio_transcription: 'stt',
  realtime: 'realtime',
};

/**
 * mode 取值里同样代表"语言模型、能聊天"的字符串集合 —— 不止字面的 'chat'。
 * `responses` 是 LiteLLM/Gateway 用来标记"该模型只走 OpenAI Responses API
 * (而非 Chat Completions)"的取值,语义仍是可对话的语言模型,只是 wire
 * protocol 不同;Codex 这条 runtime 本来就默认走 openai-responses(见
 * RoutingDescriptor.wireProtocol),不能把这类模型当成非聊天模型过滤掉
 * (2026-07 review 第 16 轮)。
 */
const CHAT_CAPABLE_MODES = new Set(['chat', 'responses']);

/**
 * 去掉 id 的全部 `<namespace>/` 前缀,取最后一段。网关有时会给 id 加供应商命名空间
 * (如 openai/dall-e-3、google/veo-3,catalog 本身就支持 openai/gpt-5.4 这类写法),
 * 且可能嵌套多层(如 gateway/openai/dall-e-3);dall-e/sora/veo- 这几个锚定 id 开头的
 * 关键字判定必须同时认「裸 id」与「去前缀后的尾部」,只剥一层的话嵌套命名空间仍会
 * 漏网(2026-07 review 第 19 轮;多层修正见第 24 轮)。
 */
function stripNamespace(id: string): string {
  const idx = id.lastIndexOf('/');
  return idx === -1 ? id : id.slice(idx + 1);
}

// 按 model.id 前缀粗分类: claude-* → Anthropic, gpt-* → GPT, codex/* → 骨折GPT (gateway 低价路由),
// gemini-* → Google, 认不出厂商的 → `ungrouped`(「未分组」)。
// **`china` 不在这里**:「中国」只认目录显式下发的 `group:'china'`(见 groupOf)。这里不做
// 国产厂商的 id 猜测 —— 产地是 id 猜不出来的属性,猜错就是把别家模型标成「中国」;宁可落
// 中性的「未分组」,由服务端补 group 归位。
// 这是**没有 mode 时**的兜底(旧缓存 / mode 尚未覆盖到的来源);mode 存在时一律用
// classifyModel,不再猜 id。
export function categorize(rawId: string): ModelCategory {
  // 走 {id,name} 极简发现的自定义 OAuth 供应商常保留原始大小写(如
  // Qwen/Qwen3-Embedding-8B、Qwen/Qwen3-Reranker-8B),下面全部关键词/前缀判定
  // 统一按小写比较,不逐个正则补 i 标记漏改(2026-07 review 第 20 轮)。categorize
  // 只返回分类标签,不回传 id,小写化不影响展示 / 请求用的原始 id。
  const id = rawId.toLowerCase();
  // 厂商前缀同样要认命名空间形态 —— 目录里的 id 本来就是带命名空间的
  // (catalog/model-registry.json 全是 anthropic/claude-opus-5、openai/gpt-5.5、
  // google/gemini-3.5-flash 这种写法)。只认裸 id 的话,这些条目一旦缺 group 就会
  // 整批落进中性的 `ungrouped`,不猜产地。与 dall-e/sora/veo-/embed-/legacy 的命名空间
  // 兜底同一处理。
  if (id.startsWith('claude-') || stripNamespace(id).startsWith('claude-')) return 'anthropic';
  // 非对话类型(向量/图像/语音/视频/压缩)必须在通用 gpt- / gemini- 厂商规则**之前**判定,
  // 否则 gpt-image-2 / gemini-3-pro-image / gpt-4o-transcribe 会被误归到 gpt / google。
  // 这些是网关多返回的、不能当 agent 用的模型,默认关、仅按类型归类展示。
  // embed-english-v3.0 / embed-multilingual-v3.0(Cohere)等 id 里没有 "embedding"
  // 字样,只靠 /embedding/ 关键词兜底会漏网(2026-07 review 第 17 轮,同 dall-e/
  // sora/veo 这类命名不含类型关键词的情况);embed- 锚定 id 开头,带命名空间前缀
  // (如 cohere/embed-english-v3.0)会漏网,同 dall-e/sora/veo- 的命名空间兜底
  // 同理(2026-07 review 第 22 轮)。
  if (
    /embedding/.test(id) ||
    id.startsWith('voyage/') ||
    id.startsWith('embed-') ||
    stripNamespace(id).startsWith('embed-')
  )
    return 'embedding';
  // dall-e(OpenAI 图像)id 里没有 "image" 字样,靠关键词兜底会漏网(2026-07 review:
  // 走 {id,name} 极简发现的自定义 OAuth 供应商没有 mode/group,只能靠这份正则)。
  if (/image/.test(id) || id.startsWith('dall-e') || stripNamespace(id).startsWith('dall-e'))
    return 'image';
  // sora(OpenAI 视频)/ veo(Google 视频)同理,id 里没有 "video" 字样。故意不认通用的
  // "video" 关键词:llava-hf/LLaVA-NeXT-Video-7B-hf 这类视频理解多模态聊天模型 id
  // 里带 "video" 却是走 Chat Completions 的正常聊天模型,不是纯视频生成端点——与
  // 音频判定不认通用 "audio" 关键词同理(2026-07 review 第 23 轮)。只认
  // seedance/happyhorse/-t2v/-i2v/-r2v 这几个真正专指视频生成的关键词。
  if (
    /seedance|happyhorse|-t2v|-i2v|-r2v/.test(id) ||
    /^sora|^veo-/.test(id) ||
    /^sora|^veo-/.test(stripNamespace(id))
  )
    return 'video';
  if (id === 'ai-gateway-doc') return 'compression';
  // moderation(如 omni-moderation-latest / text-moderation-latest)不是issue #882
  // 列出的语义类型之一,落 other 保留原始 id/mode(2026-07 review:走 {id,name} 极简
  // 发现的自定义 OAuth 供应商没有 mode,不挡的话会被 isChatEligible 误判为可聊天——
  // moderation 端点不接受聊天请求)。
  if (/moderation/.test(id)) return 'other';
  // 遗留 Completions 端点(davinci-002/babbage-002/text-davinci-*等,OpenAI 已停售但
  // 部分网关仍会同步)与 Rerank 端点(cohere/voyage 的 rerank-*)不接受 Chat Completions
  // 请求,未列入 issue #882 语义类型,落 other 保留原始 id(2026-07 review:走 {id,name}
  // 极简发现的自定义 OAuth 供应商没有 mode,靠正则兜底,否则会被 isChatEligible 误判为
  // 可聊天)。只匹配这批已停售且无歧义的固定 id/前缀——不用 `-instruct$` 这种宽泛后缀,
  // 因为 mistral/qwen/llama 的 "-instruct" 结尾模型是正常聊天模型,不能误杀。
  if (/rerank/.test(id)) return 'other';
  const LEGACY_COMPLETION_RE =
    /^(babbage-002|davinci-002|gpt-3\.5-turbo-instruct|text-davinci-\d{3}|text-curie-001|text-babbage-001|text-ada-001|code-davinci-002)$/;
  // 精确匹配前后都锚定,带供应商命名空间前缀(如 openai/babbage-002)会漏网,同
  // dall-e/sora/veo- 的命名空间兜底同理(2026-07 review 第 21 轮)。
  if (LEGACY_COMPLETION_RE.test(id) || LEGACY_COMPLETION_RE.test(stripNamespace(id)))
    return 'other';
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
  // gpt-realtime-/gpt-4o-realtime- 锚定 id 开头,带命名空间前缀(如
  // openai/gpt-realtime-preview)会漏网落进聊天兜底组,同 dall-e/sora/veo- 的
  // 命名空间兜底同理(2026-07 review 第 21 轮);gemini-omni 是子串匹配,已天然
  // 兼容命名空间,不需要额外处理。
  if (
    /^gpt-realtime|^gpt-4o-realtime/.test(id) ||
    /^gpt-realtime|^gpt-4o-realtime/.test(stripNamespace(id)) ||
    /gemini-omni/.test(id)
  )
    return 'realtime';
  // 订阅直连 GPT(chatgpt/ 前缀,经 responses-bridge)与网关 gpt- 同归 GPT 组;前缀常量与
  // 路由 / 记账 gate 同源(本文件顶部),防漂移。两个常量本身已是小写字面量,小写化后
  // 直接比较无需再转换。
  // 折扣路由必须判在 gpt 之前:`codex/gpt-5.4` 去掉命名空间就是 `gpt-5.4`,下面那条
  // 认尾段的 gpt 规则会把它抢成 gpt 组,徽章与分组随之自相矛盾(2026-08 加尾段匹配时
  // 被 categorize 的既有用例当场抓到)。
  if (id.startsWith('codex/')) return 'gpt-budget';
  // `xd/codex-gpt-5.5` 这类 id 去命名空间后是 `codex-gpt-5.5`,不以 `gpt-` 开头,同样不会
  // 被这条抢走(它的折扣归属由目录 group 决定,见 isBudgetModel)。
  if (
    id.startsWith('gpt-') ||
    id.startsWith(CHATGPT_MODEL_PREFIX) ||
    stripNamespace(id).startsWith('gpt-')
  )
    return 'gpt';
  // x-ai/ 只是网关侧 grok 的命名空间前缀(展示分组用),与 XAI_MODEL_PREFIX
  // ('xai/',订阅直连 bridge 语义)是两件事,不要合并常量。
  if (
    id.startsWith(XAI_MODEL_PREFIX) ||
    id.startsWith('x-ai/') ||
    id.startsWith('grok') ||
    stripNamespace(id).startsWith('grok')
  )
    return 'grok';
  if (id.startsWith('gemini-') || stripNamespace(id).startsWith('gemini-')) return 'google';
  return 'ungrouped';
}

const KNOWN_CATEGORIES = new Set<string>(CATEGORY_ORDER);

/**
 * 决定一个模型的厂商分组 —— **数据优先**:目录里带了合法 `group` 就用它,
 * 否则回退到 id 前缀归类(categorize)。未知的 group 值(渲染层没有对应标签)也回退,
 * 避免出现没有 i18n 标签的空分组。不感知 `mode`——mode 优先分类见 classifyModel。
 */
export function groupOf(model: { id: string; group?: string }): ModelCategory {
  if (model.group) {
    if (KNOWN_CATEGORIES.has(model.group)) return model.group as ModelCategory;
  }
  return categorize(model.id);
}

/**
 * 分类的**权威入口**(issue #882):`mode` 存在且不是聊天可用取值
 * (CHAT_CAPABLE_MODES)时直接按 MODE_TO_CATEGORY 权威判定,忽略 id/group——
 * 网关明确说了这不是聊天模型,不该再让 id 正则有机会猜错(如 gpt-realtime-2
 * 猜成 gpt、x-ai/grok-4.5 猜成 china)。`mode` 缺省或落在 CHAT_CAPABLE_MODES
 * (chat/responses)时,回退 groupOf(数据 group 优先 / id 正则兜底)——
 * "是不是聊天模型"与"聊天模型属于哪个厂商分组"是两层判断,mode 只回答第一层,
 * 第二层仍需 id/group。
 */
export function classifyModel(model: { id: string; group?: string; mode?: string }): ModelCategory {
  if (model.mode !== undefined && !CHAT_CAPABLE_MODES.has(model.mode)) {
    return MODE_TO_CATEGORY[model.mode] ?? 'other';
  }
  return groupOf(model);
}

/**
 * 该模型能不能进 Agent `availableModels` / 新对话模型选择器(issue #882 第 3 点)。
 * `mode` 存在时只信 CHAT_CAPABLE_MODES(chat / responses——Codex 走 Responses
 * API 的语言模型,不是非聊天端点,2026-07 review 第 16 轮)。
 *
 * `mode` 缺省时,`group` 只在**声明已知的非聊天分类**(image/video/tts/stt/
 * realtime/embedding/compression/other)时才采信、直接拒——这个方向上 group
 * 比 id 更可信(PR #744:自定义/网关供应商显式打的能力标签,seedream-5 这类
 * id 本身不含任何类型关键词的合成模型只能靠这个信号判定)。`group` 声明的是
 * 聊天厂商分组(anthropic/gpt/.../china/ungrouped)时**不采信**,仍按 id 正则判——那只是
 * 展示分组/品牌,网关的展示元数据完全可能把 `gpt-image-2` 这类图像模型的
 * `group` 标成 'gpt'(品牌上归类到 GPT 家族,方便浏览),这里若信了会把非聊天
 * 模型误判为可用(2026-07 review)。两种 group 取值的可信方向不对称,不能
 * 一并处理。落进厂商聊天组只用于兜底判断,保证"mode 还没覆盖到、但已经在
 * 正常工作的网关聊天模型"不会因为这次改动突然从 availableModels 消失
 * (见 classification.test.ts 的回归锁)。
 */
export function isChatEligible(model: { id: string; group?: string; mode?: string }): boolean {
  if (model.mode !== undefined) return CHAT_CAPABLE_MODES.has(model.mode);
  const group = model.group;
  if (group && KNOWN_CATEGORIES.has(group) && !CHAT_VENDOR_CATEGORIES.has(group as ModelCategory)) {
    return false;
  }
  return CHAT_VENDOR_CATEGORIES.has(categorize(model.id));
}

/**
 * `isChatEligible` 的别名,供「agent 对话模型能不能选」语境下的调用方使用(与 PR #744
 * 的 `AGENT_MODEL_CATEGORIES`/`isAgentSelectableModel` 合流:同一个"能不能进对话选择面板"
 * 判断,不再各自维护一份厂商分组常量——两份常量此前逐字相同,已收口为
 * `CHAT_VENDOR_CATEGORIES` 单一定义)。
 *
 * `opts.userProvider` = 该条目来自用户自定义供应商(Provider.source === 'user',由
 * 调用方注入 —— 本模块纯逻辑不持 provider 上下文):此时目录带的**未知 group**
 * (buildUserProvider 的 `custom:<providerId>`)= 用户显式配置的 agent 模型,直接放行,
 * 不让 groupOf 的未知组回退吃 id 启发式 —— 否则 `gpt-4o-audio-preview` 这类合法
 * 自定义对话模型会被误判成能力模型而从全部对话清单消失(PR #744 review)。
 *
 * 例外**只限用户供应商**:内置网关即使显式下发未知 group（如历史 `custom:xd`），
 * 若无条件放行未知组,无分组下发的网关图像/音频/向量模型会
 * 绕过能力分类、重新漏进对话清单 —— 正是本过滤要堵的洞(PR #744 review 第二轮)。
 * 非用户供应商一律走 isChatEligible(mode 权威、id 正则兜底)。
 */
export function isAgentSelectableModel(
  model: { id: string; group?: string; mode?: string },
  opts?: { userProvider?: boolean },
): boolean {
  if (opts?.userProvider === true && model.group && !KNOWN_CATEGORIES.has(model.group)) {
    return true;
  }
  return isChatEligible(model);
}

/**
 * 新会话、切模型、worker 与自动 fallback 的统一准入。`isAgentSelectableModel` 只回答
 * “是不是 agent 对话模型”；本函数再叠加本地停用与 Registry retired tombstone。
 * 已在运行的会话需要展示/续跑当前选择时应继续调用前者，不能借此绕过新路由边界。
 */
export function isModelSelectableForNewRoute(
  model: {
    id: string;
    group?: string;
    mode?: string;
    disabled?: boolean;
    status?: string;
  },
  opts?: { userProvider?: boolean },
): boolean {
  return (
    model.disabled !== true &&
    model.status !== 'retired' &&
    isAgentSelectableModel(model, opts)
  );
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
