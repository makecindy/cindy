import { REMOTE_RESOURCE_GET_CHANNEL, REMOTE_RESOURCE_LIST_CHANNEL, type RemoteCollectionListResponse } from '@cindy/device-link';
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';

// Synthetic, process-local data for the ordinary --mock sidebar entry. No account or writes.
const now = Date.now();
const ref = { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: 'visual-switch-group' };
const name = '伙伴协作测试群';
const groups = [{ ref, name }, {
  ref: { ...ref, id: 'visual-switch-group-second' }, name: '伙伴切换验证群',
}];
const members = [
  { botId: 'cindy-default', name: 'Cindy', status: 'active', avatar: 'cindy://avatar/preset/cindy' },
  { botId: 'visual-bot-lizi', name: 'LiZi', status: 'active', avatar: 'cindy://avatar/preset/lizi' },
];
const messages = Array.from({ length: 24 }, (_, index) => ({
  id: `visual-switch-message-${index}`, sequence: index + 1, kind: 'message',
  authorKind: index % 3 === 0 ? 'user' : 'bot',
  authorBotId: index % 3 === 0 ? null : members[index % 2].botId,
  authorName: index % 3 === 0 ? '测试用户' : members[index % 2].name,
  content: index === 23 ? '这是群聊的最后一条模拟消息。可以从任务列表来回切换，检查加载、滚动和输入框。'
    : index % 3 === 0 ? `第 ${index + 1} 条：请检查窄屏布局与侧栏切换。`
    : index % 3 === 1 ? '布局检查记录：\n\n| 场景 | 结果 |\n| --- | --- |\n| 竖屏 | 待检查 |\n| 横屏 | 待检查 |\n\n这是一组用于界面验收的合成消息。'
    : '下一步检查：\n\n1. 打开普通任务\n2. 从侧栏进入伙伴群聊\n3. 再次返回同一个群聊\n\n```ts\nconst ready = true;\n```',
  createdAt: now - (24 - index) * 60_000,
}));

export function groupSwitchVisualFixture(channel: string, raw: unknown): unknown {
  const request = raw as { collectionId?: string; ref?: { collectionId?: string; id?: string } } | undefined;
  if (channel === REMOTE_RESOURCE_LIST_CHANNEL && request?.collectionId === ref.collectionId) {
    return { collectionId: ref.collectionId, revision: 'visual-switch-2', items: groups.map((group, index) => ({ ref: group.ref,
      display: { title: group.name, preview: '普通任务与群聊切换 · 24 条模拟消息', timestamp: now - index, lastReplyAt: now - index },
      revision: 'visual-switch-1', links: [],
    })) } satisfies RemoteCollectionListResponse;
  }
  const group = groups.find(group => group.ref.id === request?.ref?.id);
  if (channel === REMOTE_RESOURCE_GET_CHANNEL && request?.ref?.collectionId === ref.collectionId && group) {
    return { ref: group.ref, revision: 'visual-switch-2', display: { title: group.name }, actions: [], links: [],
      blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: group.name,
        data: { id: group.ref.id, name: group.name, members, messages: group.ref.id === ref.id ? messages : messages.map((message, index) => ({
          ...message, id: `${group.ref.id}-${index}`,
          content: index === 23 ? '这是第二个群的消息，用于确认切换后没有残留第一个群的内容。' : message.content,
        })), plans: [], createdAt: now - 24 * 60_000, updatedAt: now } }],
    };
  }
  return undefined;
}
