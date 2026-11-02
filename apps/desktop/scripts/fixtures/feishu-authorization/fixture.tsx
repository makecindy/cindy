import { FeishuBotSection } from '../../../src/renderer/components/settings/FeishuBotSection';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { mountPage, subscription } from '../../ui-page/harness';

void mountPage({
  host: () => ({
    maker: {
      imDefaultSettingsGet: async () => ({
        agentKind: 'codex',
        agents: { codex: { model: 'gpt-example' } },
      }),
    },
    feishuBot: {
      getState: async () => ({
        service: 'feishu',
        status: 'idle',
        hasSecret: false,
        appId: null,
        appSecret: null,
        ownerOpenId: null,
        lifecycleAnnouncement: false,
      }),
      onStatusChange: subscription('feishu-status'),
      onRegistrationStatus: subscription('feishu-registration'),
      registrationBegin: async (service: string) => ({
        ok: true,
        verificationUrl:
          service === 'lark'
            ? 'https://open.larksuite.com/page/cli?user_code=CINDY-TEST'
            : 'https://open.feishu.cn/page/cli?user_code=CINDY-TEST',
        userCode: 'CINDY-TEST',
        expiresIn: 300,
      }),
      registrationCancel: async () => ({ ok: true }),
    },
    openExternal: async () => {},
  }),
  render: (ctx) => (
    <ConfirmDialogProvider>
      <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
        <FeishuBotSection
          expanded
          onToggle={() => {}}
          preferredService={ctx.data.lark ? 'lark' : 'feishu'}
        />
      </div>
    </ConfirmDialogProvider>
  ),
});
