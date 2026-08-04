import type { MessageRenderItem } from '@cindy/maker-shared/message-render';
import type { NormalizedRemoteMessage } from '@/session/messageNormalize';
import {
  type MobileMessageRenderItem,
} from '@/session/messageRenderModel';
import {
  buildMessageActionBarPresentation,
  countMessageRenderItemDiffs,
  isToolErrorLike,
  summarizeMessageBubblePresentation,
  summarizeTodoCardPresentation,
  summarizeToolGroupPresentation,
  summarizeToolRowPresentation,
  summarizeWorkGroupPresentation,
  todoStatusPresentation,
  type MessageActionBarItemId,
  type MessageActionBarPresentation,
  type MessageActionBarPresentationInput,
  type MessageBubbleDensity,
  type MessageBubblePresentation,
  type MessageBubblePresentationInput,
  type MessageFoldHeaderChevronPosition,
  type MessageFoldHeaderPresentation,
  type MessageFoldHeaderVariant,
  type TodoCardPresentation,
  type TodoStatusPresentation,
  type ToolGroupPresentation,
  type ToolRowPresentation,
  type ToolRowPresentationOptions,
  type ToolRowStatus,
  type WorkGroupPresentation,
} from '@cindy/maker-shared/message-presentation';

export {
  buildMessageActionBarPresentation,
  isToolErrorLike,
  summarizeMessageBubblePresentation,
  summarizeTodoCardPresentation,
  summarizeToolGroupPresentation,
  summarizeToolRowPresentation,
  summarizeWorkGroupPresentation,
  todoStatusPresentation,
  type MessageActionBarItemId,
  type MessageActionBarPresentation,
  type MessageActionBarPresentationInput,
  type MessageBubbleDensity,
  type MessageBubblePresentation,
  type MessageBubblePresentationInput,
  type MessageFoldHeaderChevronPosition,
  type MessageFoldHeaderPresentation,
  type MessageFoldHeaderVariant,
  type TodoCardPresentation,
  type TodoStatusPresentation,
  type ToolGroupPresentation,
  type ToolRowPresentation,
  type ToolRowPresentationOptions,
  type ToolRowStatus,
  type WorkGroupPresentation,
};

export function countMobileRenderItemDiffs(items: readonly MobileMessageRenderItem[]): number {
  // subagent_group 是 mobile-only item,shared 计数器不认;剔出后委托 shared,并递归累加子 agent 内层 diff。
  let nested = 0;
  const sharedItems: MessageRenderItem<NormalizedRemoteMessage>[] = [];
  for (const item of items) {
    if (item.type === 'subagent_group') {
      nested += countMobileRenderItemDiffs(item.childItems);
    } else if (item.type === 'fork_origin') {
      // 导航标记不含 diff payload。
    } else if (item.type === 'pending_send') {
      // 待发送气泡还没有正文以外的 payload(diff 由回流后的正式消息承载)。
    } else {
      sharedItems.push(item);
    }
  }
  return nested + countMessageRenderItemDiffs(sharedItems);
}
