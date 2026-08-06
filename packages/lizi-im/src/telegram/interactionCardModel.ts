/**
 * telegram/interactionCardModel.ts — 交互卡纯语义参数(#1855 L1)。
 * ---------------------------------------------------------------------------
 * `buildCardPayload` 的**唯一** label/body 尺寸参数源。
 *
 * **刻意不采用官方旧 label60 / 正文4000** —— 那是待退役的服务端渲染栈的值, 合同
 * 明确不得成为共享参数源。本模型取个人车道现值(behavior-preserving: 64 / 12 /
 * 3800), 官方旧值不进来。
 *
 * 只共享**纯语义**(尺寸/排布阈值), 不统一两侧 builder: hook 侧的中立 buttonId 与
 * 本地化 payload、个人侧的 inline keyboard 排布各自保留 —— 参见合同 §B / §6。
 */
export interface InteractionCardModel {
  /** 按钮 label 截断上限(字符)。 */
  buttonLabelMax: number;
  /** label 短于此值时允许两键并排。 */
  pairLabelMax: number;
  /** 卡片正文 HTML 截断上限(交由 capRenderedText 做标签栈安全闭合)。 */
  cardTextMax: number;
}

export const INTERACTION_CARD_MODEL: InteractionCardModel = {
  buttonLabelMax: 64,
  pairLabelMax: 12,
  cardTextMax: 3800,
};
