import { FeishuBotSection } from '../../../src/renderer/components/settings/FeishuBotSection';
import { mountPage, subscription, forbid } from '../../ui-page/harness';

// Exercise the real hook, host subscriptions and connection card without a live bot.
void mountPage({
  host: (ctx) => ({
    maker: {
      imDefaultSettingsGet: async () => ({
        agentKind: 'codex',
        agents: { codex: { model: 'gpt-example' } },
      }),
    },
    feishuBot: {
      getState: async () => ({
        status: ctx.data.status ?? 'error',
        error: ctx.data.error,
        appId: 'cli_example1234567890',
        appSecret: null,
        hasSecret: true,
        ownerOpenId: 'ou_example1234567890',
        lifecycleAnnouncement: false,
        service: 'feishu',
      }),
      reconnect: () => new Promise(() => {}),
      clear: forbid('feishuBot.clear'),
      onStatusChange: subscription('feishu-status'),
      onRegistrationStatus: subscription('feishu-registration'),
    },
  }),
  render: () => (
    <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
      <FeishuBotSection expanded onToggle={() => {}} />
    </div>
  ),
});
