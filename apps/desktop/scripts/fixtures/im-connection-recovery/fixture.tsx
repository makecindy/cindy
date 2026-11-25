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

const idle = { kind: 'idle' };
const timedOut = { kind: 'error', reason: 'handshake timed out', code: 'network' };
const connected = { kind: 'connected', appId: '123456' };
/** New binding whose first save only times out; the identical retry connects. */
function timeoutThenConnect() {
  let calls = 0;
  return async (payload: { ownerUserId: string }) => {
    calls += 1;
    return calls === 1
      ? { status: timedOut, saveErrorStatus: timedOut, saveTimedOut: true, ownerUserId: null, botUsername: null }
      : { status: connected, ownerUserId: payload.ownerUserId, botUsername: 'example_bot' };
  };
}

void mountPage({
  host: (ctx) => ({
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
    telegramBot: ctx.data.saveTimeout
      ? {
          getStatus: async () => ({ status: idle, ownerUserId: null, botUsername: null }),
          setConfig: timeoutThenConnect(),
          onStatusChange: subscription('telegram-status'),
        }
      : {
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
        <div
          data-fixture={ctx.data.saveTimeout ? 'save-timeout' : undefined}
          className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]"
        >
          <Section expanded onToggle={() => {}} />
        </div>
      </ConfirmDialogProvider>
    );
  },
});
