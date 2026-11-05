/**
 * Synthetic shared group for the existing __DEV__ visual-mock provider (never an account or a live bot):
 * open /companions/groups/settings-qa?deviceId=cindy-visual-mock-mac to see its settings as the owner.
 * Writes change this in-memory copy only and are gone on restart.
 */
import { BOT_GROUP_CHAT_PRIMITIVE, BOT_GROUP_REMOTE_COLLECTION_ID, BOT_GROUP_REMOTE_RESOURCE_KIND } from '@cindy/maker-shared/botGroupChat';

const NOW = 1793250000000;
const person = (id: string, name: string, role: string, isSelf = false) => ({ botId: id, actorId: id, actorKind: 'human', name, avatar: '', isSelf, isOwned: isSelf, role, status: 'active' });
const teammate = (id: string, name: string, owned: boolean, avatar: string) => ({ botId: id, actorId: id, actorKind: 'bot', name, avatar, isOwned: owned, role: 'member', status: 'active', guestAccess: 'chat' });
let group = {
  id: 'settings-qa', name: 'Cindy 讨论', topic: 'Cindy 产品与群聊体验', serverBacked: true, supportsSettingsManagement: true,
  supportsMentionAudiences: true, allowMentionAllBots: true,
  supportsMemberRemoval: true, supportsListRemoval: true, supportsGroupLeave: true, supportsDissolve: true, selfActorId: 'qa-me', revision: 3,
  description: '讨论 Cindy 的产品方向、群聊体验和伙伴协作。\n提问时 @ 对应的伙伴；要写代码的事交给负责人安排分工，会在项目文件夹里新开分支。',
  replyMode: 'mentioned', speakingMode: 'auto', organizerBotId: 'qa-cindy', projectDir: null, projectDirName: 'cindy', archived: false,
  members: [person('qa-me', 'chris', 'owner', true), teammate('qa-cindy', 'Cindy', true, 'cindy://avatar/preset/cindy'),
    person('qa-wang', '王悦', 'admin'), teammate('qa-lizi', 'LiZi (王悦)', false, 'cindy://avatar/preset/lizi'),
    person('qa-lin', '林夏', 'member'), person('qa-nana', 'Nana', 'member'), person('qa-zhou', '周屿', 'member')],
};

export function groupSettingsVisualFixture(channel: string, raw: unknown): unknown {
  const request = raw as { ref?: { id?: string }; resourceRef?: { id?: string }; actionId?: string; input?: Record<string, unknown> };
  if ((request?.ref?.id ?? request?.resourceRef?.id) !== 'settings-qa') return undefined;
  if (channel === 'maker:remote-resources:get') return {
    ref: { collectionId: BOT_GROUP_REMOTE_COLLECTION_ID, kind: BOT_GROUP_REMOTE_RESOURCE_KIND, id: 'settings-qa' }, revision: String(group.revision),
    display: { title: group.name }, actions: [], links: [],
    blocks: [{ id: 'chat', primitive: BOT_GROUP_CHAT_PRIMITIVE, fallbackMarkdown: group.description, data: {
      ...group, plans: [], createdAt: NOW, updatedAt: NOW,
      messages: [{ id: 'qa-1', sequence: 1, kind: 'message', authorKind: 'user', authorBotId: 'qa-wang', authorName: '王悦', isSelf: false,
        content: '@Cindy 群设置这版看一下手机上的效果。', createdAt: NOW }],
    } }],
  };
  if (channel !== 'maker:remote-resources:invoke') return undefined;
  const input = request.input ?? {};
  if (request.actionId === 'update') {
    const { expectedRevision: _revision, ...change } = input;
    group = { ...group, ...change, revision: group.revision + 1 };
  } else if (request.actionId === 'remove-member') group = { ...group, members: group.members.filter(member => member.actorId !== input.actorId), revision: group.revision + 1 };
  else if (request.actionId === 'delete') group = { ...group, archived: true, revision: group.revision + 1 };
  return { effects: [] };
}
