/** A01: synthetic roster and sent messages; only reachable in the existing __DEV__ --mock provider. */
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';

export function groupMentionVisualFixture(channel: string, raw: unknown): unknown | undefined {
  const request = raw as { ref?: { collectionId?: string; id?: string } } | null;
  if (channel !== 'maker:remote-resources:get' || request?.ref?.collectionId !== BOT_GROUP_REMOTE_COLLECTION_ID || request.ref.id !== 'mention-qa') return undefined;
  const now = 1793250000000;
  const person = (id: string, name: string, role = 'member') => ({ botId: id, actorId: id, actorKind: 'human', name, role, status: 'active' });
  const mentions = { all: false, botIds: ['cindy', 'wang'] };
  const messages = [
    { id: 'own', authorKind: 'user', isSelf: true, content: '@小满 @王悦 看看这段正文，可以长按选择其中几个字。mail@小满.example 不是点名。' },
    { id: 'other', authorKind: 'user', isSelf: false, authorName: '王悦', content: '@小满 **请看看这个点名**，`@小满` 是代码。[普通链接](https://example.test) 保持原样。mail**@小满**.example 不是点名，@**小满** 可以。' },
    { id: 'ambiguous', authorKind: 'user', isSelf: true, mentions: { all: false, botIds: [] }, content: '@同名 @未知成员 不打开身份信息；@小满 可以。' },
    { id: 'broadcast', authorKind: 'user', isSelf: true, mentions: { all: true, allBots: true, botIds: [] }, content: '@所有人 @所有伙伴 是群体提及，不打开个人身份。' },
  ].map((message, index) => ({ sequence: index + 1, kind: 'message', authorBotId: null, authorName: '我', mentions,
    createdAt: now + index * 1000, ...message }));
  return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: 'mention-qa' },
    revision: '1', display: { title: '点名验收 · 模拟数据' }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: '', data: {
      id: 'mention-qa', name: '点名验收 · 模拟数据', serverBacked: true, replyMode: 'mentioned', speakingMode: 'auto',
      members: [
        { botId: 'cindy', actorId: 'cindy', actorKind: 'bot', name: '小满', nickname: '小满', displayName: 'Cindy',
          ownerName: '王悦', isOwned: false, avatar: 'cindy://avatar/preset/cindy', status: 'paused' },
        person('wang', '王悦', 'admin'), person('same-1', '同名'), person('same-2', '同名'),
      ], messages, plans: [], createdAt: now, updatedAt: now,
    } }],
  };
}
