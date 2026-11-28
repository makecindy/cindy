/** Synthetic group with pasted GitHub and web links; only reachable in the existing __DEV__ --mock provider. */
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';

export function groupLinkVisualFixture(channel: string, raw: unknown): unknown | undefined {
  const request = raw as { ref?: { collectionId?: string; id?: string } } | null;
  if (channel !== 'maker:remote-resources:get' || request?.ref?.collectionId !== BOT_GROUP_REMOTE_COLLECTION_ID || request.ref.id !== 'link-qa') return undefined;
  const now = 1793250000000;
  const messages = [
    { id: 'prs', authorKind: 'user', isSelf: false, authorName: '王悦',
      content: '这两个修好了吗 https://github.com/makecindy/cindy/pull/13638 还有 https://github.com/makecindy/cindy/pull/7671' },
    { id: 'kinds', authorKind: 'user', isSelf: true, authorName: '我', content: [
      '相关的 issue https://github.com/makecindy/cindy/issues/12001',
      '提交 https://github.com/makecindy/cindy/commit/59acc54cbf7d088fa348f39ca8daca745fb65466',
      '代码在 https://github.com/makecindy/cindy/blob/main/apps/desktop/src/renderer/components/chat/PrLinkHoverPopover.tsx#L50-L60',
      '仓库 https://github.com/makecindy/cindy',
    ].join('\n') },
    { id: 'web', authorKind: 'user', isSelf: false, authorName: '王悦',
      content: '可以参考 https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/reviewing-changes-in-pull-requests/about-pull-request-reviews?tool=webui#about-pull-request-reviews ，以及[设计规范](https://example.com/design) 和 https://www.example.com/' },
  ].map((message, index) => ({ sequence: index + 1, kind: 'message', authorBotId: null,
    mentions: { all: false, botIds: [] }, createdAt: now + index * 60_000, ...message }));
  return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: 'link-qa' },
    revision: '1', display: { title: '外链验收 · 模拟数据' }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: '', data: {
      id: 'link-qa', name: '外链验收 · 模拟数据', serverBacked: true, replyMode: 'mentioned', speakingMode: 'auto',
      members: [
        { botId: 'wang', actorId: 'wang', actorKind: 'human', name: '王悦', role: 'admin', status: 'active' },
      ], messages, plans: [], createdAt: now, updatedAt: now,
    } }],
  };
}
