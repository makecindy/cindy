/**
 * visionCapability —— 模型视觉能力三态判定（纯逻辑，零依赖）。
 *
 * cindy 的模型目录（catalog / model-registry）目前**没有结构化**的「能否看图」元数据
 * （modalities 只在 Pi 自定义 provider 手动标记，内置目录为空）。视觉桥配置需要区分
 * 「已知有视觉 / 已知无视觉 / 未知」三类模型，本模块维护一份保守名单 + 归一化判定。
 *
 * 分类语义（对齐 docs/vision-bridge-design.md 配置设计）：
 *  - vision：已知支持图片输入的多模态模型（claude / gpt / gemini / grok 等）；
 *  - no-vision：已知纯文本模型（deepseek 系列、glm-5.2 等，实测/厂商声明无视觉）；
 *  - unknown：名单外 —— 不确定，按保守处理（视觉桥配置 UI 默认不勾选，允许用户手动勾）。
 *
 * 归一化：runtime 的 body.model 形态多样 —— `deepseek/deepseek-v4-flash`、裸
 * `deepseek-v4-flash`、带 `[1m]` 后缀、`codex/` 前缀等。判定统一剥掉后缀/前缀再匹配，
 * 保证「目录 id」与「请求体 model」都能命中同一名单。
 */

export type VisionCapability = 'vision' | 'no-vision' | 'unknown';

/** 已知支持图片输入的多模态模型 id 前缀（保守名单）。
 * 同时覆盖带命名空间（anthropic/claude-）与裸 id（claude-）形态——runtime body.model
 * 可能是任一种。 */
const VISION_ID_PREFIXES: readonly string[] = [
  'anthropic/claude-',
  'claude-',
  'openai/gpt-',
  'gpt-',
  'google/gemini-',
  'gemini-',
  'xai/grok-',
  'grok-',
  'qwen/qwen2.5-vl',
  'qwen/qwen2.7-vl',
  'qwen/qwen3-vl',
  'qwen/qwen-vl',
  'moonshotai/kimi-k2-vision',
];

/** 已知纯文本（无视觉）模型 id 前缀（保守名单）。 */
const NO_VISION_ID_PREFIXES: readonly string[] = [
  // deepseek 官方仅文本/代码模态；deepseek-v4 系列用户明确指定为无视觉。
  'deepseek/deepseek-',
  // 裸 id 形态（部分 runtime body.model 不带命名空间）。
  'deepseek-',
  // glm-5.2 官方仅文本/代码模态（见 anthropic-compat-proxy transform.ts #794 实测）。
  'z-ai/glm-5.2',
  // 裸 id 形态（catalog/runtime 可能用 `glm-5.2` / `glm-5.2[1m]`，normalize 已剥 [1m]）。
  'glm-5.2',
];

/**
 * 剥掉请求体 model 的归一化噪声：`[1m]` 窗口后缀、`codex/` 等前缀、provider 命名空间。
 * 返回与目录前缀可匹配的规范化 id。
 */
export function normalizeVisionModelId(model: string): string {
  let id = model.trim();
  // `[1m]` / `[32k]` 上下文窗口后缀（claude-code SDK 按目录 1M 窗口追加）。
  id = id.replace(/\[\d+[km]?\]$/i, '');
  // 前缀剥到「provider/家族名」粒度，保留命名空间（如 deepseek/、anthropic/）。
  // codex 命名空间模型（codex/gpt-5.5）是 Responses 路线，视觉能力与 gpt-5.5 一致。
  if (id.startsWith('codex/')) id = id.slice('codex/'.length);
  return id;
}

/**
 * 型号名里的**显式视觉标记**：独立的 `vision` / `vl`（含 `vl2` 这类带代号的）段。
 *
 * 为什么需要它：上面两份名单是**家族级前缀**（`deepseek-`、`glm-5.2`），而厂商常在同一
 * 家族里放一个视觉变体 —— `deepseek/deepseek-vl2`、`deepseek/deepseek-v4-flash-vision-exp`、
 * `glm-5.2-vision`。这些 id 都以家族前缀开头，只按前缀匹配会被家族的 no-vision 结论吃掉，
 * 判成「不能看图」（2026-09-04 实测四个型号全部误判）。后果不只是设置页标错：
 * `isKnownNoVisionModel` 是视觉桥「未自定义时默认勾选」的依据，误判会让本可以直接吃图的
 * 模型被迫走桥 —— 图片先转成文字描述再喂进去，真实图像信息就丢了。
 *
 * 判据是厂商命名惯例（`-vl` / `-vision` 后缀专指多模态变体），与本模块「靠 id 判定」的
 * 前提一致；比逐个登记型号更能覆盖以后新出的变体。段边界（`^` / `-` / `/` 起，`-` / `.`
 * / 结尾止）用来避免误伤把这两个词当普通词素的名字。
 */
const EXPLICIT_VISION_MARKER = /(?:^|[-/])(?:vision|vl\d*)(?:[-.]|$)/i;

/** 判定一个模型 id 的视觉能力（三态）。 */
export function classifyVisionCapability(model: string): VisionCapability {
  const id = normalizeVisionModelId(model);
  // 显式标记优先于家族级结论 —— 家族说「纯文本」，型号名说「我是视觉变体」时，后者更具体。
  if (EXPLICIT_VISION_MARKER.test(id)) return 'vision';
  if (NO_VISION_ID_PREFIXES.some((p) => id.startsWith(p))) return 'no-vision';
  if (VISION_ID_PREFIXES.some((p) => id.startsWith(p))) return 'vision';
  return 'unknown';
}

/** 便捷判断：某模型 id 是否已知无视觉（视觉桥目标清单默认勾选依据）。 */
export function isKnownNoVisionModel(model: string): boolean {
  return classifyVisionCapability(model) === 'no-vision';
}

/** 便捷判断：某模型 id 是否已知有视觉（视觉后端清单标注依据）。 */
export function isKnownVisionModel(model: string): boolean {
  return classifyVisionCapability(model) === 'vision';
}
