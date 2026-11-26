// Official Discord card states rendered through the real settings section.
import { HookConnectionsSection } from '../../../src/renderer/components/settings/HookConnectionsSection';
import { SettingsSearchNavigationContext } from '../../../src/renderer/components/settings/SettingsSearchNavigation';
import { mountPage, subscription } from '../../ui-page/harness';
import type { ProviderHookView, SlackHookView } from '../../../src/shared/hookControlIpc';

const APP_ID = '100000000000000001';

const disabledLane: ProviderHookView = {
  enabled: false,
  url: '',
  status: 'disabled',
  lastError: null,
  available: false,
  capabilityPending: false,
  defaultWorkspace: null,
  binding: null,
};

const pendingBinding: NonNullable<ProviderHookView['binding']> = {
  provider: 'discord',
  state: 'pending',
  attemptId: 'a1',
  bindingId: null,
  principalId: null,
  principalName: null,
  scopeId: APP_ID,
  scopeName: null,
  connectUrl: `https://discord.com/oauth2/authorize?client_id=${APP_ID}`,
  bindCode: 'K7Q4-M2XD',
  expiresAt: Date.now() + 600_000,
  reason: null,
  remediationUrl: null,
  actions: ['copy_bind_code', 'open_connect_url', 'copy_connect_url', 'cancel'],
};

function discord(kind: string): ProviderHookView {
  const live = { ...disabledLane, enabled: true, url: 'wss://telegram-hook.cindy.app/discord', status: 'connected' as const, available: true };
  if (kind === 'confirmed') {
    return { ...live, binding: { ...pendingBinding, state: 'confirmed', attemptId: null, bindingId: 'b1',
      principalId: '200000000000000002', principalName: 'cindy_user', connectUrl: null, bindCode: null,
      expiresAt: null, actions: ['revoke', 'open_provider', 'add_to_group'] } };
  }
  if (kind === 'awaiting') {
    return { ...live, binding: { ...pendingBinding, state: 'awaiting_confirmation', principalId: '200000000000000002',
      principalName: 'cindy_user', connectUrl: null, bindCode: null, actions: ['cancel'] } };
  }
  if (kind === 'unavailable') return { ...live, available: false };
  if (kind === 'disabled') return { ...disabledLane, url: 'wss://telegram-hook.cindy.app/discord' };
  return { ...live, binding: pendingBinding };
}

function view(kind: string): SlackHookView {
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
    feishu: disabledLane,
    discord: discord(kind),
  };
}

void mountPage({
  host: (ctx) => ({
    hookControl: {
      get: async () => ({ hook: view(String(ctx.data.kind)) }),
      onStatusChanged: subscription('hook-status'),
      onSharedProjectPrefsChanged: subscription('hook-shared-prefs'),
      onWorkspaceProviderSourcesChanged: subscription('hook-sources'),
      getSharedProjectPrefs: async () => ({ prefs: { prefs: [] } }),
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
            id: 'imBot.cindy.discord',
            tab: 'im-bot',
            targetId: 'cindy-im-discord',
            titleKey: 'settings.tina.prefs.providerDiscord',
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
