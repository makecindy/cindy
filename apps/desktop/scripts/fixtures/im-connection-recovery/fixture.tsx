import { DiscordBotSection } from '../../../src/renderer/components/settings/DiscordBotSection';
import { TelegramBotSection } from '../../../src/renderer/components/settings/TelegramBotSection';
import { DingTalkBotSection } from '../../../src/renderer/components/settings/DingTalkBotSection';
import { WecomBotSection } from '../../../src/renderer/components/settings/WecomBotSection';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { mountPage, subscription } from '../../ui-page/harness';

const sections = {
  discord: DiscordBotSection,
  telegram: TelegramBotSection,
  dingtalk: DingTalkBotSection,
  wecom: WecomBotSection,
};
const pending = () => new Promise(() => {});
const status = { kind: 'error', reason: 'Temporary network failure', code: 'network' };
const ownerUserId = '12345678901234567';

void mountPage({
  host: () => ({
    maker: {
      imDefaultSettingsGet: async () => ({
        agentKind: 'codex',
        agents: { codex: { model: 'gpt-example' } },
      }),
    },
    discordBot: {
      getStatus: async () => ({ status, ownerUserId, lifecycleAnnouncement: false }),
      reconnect: pending,
      onStatusChange: subscription('discord-status'),
    },
    telegramBot: {
      getStatus: async () => ({ status, ownerUserId, botUsername: 'example_bot' }),
      setOnline: pending,
      onStatusChange: subscription('telegram-status'),
    },
    dingtalkBot: {
      getState: async () => ({ status, ownerUserId, appKey: 'example_app', hasSecret: true }),
      reconnect: pending,
      onStatusChange: subscription('dingtalk-status'),
      onOwnerChange: subscription('dingtalk-owner'),
    },
    wecomBot: {
      getStatus: async () => ({ status, ownerUserId, botId: 'example_bot' }),
      reconnect: pending,
      onStatusChange: subscription('wecom-status'),
    },
    wecomGroupNotification: { getState: async () => ({ configured: false, enabled: false }) },
  }),
  render: (ctx) => {
    const Section = sections[ctx.data.channel as keyof typeof sections];
    return (
      <ConfirmDialogProvider>
        <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
          <Section expanded onToggle={() => {}} />
        </div>
      </ConfirmDialogProvider>
    );
  },
});
