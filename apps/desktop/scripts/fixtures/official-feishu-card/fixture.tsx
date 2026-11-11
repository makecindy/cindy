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
  if (kind === 'empty-apps') {
    const base = view('coexist');
    base.feishu = { ...base.feishu, applications: [], bindings: [], binding: null, available: false };
    return base;
  }
  if (kind === 'working-long-name') {
    const base = view('coexist');
    base.feishu.bindings![1]!.workingDevice = { name: 'Design-Team-Office-Workstation-With-A-Very-Long-Computer-Name', isCurrent: false };
    return base;
  }
  if (kind === 'org-only' || kind === 'choose-bot' || kind === 'coexist-store-failed') {
    const base = view('coexist');
    if (kind === 'org-only') {
      base.feishu.applications = base.feishu.applications!.filter((app) => app.appType === 'self_built');
      base.feishu.bindings = base.feishu.bindings!.filter((account) => account.scopeId === 'cli_org');
      base.feishu.binding = base.feishu.bindings[0]!;
    } else if (kind === 'choose-bot') {
      base.feishu.binding = null;
      base.feishu.bindings = [];
    } else {
      base.feishu.binding = { ...view('pending').feishu.binding!, state: 'failed', reason: 'denied',
        bindCode: null, connectUrl: null, expiresAt: null, actions: ['retry'] };
    }
    return base;
  }
  if (kind === 'coexist' || kind === 'coexist-pending' || kind === 'coexist-error') {
    const base = view(kind === 'coexist-pending' ? 'store-pending' : 'store');
    const org = { ...base.feishu.bindings![0]!, bindingId: 'org-binding', scopeId: 'cli_org', principalName: '张三', tenantKey: null, workingDevice: { name: 'Team Workstation', isCurrent: false } };
    base.feishu.bindings = [...base.feishu.bindings!, org];
    base.feishu.applications = [
      { appId: 'cli_app', brand: 'feishu', appType: 'store', botName: 'Cindy', organization: 'org-example' },
      { appId: 'cli_org', brand: 'feishu', appType: 'self_built', botName: '团队 Cindy', organization: 'org-example', tenantName: '飞书示例企业' },
    ];
    if (kind === 'coexist-error') base.feishu = { ...base.feishu, status: 'error', lastError: 'TLS connection failed' };
    return base;
  }
  if (kind === 'store' || kind === 'store-pending' || kind === 'store-failed') {
    const base = view(kind === 'store' ? 'confirmed' : 'pending');
    const first = { ...view('confirmed').feishu.binding!, principalName: 'Alice', tenantKey: 'tenant-acme', tenantName: 'Acme' };
    base.feishu = { ...base.feishu, multiBindAvailable: true,
      bindings: [first, { ...first, bindingId: 'b2', principalId: 'ou_2', principalName: 'Bob', tenantKey: 'tenant-xd', tenantName: '示例工作室', workingDevice: { name: 'Office Windows PC', isCurrent: false } }] };
    if (kind === 'store-failed') base.feishu.binding = { ...base.feishu.binding!, state: 'failed',
      reason: 'access-denied', connectUrl: null, bindCode: null, expiresAt: null, actions: ['retry'] };
    return base;
  }

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
              ...(kind === 'confirmed' ? { workingDevice: { name: 'Cindy MacBook', isCurrent: true } } : {}),
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
