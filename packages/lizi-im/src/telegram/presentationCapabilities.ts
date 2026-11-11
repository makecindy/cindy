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
   * 进度消息静音:过程帧**不额外**触发推送。个人栈**由设计兑现**而非独立开关 ——
   * 流式路径靠惰性占位 + editMessageText 覆盖(编辑不推送),没有单独带通知的
   * 过程消息;driver 无需再设 disable_notification。
   *
   * **不是"整轮零推送"**:惰性占位保证的是"没有真实内容就不建消息",而第一帧真实
   * 内容那次 sendMessage 会正常推送,之后的编辑才不推送。true 说的是"过程帧不额外
   * 推送",别把它读成用户整轮收不到通知。
   */
  progressSilent: boolean;
  /** typing 保活重发间隔(ms)。原生 typing 只持续 ~5s,按此值续命。driver 直接消费。 */
  typingKeepaliveMs: number;
  /**
   * typing 保活总上限(ms):超过即停发,turn 异常悬挂时不无限打 API。driver 直接消费。
   * 官方侧 10min + 设备在线门控是车道差异,跨服务端不在本仓兑现。
   */
  typingKeepaliveMaxMs: number;
  /**
   * link preview 关闭。driver 出站直接消费(LINK_PREVIEW_OPTIONS 单一出处)。
   *
   * **覆盖面是"答案这条路",不是全部出站**:正文/过程消息的发送、分段发送与编辑
   * (含 HTML 解析失败后的纯文本回落)都带上它;**卡片消息、rich 主路径
   * (`rich_message` payload)、陌生人提示、主人通知不带**。新增出站路径时要自己
   * 决定挂不挂,不会被这个字段自动覆盖。
   */
  linkPreviewDisabled: boolean;
  /**
   * NO_REPLY 哨兵生效范围。'all-turns' = 任何轮次(ambient 与非 ambient)命中哨兵都
   * 静默。个人栈**已是 all-turns**:`streamingText.finalize` 的 `isNoReply` 判定不带
   * ambient 门控(见 presentationCapabilities 契约测试与 streamingText 用例锚定)。
   *
   * **"零出站"只在惰性占位还没建过消息时成立**:哨兵前已经有正文流出、消息已经建
   * 出来的轮次,finalize 走的是**尽力撤回** —— `deleteMessage` 失败被 catch 吞掉,
   * 那条停在过程态的消息就留在聊天里。别把这个字段读成"用户一定看不到任何痕迹"。
   *
   * 官方仅 ambient 的差异是跨服务端 TODO。
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
