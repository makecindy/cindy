/**
 * 群聊界面的纯展示逻辑：排序、成员名单、错误文案 key、轮次标记与分工（安排、下一步、
 * 交接文件）的判定。与组件分开，便于不挂 DOM 做单测。
 *
 * 判定本身与手机共用，正本在 `@cindy/maker-shared/botGroupPresentation`；这里只补
 * Desktop 自己的路由参数与 `bots.groupChat.*` 文案 key。
 */
import {
  BOT_GROUP_MAX_MEMBERS,
  BOT_GROUP_MIN_MEMBERS,
  type BotGroupErrorCode,
  type BotGroupNoticeCode,
} from '../../../shared/botGroupChat';
import { botGroupErrorVariant, botGroupNoticeVariant } from '@cindy/maker-shared/botGroupPresentation';

export {
  botGroupComposerPlanState,
  botGroupMemberNames,
  botGroupPathBasename,
  botGroupPlanFilePath,
  botGroupPlanFollowUp,
  botGroupPreviewLine,
  botGroupSidebarPlanPreview,
  continuableRoundEndId,
  currentBotGroupPlanStep,
  isActiveBotGroupMember,
  isBotGroupDivisionBlocked,
  isRunningBotGroupSidebarPreview,
  mergeBotGroupMessages,
  projectBotGroupExecutionFailures,
  mergeBotGroupPlans,
  openBotGroupPlan,
  sortBotGroups,
  type BotGroupComposerPlanState,
  type BotGroupPlanFollowUp,
  type BotGroupSidebarPlanPreview,
} from '@cindy/maker-shared/botGroupPresentation';

export { BOT_GROUP_MAX_MEMBERS, BOT_GROUP_MIN_MEMBERS };

/** Route query that opens the group settings drawer over the chat. */
export const BOT_GROUP_SETTINGS_PARAM = 'groupSettings';

/** Specific error copy when main names a cause the user can act on. */
export function botGroupErrorKey(errorCode: BotGroupErrorCode | null | undefined, fallback: string): string {
  const variant = botGroupErrorVariant(errorCode);
  return variant ? `bots.groupChat.errors.${variant}` : fallback;
}

export function botGroupNoticeKey(code: BotGroupNoticeCode | null, planScoped: boolean): string | null {
  const variant = botGroupNoticeVariant(code, planScoped);
  return variant ? `bots.groupChat.notice.${variant}` : null;
}
