/**
 * Anchor metadata for the Bot settings page. Kept out of BotsHomeView so the
 * anchor parsing / legacy deep-link fallback logic is unit-testable without
 * mounting the settings component tree.
 *
 * Batch β redesign (implementation map "设置缝合"): the seven-tab settings
 * page collapses into one scrollable page with four blocks — "TA 是谁" (who),
 * "TA 会的" (can), "TA 懂的" (understand), "TA 的日程" (schedule) — plus a
 * single "高级" (advanced) section that expands inline. There is no tab list
 * anymore; `?tab=<id>` becomes `?anchor=<id>`, and old bookmarked
 * `?settings=1&tab=<value>` links must keep landing somewhere sane rather
 * than a blank panel.
 */
import {
  Clock3,
  FolderGit2,
  Settings2,
  Sparkles,
  UserRound,
  type LucideIcon,
} from 'lucide-react';

export const BOT_SETTINGS_ANCHOR_IDS = ['who', 'can', 'understand', 'schedule', 'advanced'] as const;

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
 * 批次 ε:消息气泡尾注点进设置时,除了滚到「TA 是谁」,还要告诉页面**高亮哪一个
 * 列表** —— 「TA 记得的」还是「TA 学会的」。走 query 参数(而不是路由 state)是为了
 * 深链、刷新、复制链接都一致,并且与既有的 `?settings=1&anchor=` 同一套机制。
 */
export type BotSettingsHighlightId = 'memory' | 'learned';

export function resolveBotSettingsHighlight(
  value: string | null | undefined,
): BotSettingsHighlightId | null {
  return value === 'memory' || value === 'learned' ? value : null;
}

/** 尾注的跳转目标:滚到「TA 是谁」并高亮对应列表。 */
export function buildBotGrowthSettingsPath(
  botId: string,
  highlight: BotSettingsHighlightId,
): string {
  return `/bots/${encodeURIComponent(botId)}?settings=1&anchor=who&highlight=${highlight}`;
}

export interface BotSettingsAnchorMeta {
  id: BotSettingsAnchorId;
  labelKey: string;
  icon: LucideIcon;
}

/** Block order top-to-bottom on the page; used for heading icons. */
export const BOT_SETTINGS_ANCHORS: BotSettingsAnchorMeta[] = [
  { id: 'who', labelKey: 'bots.settingsBlocks.who', icon: UserRound },
  { id: 'can', labelKey: 'bots.settingsBlocks.can', icon: Sparkles },
  { id: 'understand', labelKey: 'bots.settingsBlocks.understand', icon: FolderGit2 },
  { id: 'schedule', labelKey: 'bots.settingsBlocks.schedule', icon: Clock3 },
  { id: 'advanced', labelKey: 'bots.settingsBlocks.advanced', icon: Settings2 },
];
