// Official Feishu / Lark card states rendered through the real settings section.
import { HookConnectionsSection } from '../../../src/renderer/components/settings/HookConnectionsSection';
import { SettingsSearchNavigationContext } from '../../../src/renderer/components/settings/SettingsSearchNavigation';
import { mountPage, subscription } from '../../ui-page/harness';
import type { SlackHookView } from '../../../src/shared/hookControlIpc';

const disabledLane = {
  enabled: false,
  url: '',
  status: 'disabled' as const,
  lastError: null,
  available: false,
  capabilityPending: false,
  defaultWorkspace: null,
  binding: null,
};

function view(kind: string): SlackHookView {
  const feishu =
    kind === 'unavailable'
      ? { ...disabledLane, enabled: true, url: 'ws://127.0.0.1:8794', status: 'connected' as const }
      : kind === 'confirmed' || kind === 'revoked' || kind === 'released'
        ? {
            ...disabledLane,
            enabled: kind !== 'released',
            url: 'ws://127.0.0.1:8794',
            status: kind === 'released' ? 'disabled' as const : 'connected' as const,
            available: kind !== 'released',
            binding: {
              provider: 'feishu' as const,
              state: kind === 'confirmed' ? 'confirmed' as const : 'revoked' as const,
              attemptId: null,
              bindingId: 'b1',
              principalId: 'ou_1',
              principalName: '张三',
              scopeId: 'cli_app',
              scopeName: 'Cindy',
              connectUrl: null,
              bindCode: null,
              expiresAt: null,
              reason: null,
              remediationUrl: 'https://applink.feishu.cn/client/bot/open?appId=cli_app',
              actions: kind === 'confirmed' ? ['revoke', 'open_provider', 'select_device'] : ['retry'],
            },
          }
        : {
            ...disabledLane,
            enabled: true,
            url: 'ws://127.0.0.1:8794',
            status: 'connected' as const,
            available: true,
            binding: {
              provider: 'feishu' as const,
              state: 'pending' as const,
              attemptId: 'a1',
              bindingId: null,
              principalId: null,
              principalName: null,
              scopeId: 'cli_app',
              scopeName: 'Cindy',
              connectUrl:
                'https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=cli_app&redirect_uri=http%3A%2F%2Flocalhost%3A8794%2Fcb&state=s',
              bindCode: '7KQ4-M2XD',
              expiresAt: Date.now() + 600_000,
              reason: null,
              remediationUrl: null,
              actions: ['open_connect_url', 'copy_connect_url', 'copy_bind_code', 'cancel'],
            },
          };
  return {
    enabled: false,
    lifecycleAnnouncement: false,
    url: '',
    workspaces: {},
    status: 'disabled',
    lastError: null,
    binding: null,
    bindings: [],
    pendingBind: null,
    serverMultiTeam: false,
    telegram: disabledLane,
    x: disabledLane,
    feishu,
  };
}

void mountPage({
  host: (ctx) => ({
    hookControl: {
      get: async () => ({ hook: view(String(ctx.data.kind)) }),
      onStatusChanged: subscription('hook-status'),
      providerBindSelect: async () => ({ hook: view('confirmed') }),
      onPrefsChanged: subscription('hook-prefs'),
      onProviderPrefsChanged: subscription('hook-provider-prefs'),
      onWorkspaceProviderSourcesChanged: subscription('hook-sources'),
      getProviderWorkspacePrefs: async () => ({
        prefs: { provider: 'feishu', bindingId: null, scopeId: null, bound: false, prefs: [] },
      }),
      getWorkspaceProviderSources: async () => ({ entries: [] }),
    },
    maker: {
      imDefaultSettingsGet: async () => ({
        agentKind: 'codex',
        agents: { codex: { model: 'gpt-example' } },
        isCustomized: false,
        customizedKeys: [],
      }),
    },
  }),
  render: () => (
    <div className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
      <SettingsSearchNavigationContext.Provider
        value={{
          entry: {
            id: 'imBot.cindy.feishu',
            tab: 'im-bot',
            targetId: 'cindy-im-feishu',
            titleKey: 'settings.tina.prefs.providerFeishu',
            sectionKey: 'settings.imBot.groups.cindy',
          },
          activation: 1,
        }}
      >
        <HookConnectionsSection />
      </SettingsSearchNavigationContext.Provider>
    </div>
  ),
});
