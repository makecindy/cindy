import { useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import { ChatGroupSettings } from '../../../src/renderer/features/bots/ChatGroupSettings';
import type { BotGroupSummary, ChatGroupAction, ChatGroupNotificationMode } from '../../../src/shared/botGroupChat';

let manage: (input: { action: ChatGroupAction }) => Promise<{ ok: boolean; errorCode?: string }> = async () => ({ ok: true });
function Preview({ variant }: { variant: string }) {
  const [mode, setMode] = useState<ChatGroupNotificationMode>(variant === 'mentions' ? 'mentions' : variant === 'none' ? 'none' : 'all');
  manage = async ({ action }) => {
    if (action.type !== 'notifications') throw new Error('Unexpected fixture mutation');
    if (variant === 'failure') return { ok: false, errorCode: 'REQUEST_FAILED' };
    if (variant === 'saving') return new Promise(() => {});
    setMode(action.mode); return { ok: true };
  };
  const group = {
    id: 'notification-fixture', name: 'Design team', serverBacked: true, supportsNotificationSettings: true,
    notificationMode: mode, selfActorId: 'me', revision: 1, replyMode: 'all', speakingMode: 'auto',
    members: [{ actorId: 'me', botId: 'me', actorKind: 'human', isSelf: true, isOwned: true,
      name: 'Alex', displayName: 'Alex', role: 'member' }],
  } as BotGroupSummary;
  return <ChatGroupSettings group={group} />;
}
mountPage({
  route: '/bots/groups/notification-fixture',
  host: { maker: { chatServer: { ownedBots: async () => ({ ok: true, bots: [] }), manage: input => manage(input) } } },
  render: ctx => <Preview variant={ctx.case} />,
});
