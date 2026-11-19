import { useState } from 'react';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';
import { ModelSelector, type UnifiedSelectionAgentDevice } from '../../../src/renderer/components/new-chat/ModelSelector';
import { ConfirmDialogProvider } from '../../../src/renderer/components/ui/confirm-dialog-provider';
import { mountPage, subscription, ctx } from '../../ui-page/harness';

// This computer's Anthropic is signed out right now; ROG has the same login. A share of the same
// provider and a provider only ROG has are already listed in Settings and are used directly.
const fable = { 'claude-code': [{ id: 'claude-fable', name: 'Fable 5.2', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high', defaultEnabled: true }] };
const provider = (id: string, extra: Partial<ProviderView> = {}): ProviderView => ({
  ...BUNDLED_CATALOG.providers.find(item => item.id === id)!,
  connected: true, remoteInvocationEnabled: true, subscriptionAccountKeys: ['account-a'], models: fable,
  ...extra,
} as ProviderView);
const kimi = { id: 'kimi', name: 'Kimi', source: 'user', agents: ['claude-code'], auth: { method: 'api-key' }, routing: { 'claude-code': {} },
  connected: true, models: { 'claude-code': [{ id: 'kimi-k3', name: 'Kimi K3', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high', defaultEnabled: true }] } } as unknown as ProviderView;
const local = [provider('anthropic', { connected: false }), kimi];
const catalogs = new Map([
  ['rog', { providers: [provider('anthropic'), provider('xai', { subscriptionAccountKeys: ['account-x'] })], loading: false, error: null }],
  ['share:pat', { providers: [provider('anthropic', { subscriptionAccountKeys: ['account-p'] })], loading: false, error: null }],
]);
const devices = [{ deviceId: 'rog', name: 'ROG', platform: 'win32' }, { deviceId: 'share:pat', name: 'Pat', platform: 'darwin' }];
const snapshot = { providers: local, providerOrder: local.map(item => item.id), ownerGeneration: 1, loading: false, error: null, refetch: async () => {} };
Object.assign(window, { listingFixture: { snapshot, devices, catalogs } });

type Route = { providerId: string; modelId: string; device: { deviceId: string; name: string } | null };

function Composer() {
  const [route, setRoute] = useState<Route>({ providerId: 'anthropic', modelId: 'claude-fable', device: null });
  const running = ctx.case === 'running-task';
  const apply = (selection: { providerId: string; modelId: string; agentDevice?: UnifiedSelectionAgentDevice }) => {
    const device = selection.agentDevice ? { deviceId: selection.agentDevice.deviceId, name: selection.agentDevice.name } : null;
    setRoute({ providerId: selection.providerId, modelId: selection.modelId, device });
    return true;
  };
  return (
    <div data-composer data-route={`${route.device?.deviceId ?? 'local'}:${route.providerId}`}
      className="flex w-full max-w-[640px] items-center rounded-2xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2">
      <ModelSelector modelId={route.modelId} currentProviderId={route.providerId} agentKind="claude-code" effort="high"
        onModelChange={() => {}} onEffortChange={() => {}}
        {...(running ? {} : { onUnifiedSelect: apply })}
        remoteAgent={{
          devices: devices.map(({ deviceId, name }) => ({ deviceId, name })),
          selectedDeviceId: route.device?.deviceId ?? null,
          ...(running ? { onRelocate: apply } : {}),
        }} />
    </div>
  );
}

mountPage({
  host: {
    maker: {
      listProviders: async () => snapshot,
      onProvidersChanged: subscription('providersChanged'),
      getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
    },
    deviceLink: { getState: async () => ({ remoteControlEnabled: true }), invoke: async () => ({}),
      onRemotePush: subscription('remotePush'), onStatusChanged: subscription('deviceStatus'), onOwnershipChanged: subscription('ownership') },
    providerShare: { command: async () => ({ ready: true, providerIds: [] }), onOwnedChanged: subscription('ownedChanged'), onReceivedChanged: subscription('receivedChanged') },
    providerGroup: { command: async (command: { action: string }) => command.action === 'list' ? {} : { ready: true, providerIds: [] }, onChanged: subscription('groupChanged') },
  },
  render: () => (
    <ConfirmDialogProvider>
      <div className="flex h-screen items-end justify-center p-6"><Composer /></div>
    </ConfirmDialogProvider>
  ),
});
