/**
 * vision-bridge —— 视觉桥钩子类型（层 B）。
 *
 * 让纯文本模型（如 deepseek / glm 等不支持视觉的模型）获得看图能力：由 host 注入
 * 一个钩子，在用户贴图进 agent 前，用外部多模态 API 把图转成文字描述注入消息。
 *
 * 设计要点（对齐 docs/vision-bridge-design.md 层 B）：
 *  - 钩子可选。host 不注入（视觉桥未启用 / 未配置）时 session 完全跳过，字节级零干扰；
 *  - 钩子由 host 实现（读视觉桥配置、判定当前模型、调视觉通道、缓存、fallback、提示），
 *    maker-core 只负责「组装消息后、handle.send 前」调用一次；
 *  - 钩子必须不抛错（失败自己吞掉并原样返回），session 层仍做防御性兜底。
 */
import type { UserMessage } from './common.js';

/** 一张待视觉描述的用户图。 */
export interface VisionBridgeImage {
  /** 本地绝对路径（maker-core 贴图统一形态，见 common.ts UserContentBlock）。 */
  path: string;
  /** 可选 mimeType；缺省由后端猜。 */
  mimeType?: string;
}

/** 视觉桥钩子的返回：applied=false = 未生效，消息原样透传（零干扰契约）。 */
export interface VisionBridgeResult {
  /** 本次是否对这条消息生效（有图 + 命中启用组合 + 视觉桥可用）。 */
  applied: boolean;
  /** 替换后的消息（applied=true 时为描述注入后的版本；否则与入参相同）。 */
  message: UserMessage;
  /**
   * 可选提示（fallback 生效 / 视觉桥不可用等）。host 可据此发非终态事件；
   * 缺省时调用方不额外提示。
   */
  note?: string;
}

/**
 * 视觉桥钩子签名。ctx.model 是当前会话模型 id，host 据此判断「该模型是否需要视觉桥」
 * （是否在启用组合里 + 是否缺省视为纯文本）。ctx.signal 是本次 turn 的取消信号
 * （reservation abort），host 应把它传给视觉通道的 fetch，让 Stop/取消能中止视觉请求。
 */
export type VisionBridgeHook = (
  msg: UserMessage,
  ctx: { model: string; signal?: AbortSignal; sessionId?: string },
) => Promise<VisionBridgeResult>;
