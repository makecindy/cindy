/**
 * 群聊界面的纯展示逻辑：排序、成员名单、错误文案 key 与轮次标记。与组件分开，
 * 便于不挂 DOM 做单测。
 */
import {
  BOT_GROUP_MAX_MEMBERS,
  BOT_GROUP_MIN_MEMBERS,
  type BotGroupErrorCode,
  type BotGroupMemberView,
  type BotGroupMessageView,
  type BotGroupSummary,
} from '../../../shared/botGroupChat';

export { BOT_GROUP_MAX_MEMBERS, BOT_GROUP_MIN_MEMBERS };

/** Route query that opens the group settings drawer over the chat. */
export const BOT_GROUP_SETTINGS_PARAM = 'groupSettings';

/** Only active members can be mentioned, speak, or keep a group sendable. */
export function isActiveBotGroupMember(member: Pick<BotGroupMemberView, 'status'>): boolean {
  return member.status === 'active';
}

/** Latest activity first, like every other chat list. */
export function sortBotGroups(groups: readonly BotGroupSummary[]): BotGroupSummary[] {
  const activityAt = (group: BotGroupSummary) =>
    Math.max(group.lastMessage?.createdAt ?? 0, group.updatedAt, group.createdAt);
  return [...groups].sort(
    (left, right) => activityAt(right) - activityAt(left) || left.id.localeCompare(right.id),
  );
}

export function botGroupMemberNames(
  members: readonly Pick<BotGroupMemberView, 'name'>[],
  separator: string,
): string {
  return members
    .map((member) => member.name.trim())
    .filter(Boolean)
    .join(separator);
}

/** Collapse whitespace so a multi-line message fits a one-line preview. */
export function botGroupPreviewLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The only round-end that may offer 「继续讨论」: the newest one, and only while
 * main says the round can be continued.
 */
export function continuableRoundEndId(
  messages: readonly Pick<BotGroupMessageView, 'id' | 'kind'>[],
  round: { status: 'idle' | 'running'; canContinue: boolean },
): string | null {
  if (round.status !== 'idle' || !round.canContinue) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.kind === 'round-end') return message.id;
  }
  return null;
}

/** Merge an older page under the latest page, keyed by sequence. */
export function mergeBotGroupMessages(
  older: readonly BotGroupMessageView[],
  latest: readonly BotGroupMessageView[],
): BotGroupMessageView[] {
  const bySequence = new Map<number, BotGroupMessageView>();
  for (const message of older) bySequence.set(message.sequence, message);
  for (const message of latest) bySequence.set(message.sequence, message);
  return [...bySequence.values()].sort((a, b) => a.sequence - b.sequence);
}

const ERROR_KEYS: Partial<Record<BotGroupErrorCode, string>> = {
  MEMBER_LIMIT: 'bots.groupChat.errors.memberLimit',
  MEMBER_UNAVAILABLE: 'bots.groupChat.errors.memberUnavailable',
  NOT_FOUND: 'bots.groupChat.errors.notFound',
  HOST_NOT_READY: 'bots.groupChat.errors.hostNotReady',
};

/** Specific error copy when main names a cause the user can act on. */
export function botGroupErrorKey(errorCode: BotGroupErrorCode | null | undefined, fallback: string): string {
  return (errorCode && ERROR_KEYS[errorCode]) || fallback;
}
