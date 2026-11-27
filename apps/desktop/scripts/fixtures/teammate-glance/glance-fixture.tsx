import { AppFrame, forbid, mountPage, subscription } from '../../ui-page/harness';
import { BotSessionContentHeaderRegistration } from '../../../src/renderer/features/bots/BotSessionContentHeader';

// Roster, device list and delegation hooks are replaced at build time (ui-page.mjs `stubs`); the
// header, 近况 popover, menus, toast, theme and translations are the production implementations.

mountPage({
  route: '/bots/cindy-default',
  host: () => ({
    maker: { onBotWorkbenchChanged: subscription('workbench') },
    deviceLink: { invoke: forbid('deviceLink.invoke'), onRemotePush: subscription('remote') },
    openPath: forbid('openPath'),
  }),
  render: (ctx) => (
    <AppFrame>
      <BotSessionContentHeaderRegistration
        bot={ctx.case === 'new'
          ? { id: 'bot-new', name: '葫芦', sessionId: 'chat-new', canonicalChat: true }
          : { id: 'cindy-default', name: 'Cindy', avatar: 'cindy://avatar/preset/cindy', templateId: 'cindy', sessionId: 'chat-1', canonicalChat: true }}
      />
      <div className="min-h-0 flex-1 p-6" data-ui-page-subject />
    </AppFrame>
  ),
});
