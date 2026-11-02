import { useEffect } from 'react';
import { mountPage, forbid } from '../../ui-page/harness';
import { ChatInviteDialog } from '../../../src/renderer/features/bots/ChatInviteDialog';
import { BotGroupCreateDialog } from '../../../src/renderer/features/bots/BotGroupCreateDialog';
import accountAvatar from '../../../src/renderer/assets/cindy-avatar-account.png';

const members = [
  { botId: 'preview-bot', name: 'Cindy', avatar: 'cindy://avatar/preset/cindy', avatarColor: 'violet', status: 'active' as const },
  { botId: 'preview-user', name: 'Alex', avatar: '', avatarUrl: 'https://example.invalid/avatar/alex.png', avatarColor: 'graphite', status: 'active' as const, isSelf: true },
];

// The isolated HTTP fixture has no secure-context randomUUID.
if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => '00000000-0000-4000-8000-000000000001' });

function CreatePreview({ invalid }: { invalid: boolean }) {
  useEffect(() => {
    if (!invalid) return;
    const frame = requestAnimationFrame(() => document.querySelector<HTMLFormElement>('[role="dialog"] form')?.requestSubmit());
    return () => cancelAnimationFrame(frame);
  }, [invalid]);
  return <BotGroupCreateDialog privateChatBotId="preview-bot" onOpenChange={() => {}} onCreated={() => {}} />;
}

mountPage({
  host: ctx => ({ maker: {
    resolveCompanionAvatar: async () => accountAvatar,
    createBotGroup: forbid('maker.createBotGroup'),
    chatServer: {
      status: async () => ({ enabled: true }),
      createInvite: async () => ctx.case === 'loading' ? new Promise(() => {})
        : ctx.case === 'failed' ? { ok: false, errorCode: 'REQUEST_FAILED' }
        : { ok: true, link: 'https://example.invalid/invite/preview', expiresAt: null, reusable: true },
      revokeInvite: forbid('chatServer.revokeInvite'),
    },
  } }),
  render: ctx => ctx.case === 'create' || ctx.case === 'name-error'
    ? <CreatePreview invalid={ctx.case === 'name-error'} />
    : <ChatInviteDialog groupId="preview-group" created={ctx.case === 'default'} members={members} onClose={() => {}} />,
});
