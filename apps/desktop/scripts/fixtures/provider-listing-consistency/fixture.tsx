import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
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
if (ctx.case === 'same-account-twice-here') local.push(provider('openai', 'account-a', { id: 'openai-old', name: 'OpenAI · old connection' }));
const devices = [{ deviceId: 'rog', name: 'ROG', platform: 'win32' }, { deviceId: 'mini', name: 'Mac mini', platform: 'darwin' }];
const snapshot = { providers: local, providerOrder: local.map(item => item.id), ownerGeneration: 1, loading: false, error: null, refetch: async () => {} };
Object.assign(window, { listingFixture: { snapshot, devices, catalogs },
  // The reused Settings stubs read received shares from here.
  providerSourcesFixture: { received: { received: [], loaded: true } } });

mountPage({
  route: '/settings?tab=providers',
  host: {
    subscriptionAccounts: { command: async ({ providerId }: { providerId: string }) => ({ providerId, configured: false, strategy: 'least', accounts: [] }), onChanged: subscription('subscriptionAccountsChanged') },
    maker: {
      listProviders: async () => snapshot,
      scanLocalCli: async () => ({ detections: [] }),
      requestProviderModelsAutoRefresh: async () => ({ ok: true }),
      setProviderOrder: forbid('setProviderOrder'),
      getOwnComputerModelUse: async () => ({ enabled: true }),
      listProviderPresets: async () => ({ presets: BUNDLED_CATALOG.presets ?? [] }),
      localModelList: async () => ({ status: { kind: 'ready' }, models: [], memoryGb: 0 }),
      localModelStatus: async () => ({ kind: 'ready' }),
      onLocalModelStatus: subscription('localModelStatus'),
      onProviderOAuthProgress: subscription('providerOAuthProgress'),
      onProvidersChanged: subscription('providersChanged'),
      getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
    },
    deviceLink: { getState: async () => ({ remoteControlEnabled: true }), invoke: async () => ({}),
      onRemotePush: subscription('remotePush'), onStatusChanged: subscription('deviceStatus'), onOwnershipChanged: subscription('ownership') },
    providerShare: { command: async () => ({ ready: true, providerIds: [] }), onOwnedChanged: subscription('ownedChanged'), onReceivedChanged: subscription('receivedChanged') },
    providerGroup: { command: async (command: { action: string }) => command.action === 'list' ? {} : { ready: true, providerIds: [] }, onChanged: subscription('groupChanged') },
  },
  render: () => <div className="flex h-screen gap-4 p-4">
    <div className="min-w-0 flex-1"><ProvidersSection /></div>
    <div data-picker className="flex w-[360px] items-end">
      <ModelSelector modelId="gpt-6-astra" currentProviderId="openai" agentKind="codex" effort="high"
        onModelChange={() => {}} onEffortChange={() => {}} useMorphPopover
        remoteAgent={{ devices: devices.map(({ deviceId, name }) => ({ deviceId, name })), selectedDeviceId: null }} />
    </div>
  </div>,
});
