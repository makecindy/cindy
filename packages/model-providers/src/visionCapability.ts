/**
 * visionCapability —— 模型视觉能力三态判定（纯逻辑，零依赖）。
 *
 * 模型设置在目录缺少图片输入元数据时，按型号 ID 兜底区分「已知有视觉 / 已知无视觉 / 未知」。
 *
 * 分类语义（供模型图片输入配置使用）：
 *  - vision：已知支持图片输入的多模态模型（claude / gpt / gemini / grok 等）；
 *  - no-vision：已知纯文本模型（旧款 DeepSeek、glm-5.2 等）；
 *  - unknown：名单外 —— 不确定，不据此断言有无视觉能力，由模型配置与运行时处理。
 *
 * 归一化：runtime 的 body.model 形态多样 —— `deepseek/deepseek-v4-flash`、裸
 * `deepseek-v4-flash`、带 `[1m]` 后缀、`openai-codex/` / `codex/` 前缀等。判定统一剥掉后缀/前缀再匹配，
 * 保证「目录 id」与「请求体 model」都能命中同一名单。
 */

import { stripCodexGatewayWirePrefix } from './classification.js';

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
  // 保守的家族默认值，已知视觉型号优先匹配。
  'deepseek/deepseek-',
  // 裸 id 形态（部分 runtime body.model 不带命名空间）。
  'deepseek-',
  // glm-5.2 官方仅文本/代码模态（见 anthropic-compat-proxy transform.ts #794 实测）。
  'z-ai/glm-5.2',
  // 裸 id 形态（catalog/runtime 可能用 `glm-5.2` / `glm-5.2[1m]`，normalize 已剥 [1m]）。
  'glm-5.2',
];

/**
 * 剥掉请求体 model 的归一化噪声：`[1m]` 窗口后缀、`openai-codex/` / `codex/` 前缀、provider 命名空间。
 * 返回与目录前缀可匹配的规范化 id。
 */
export function normalizeVisionModelId(model: string): string {
  let id = model.trim();
  // `[1m]` / `[32k]` 上下文窗口后缀（claude-code SDK 按目录 1M 窗口追加）。
  id = id.replace(/\[\d+[km]?\]$/i, '');
  // 折扣命名空间（openai-codex/gpt-5.5、codex/gpt-5.5）是 Responses 路线，视觉能力与裸 gpt id 一致。
  id = stripCodexGatewayWirePrefix(id);
  return id;
}

/**
 * 型号名里的**显式视觉标记**：独立的 `vision` / `vl`（含 `vl2` 这类带代号的）段。
 *
 * 为什么需要它：上面两份名单是**家族级前缀**（`deepseek-`、`glm-5.2`），而厂商常在同一
 * 家族里放一个视觉变体 —— `deepseek/deepseek-vl2`、`deepseek/deepseek-v4-flash-vision-exp`、
 * `glm-5.2-vision`。这些 id 都以家族前缀开头，只按前缀匹配会被家族的 no-vision 结论吃掉，
 * 判成「不能看图」（2026-09-04 实测四个型号全部误判）。后果不只是设置页标错：
 * 误判会让本来支持图片输入的型号被标成纯文本，影响图片输入配置。
 *
 * 判据是厂商命名惯例（`-vl` / `-vision` 后缀专指多模态变体），与本模块「靠 id 判定」的
 * 前提一致；比逐个登记型号更能覆盖以后新出的变体。段边界（`^` / `-` / `/` 起，`-` / `.`
 * / 结尾止）用来避免误伤把这两个词当普通词素的名字。
 */
const EXPLICIT_VISION_MARKER = /(?:^|[-/])(?:vision|vl\d*)(?:[-.]|$)/i;

// DeepSeek V4.1 Flash supports native image input under these exact IDs.
const VISION_MODEL_IDS = new Set([
  'deepseek-flash',
  'deepseek/deepseek-flash',
  'deepseek-v4.1-flash',
  'deepseek/deepseek-v4.1-flash',
]);

/** 判定一个模型 id 的视觉能力（三态）。 */
export function classifyVisionCapability(model: string): VisionCapability {
  const id = normalizeVisionModelId(model);
  // 显式标记优先于家族级结论 —— 家族说「纯文本」，型号名说「我是视觉变体」时，后者更具体。
  if (EXPLICIT_VISION_MARKER.test(id)) return 'vision';
  if (VISION_MODEL_IDS.has(id.toLowerCase())) return 'vision';
  if (NO_VISION_ID_PREFIXES.some((p) => id.startsWith(p))) return 'no-vision';
  if (VISION_ID_PREFIXES.some((p) => id.startsWith(p))) return 'vision';
  return 'unknown';
}

/** 便捷判断：某模型 id 是否已知无视觉（供图片输入能力判断使用）。 */
export function isKnownNoVisionModel(model: string): boolean {
  return classifyVisionCapability(model) === 'no-vision';
}

/** 便捷判断：某模型 id 是否已知有视觉（视觉后端清单标注依据）。 */
export function isKnownVisionModel(model: string): boolean {
  return classifyVisionCapability(model) === 'vision';
}
