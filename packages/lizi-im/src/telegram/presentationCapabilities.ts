/**
 * telegram/presentationCapabilities.ts — 个人 Telegram driver 的呈现能力契约(#1855 L1)。
 * ---------------------------------------------------------------------------
 * **单一真相源**:需要真正出站 / 渠道能力才能兑现的呈现策略与车道差异。合同要求
 * "不能只留声明/TODO" —— 本模块的值由**同包 driver(index.ts)真正消费**:typing
 * 续命间隔/上限、link preview 关闭都直接引用这里,不再各写字面量;desktop 侧
 * `turnPresenter` 再从 `@cindy/im` re-export(依赖方向 desktop → @cindy/im,不成环),
 * 作为 L1 呈现层的能力声明锚。
 *
 * **不含 replyQuote**:emoji / replyQuoteGroup / replyQuoteDm 三档继续由各车道的
 * `TelegramBehaviorConfig` 三字段直接供给,不进入本能力契约、不带出厂默认
 * (#1855 replyQuote 勘误)。
 */
export interface TelegramDriverCapabilities {
  /**
   * 进度消息静音:过程帧不触发推送。个人栈**由设计兑现**而非独立开关 ——
   * 流式路径靠惰性占位 + editMessageText 覆盖(编辑不推送),没有单独带通知的
   * 过程消息。true 表示"过程帧零推送"这一既有性质;driver 无需再设 disable_notification。
   */
  progressSilent: boolean;
  /** typing 保活重发间隔(ms)。原生 typing 只持续 ~5s,按此值续命。driver 直接消费。 */
  typingKeepaliveMs: number;
  /**
   * typing 保活总上限(ms):超过即停发,turn 异常悬挂时不无限打 API。driver 直接消费。
   * 官方侧 10min + 设备在线门控是车道差异,跨服务端不在本仓兑现。
   */
  typingKeepaliveMaxMs: number;
  /** link preview 关闭覆盖面:true = 全档关闭(个人现状)。driver 出站直接消费。 */
  linkPreviewDisabled: boolean;
  /**
   * NO_REPLY 哨兵生效范围。'all-turns' = 任何轮次(ambient 与非 ambient)命中哨兵都
   * 静默。个人栈**已是 all-turns**:`streamingText.finalize` 的 `isNoReply` 判定不带
   * ambient 门控,任何轮次的整条 NO_REPLY 都撤占位、零出站(见 presentationCapabilities
   * 契约测试与 streamingText 用例锚定)。官方仅 ambient 的差异是跨服务端 TODO。
   */
  noReplyScope: 'all-turns' | 'ambient-only';
  /** 官方 DM 终稿特效(messageEffectId):官方装饰位,个人无。声明车道差异。 */
  messageEffectIdSupported: boolean;
  /**
   * threadId 双语义:"投递位置"= 裸 thread_id;"归属"= is_topic_message 门控
   * (见 parseCallbackQuery)。普通群 reply 链回流错桶靠 desktop 读取侧兜住。声明车道差异。
   */
  threadIdDualSemantics: boolean;
  /** lane 模型:per-principal(官方) vs per-chat(个人)。声明车道差异。 */
  laneModel: 'per-principal' | 'per-chat';
}

/**
 * 个人 Telegram 车道当前能力基线。**不是官方默认**,不得跨服务端套用。
 * 本常量的可兑现字段由 index.ts 直接消费(单源);声明字段由契约测试锚定。
 */
export const TELEGRAM_PERSONAL_CAPABILITIES: TelegramDriverCapabilities = {
  progressSilent: true,
  typingKeepaliveMs: 4_500,
  typingKeepaliveMaxMs: 5 * 60_000,
  linkPreviewDisabled: true,
  noReplyScope: 'all-turns',
  messageEffectIdSupported: false,
  threadIdDualSemantics: true,
  laneModel: 'per-chat',
};
