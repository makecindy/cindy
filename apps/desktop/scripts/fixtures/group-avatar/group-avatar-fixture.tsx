import { mountPage, forbid } from '../../ui-page/harness';
import { ChatGroupSettings } from '../../../src/renderer/features/bots/ChatGroupSettings';
import type { BotGroupSummary } from '../../../src/shared/botGroupChat';

const group = {
  id: 'group-avatar-fixture', name: 'Design team', serverBacked: true, supportsMemberAvatar: true,
  revision: 1, replyMode: 'all', speakingMode: 'auto', selfActorId: 'me',
  members: [
    { actorId: 'me', botId: 'me', actorKind: 'human', isSelf: true, isOwned: true,
      name: 'Nana', displayName: 'Nana', role: 'member', groupAvatar: null, avatarUrl: null },
    { actorId: 'peer', botId: 'peer', actorKind: 'human', name: 'Alex', displayName: 'Alex', role: 'owner' },
  ],
} as BotGroupSummary;

mountPage({
  route: '/bots/groups/group-avatar-fixture',
  host: {
    maker: { chatServer: { ownedBots: async () => ({ ok: true, bots: [] }), manage: forbid('chatServer.manage') } },
    profileGetState: forbid('profileGetState'),
    profileUpdate: forbid('profileUpdate'),
  },
  render: () => <ChatGroupSettings group={group} />,
});
