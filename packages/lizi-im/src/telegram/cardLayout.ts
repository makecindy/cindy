/**
 * telegram/cardLayout.ts — Telegram 交互卡的**渲染布局/尺寸**参数(#1855 L1)。
 * ---------------------------------------------------------------------------
 * `buildCardPayload` 的**唯一** label/body 尺寸与排布阈值来源(传输层渲染)。
 *
 * **与 desktop 的语义模型分层,勿混**:`apps/desktop/src/main/im/shared/
 * interactionCardModel.ts`(#1925)是跨渠道的**语义层**单一出处(选项集 / 决策对象 /
 * header-body 拆分,含产品级 `BTN_LABEL_MAX=30` 截断)。本模块只管 @cindy/im 传输层
 * 把 `InteractiveCardSpec` 渲染成 Telegram HTML + inline keyboard 时的**物理尺寸**:
 * 按钮文案的 Telegram 硬上限、并排阈值、正文 HTML 截断长度。两者不同层、不同包
 * (`@cindy/im` 不得依赖 `apps/desktop`),故各持一份、名字刻意区分开。
 *
 * **刻意不采用官方旧 label60 / 正文4000** —— 那是待退役的服务端渲染栈的值, 合同
 * 明确不得成为共享参数源。本参数取个人车道现值(behavior-preserving: 64 / 12 /
 * 3800), 官方旧值不进来。不统一两侧 builder(hook 侧中立 buttonId、个人侧 inline
 * keyboard 排布各自保留 —— 参见合同 §B / §6)。
 */
export interface TelegramCardLayout {
  /** 按钮 label 截断上限(字符;Telegram 传输层硬上限)。 */
  buttonLabelMax: number;
  /** label 短于此值时允许两键并排。 */
  pairLabelMax: number;
  /** 卡片正文 HTML 截断上限(交由 capRenderedText 做标签栈安全闭合)。 */
  cardTextMax: number;
}

export const TELEGRAM_CARD_LAYOUT: TelegramCardLayout = {
  buttonLabelMax: 64,
  pairLabelMax: 12,
  cardTextMax: 3800,
};
