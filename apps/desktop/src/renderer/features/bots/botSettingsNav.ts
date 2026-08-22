/**
 * Anchor metadata for the Bot settings page. Kept out of BotsHomeView so the
 * anchor parsing / legacy deep-link fallback logic is unit-testable without
 * mounting the settings component tree.
 *
 * Batch β redesign (implementation map "设置缝合"): the seven-tab settings
 * page collapses into one scrollable page. There is no tab list anymore;
 * `?tab=<id>` becomes `?anchor=<id>`, and old bookmarked
 * `?settings=1&tab=<value>` links must keep landing somewhere sane rather
 * than a blank panel.
 *
 * 页面从上到下:「TA 是谁」(who) /「TA 会的」(can) /「TA 懂的」(understand) /
 * 成长两块 (grew,内含「TA 记得的」「TA 学会的」) /「TA 的日程」(schedule),
 * 外加一个内联展开的「高级」(advanced)。**一块讲一件事** —— 成长两块原来挤在
 * 「TA 是谁」的下半截,那张卡因此装了六件事而隔壁「TA 懂的」只装一个按钮,
 * 卡片规格一样重、信息量差六倍,页面读起来上面一坨下面空荡。
 */
export const BOT_SETTINGS_ANCHOR_IDS = [
  'who',
  'can',
  'understand',
  // 「TA 记得的 / TA 学会的」从「TA 是谁」里搬出来独立成块之后需要自己的落点:
  // 成长尾注的深链原来滚到 `who`,那时两个列表就挂在那张卡的下半截。现在滚到
  // `who` 会停在头像那一行,列表在一屏之外 —— 所以新增这个锚点。
  'grew',
  'schedule',
  'advanced',
] as const;

export type BotSettingsAnchorId = (typeof BOT_SETTINGS_ANCHOR_IDS)[number];

export function isBotSettingsAnchor(
  value: string | null | undefined,
): value is BotSettingsAnchorId {
  return typeof value === 'string' && (BOT_SETTINGS_ANCHOR_IDS as readonly string[]).includes(value);
}

/**
 * The seven pre-batch-β tab ids, mapped to the block that absorbed their
 * content. `capabilities` (the old toggle-detail tab) and `notifications`
 * (the old event-inbox tab) both moved into Advanced — there is no longer a
 * dedicated top-level block for either.
 */
const LEGACY_TAB_TO_ANCHOR: Record<string, BotSettingsAnchorId> = {
  identity: 'who',
  channels: 'can',
  capabilities: 'advanced',
  automation: 'schedule',
  notifications: 'advanced',
  projects: 'understand',
  advanced: 'advanced',
};

/**
 * Resolves a `?tab=`/`?anchor=` query value to a scroll target.
 *
 * `null` means "top of page" — used for a missing value (`?settings=1` alone,
 * batch α's entry points) and for any value that is neither a current anchor
 * id nor a recognized legacy tab id. This intentionally never throws and
 * never falls back to a single hardcoded section: an unrecognized value is
 * not an error, it is just "no particular place to jump to".
 */
export function resolveBotSettingsAnchor(value: string | null | undefined): BotSettingsAnchorId | null {
  if (!value) return null;
  if (isBotSettingsAnchor(value)) return value;
  return LEGACY_TAB_TO_ANCHOR[value] ?? null;
}

/**
 * 批次 ε:消息气泡尾注点进设置时,除了滚到成长那一段,还要告诉页面**高亮哪一个
 * 列表** —— 「TA 记得的」还是「TA 学会的」。走 query 参数(而不是路由 state)是为了
 * 深链、刷新、复制链接都一致,并且与既有的 `?settings=1&anchor=` 同一套机制。
 */
export type BotSettingsHighlightId = 'memory' | 'learned';

export function resolveBotSettingsHighlight(
  value: string | null | undefined,
): BotSettingsHighlightId | null {
  return value === 'memory' || value === 'learned' ? value : null;
}

/** 尾注的跳转目标:滚到两个成长列表那一段,并高亮其中对应的那个。 */
export function buildBotGrowthSettingsPath(
  botId: string,
  highlight: BotSettingsHighlightId,
): string {
  return `/bots/${encodeURIComponent(botId)}?settings=1&anchor=grew&highlight=${highlight}`;
}

/*
 * 这里原来还有一张 `BOT_SETTINGS_ANCHORS`(id + labelKey + icon),自称「用于区块
 * 标题图标」。实际上图标一直是各区块自己写死的,**这张表在生产代码里一个消费方
 * 都没有** —— 它只是自己在被自己的测试测,还顺带绑了一条
 * 「labelKey 必须是 bots.settingsBlocks.<id>」的规矩,反过来卡住新增滚动锚点。
 * 一并删掉。将来真需要一份带标题的区块清单时再按当时的用途重建。
 */
