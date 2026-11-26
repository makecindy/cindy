import { BUNDLED_CATALOG, buildUserProvider, type ProviderView } from '@cindy/model-providers';
import { ProvidersSection } from '../../../src/renderer/components/settings/ProvidersSection';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import { mountPage, subscription, forbid, ctx } from '../../ui-page/harness';

// One set of computers fed to both the real Settings page and the real model picker.
const provider = (id: string, account?: string, extra: Partial<ProviderView> = {}): ProviderView => ({
  ...BUNDLED_CATALOG.providers.find(item => item.id === id)!,
  connected: true, remoteInvocationEnabled: true,
  ...(account ? { subscriptionAccountKeys: [account] } : {}),
  ...extra,
} as ProviderView);
// Every source has a selectable model, so the picker can list each one Settings lists.
const fable = { 'claude-code': [{ id: 'claude-fable', name: 'Fable', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high', defaultEnabled: true }] };
const anthropic = () => provider('anthropic', 'account-c', { models: fable } as Partial<ProviderView>);
const local = [provider('openai', 'account-a'), anthropic()];
const catalogs = new Map([
  // Same Anthropic login as this computer: listed once, under this computer.
  ['rog', { providers: [anthropic(), provider('xai')], loading: false, error: null }],
  // A different OpenAI login stays; the same xAI as ROG is listed once.
  ['mini', { providers: [provider('openai', 'account-b'), provider('xai')], loading: false, error: null }],
]);
// Hiding is a picker-only choice: Settings keeps the row, the picker folds it under 已隐藏.
if (ctx.case.startsWith('hidden-provider')) {
  local[1] = { ...anthropic(), hidden: true };
  // A disabled provider too, so Settings shows both folded groups side by side.
  local.push(provider('anthropic', 'account-d', { id: 'anthropic-work', name: 'Anthropic · Work', models: fable, suspended: true } as Partial<ProviderView>));
  catalogs.clear();
  catalogs.set('mini', { providers: [provider('xai')], loading: false, error: null });
}
if (ctx.case === 'connection-icons') {
  local.splice(0, local.length, ...(['personal', 'work'] as const).map(logoKind => ({
    ...buildUserProvider({
      id: `glm-${logoKind}`, name: logoKind === 'personal' ? '智谱 · 个人版' : '智谱 · 企业版',
      runtimes: { codex: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', models: [{ id: 'glm', name: 'GLM' }] } },
    }),
    connected: true, logoKind,
  })));
  catalogs.clear();
}
if (ctx.case === 'same-account-twice-here') local.push(provider('openai', 'account-a', { id: 'openai-old', name: 'OpenAI · old connection' }));
// Providers that plugins offer (plugin engines): one still in the picker, one hidden, one turned off.
const engine = (key: string, name: string, extra: Record<string, unknown> = {}) => ({
  key, providerId: `acp-plugin:${key}`, ghostId: key.split(':')[0], harnessId: key.split(':')[1], name,
  availability: { state: 'available' }, permissionModes: [{ id: 'ask', displayName: 'Ask' }], defaultPermissionMode: 'ask',
  models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro' }, { id: 'deepseek-flash', displayName: 'DeepSeek Flash' }],
  remoteUse: { supported: true, enabled: true, shareSupported: true }, ...extra,
});
// A plugin's own icon (manifest `icon`, read by main into a data URL); without one the generic mark is drawn.
const PLUGIN_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='royalblue'/%3E%3Cpath d='M9 16h14M16 9v14' stroke='white' stroke-width='3' stroke-linecap='round'/%3E%3C/svg%3E";
const pluginEngines = ctx.case === 'plugin-providers' ? [
  engine('dsh-plugin:dsh', 'Work DeepSeek', {
    declaredName: 'DeepSeek Harness', reportsUsage: true, iconDataUrl: PLUGIN_ICON,
    models: [{ id: 'deepseek-v4', displayName: 'DeepSeek-V4-Pro' }],
    disabledModels: [{ id: 'deepseek-flash', displayName: 'DeepSeek Flash' }],
  }),
  engine('agy-plugin:agy', 'Antigravity', { hidden: true, remoteUse: { supported: false, enabled: false } }),
  engine('zcode-plugin:zcode', 'ZCode', { suspended: true, availability: { state: 'unavailable', reason: 'suspended' } }),
] : [];
const devices = [{ deviceId: 'rog', name: 'ROG', platform: 'win32' }, { deviceId: 'mini', name: 'Mac mini', platform: 'darwin' }];
const snapshot = { providers: local, providerOrder: local.map(item => item.id), ownerGeneration: 1, loading: false, error: null, refetch: async () => {} };
Object.assign(window, { listingFixture: { snapshot, devices, catalogs },
  // The reused Settings stubs read received shares from here.
  providerSourcesFixture: { received: { received: [], loaded: true } } });

mountPage({
  route: '/settings?tab=providers',
  host: {
    subscriptionAccounts: { command: async ({ providerId }: { providerId: string }) => ({ providerId, configured: false, strategy: 'expiring', accounts: [] }), onChanged: subscription('subscriptionAccountsChanged') },
    maker: {
      listProviders: async () => snapshot,
      scanLocalCli: async () => ({ detections: [] }),
      requestProviderModelsAutoRefresh: async () => ({ ok: true }),
      setProviderOrder: forbid('setProviderOrder'),
      listProviderPresets: async () => ({ presets: BUNDLED_CATALOG.presets ?? [] }),
      localModelList: async () => ({ status: { kind: 'ready' }, models: [], memoryGb: 0 }),
      localModelStatus: async () => ({ kind: 'ready' }),
      onLocalModelStatus: subscription('localModelStatus'),
      onProviderOAuthProgress: subscription('providerOAuthProgress'),
      onProvidersChanged: subscription('providersChanged'),
      getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
      ...(pluginEngines.length ? {
        listPluginEngines: async () => pluginEngines,
        onPluginEnginesChanged: subscription('pluginEnginesChanged'),
        refreshPluginEngines: async () => {},
        getPluginEngineUsage: async () => ({ updatedAt: Date.now(), windows: [{ label: 'Weekly requests', remainingPercent: 64 }] }),
        setPluginEnginePrefs: forbid('setPluginEnginePrefs'),
        setPluginEngineRemoteUse: forbid('setPluginEngineRemoteUse'),
      } : {}),
    },
    deviceLink: { getState: async () => ({ remoteControlEnabled: true }), invoke: async () => ({}),
      onRemotePush: subscription('remotePush'), onStatusChanged: subscription('deviceStatus'), onOwnershipChanged: subscription('ownership') },
    providerShare: { command: async () => ({ ready: true, providerIds: [] }), onOwnedChanged: subscription('ownedChanged'), onReceivedChanged: subscription('receivedChanged') },
    providerGroup: { command: async (command: { action: string }) => command.action === 'list' ? {} : { ready: true, providerIds: [] }, onChanged: subscription('groupChanged') },
  },
  render: () => <div className="flex h-screen gap-4 p-4">
    <div className="min-w-0 flex-1"><ProvidersSection /></div>
    <div data-picker className="flex w-[360px] items-end">
      <ModelSelector modelId={ctx.case === 'connection-icons' ? 'glm' : 'gpt-6-astra'} currentProviderId={ctx.case === 'connection-icons' ? 'glm-personal' : 'openai'} agentKind="codex" effort="high"
        onModelChange={() => {}} onEffortChange={() => {}} useMorphPopover
        remoteAgent={{ devices: devices.map(({ deviceId, name }) => ({ deviceId, name })), selectedDeviceId: null }} />
    </div>
  </div>,
});
