import { useState } from 'react';
import { mountPage, subscription, forbid } from '../../ui-page/harness';
import { ModelSelectorContent } from '../../../src/renderer/components/new-chat/ModelSelector';
import { useControlledModelLocations } from '../../../src/renderer/hooks/useControlledModelLocations';
import { CreateWorkerPopover } from '../../../src/renderer/features/cc-agent/CreateWorkerPopover';
import { modelCatalogKey } from '../../../src/shared/controlledModelCatalog';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type { ProviderView } from '@cindy/model-providers';
import { MODEL_FAVORITES_GET, MODEL_FAVORITES_APPLY, type RemoteModelFavorite, type ModelFavoriteMutation } from '@cindy/device-link';

const provider = (id: string, name: string, enabled = true): ProviderView => ({
  id, name, source: 'user', connected: true, remoteInvocationEnabled: enabled,
  agents: ['codex'], auth: { method: 'none' }, routing: { codex: {} },
  models: { codex: [{ id: `${id}-model`, name: `${name} Model`, contextWindow: 200000,
    efforts: ['low', 'high'], defaultEffort: 'high' }] },
} as ProviderView);
const catalogs: Record<string, ProviderView[]> = {
  'device-a': [provider('a-open', 'A Open'), provider('a-private', 'A Private', false)],
  'device-b': [provider('b-main', 'B Main'), provider('b-private', 'B Private', false)],
  'share:b-only': [provider('shared', 'Shared')],
};
const favoriteSource = { shareId: 'b-only', memberId: 'b-member', providerId: 'shared', owner: { region: 'global' as const } };
const locations = [{ agentDeviceId: 'device-a', name: 'Computer A' },
  { agentDeviceId: 'share:b-only', name: 'B-only share', favoriteSource }];
let favorites: RemoteModelFavorite[] = [];
const capabilities = (source: string) => ({ availableModels: (catalogs[source] ?? [])
  .flatMap(p => (p.models.codex ?? []).map(m => ({ ...m, displayName: m.name }))),
  effortLevels: [], hasFastMode: false, supportsOrcaWorkerPermissionMode: true,
  supportsOrcaWorkerAgentDevice: true, permissionModes: [{ id: 'auto', displayName: 'Auto' }] });
const calls: unknown[] = [];
let lastSelection: unknown = null;
Object.assign(window, { catalogAcceptance: { calls, selected: () => lastSelection, favorites: () => favorites } });

function Fixture({ scenario }: { scenario: string }) {
  const local = scenario === 'local';
  const sources = useControlledModelLocations(local ? undefined : 'device-b');
  const devices = sources?.map(({ agentDeviceId, name, favoriteSource }) => ({ deviceId: agentDeviceId, name, favoriteSource })) ?? [];
  const [source, setSource] = useState<string | null>(null);
  const [model, setModel] = useState(local ? 'a-open-model' : 'b-main-model');
  const [providerId, setProviderId] = useState(local ? 'a-open' : 'b-main');
  const [open, setOpen] = useState(true);
  if (scenario === 'worker') return <CreateWorkerPopover open={open} deviceId="device-b"
    catalogHostDeviceId="device-b" leadAgentDeviceId="share:b-only" remoteAgentDevices={devices}
    onClose={() => setOpen(false)} onCreate={form => { lastSelection = form; setOpen(false); }} />;
  return <main className="mx-auto w-full max-w-[720px] p-4">
    <ModelSelectorContent modelId={model} currentProviderId={providerId} effort="high"
      onModelChange={setModel} onEffortChange={() => {}} reselectEmitsChange
      deviceId={local ? undefined : modelCatalogKey(source ?? 'device-b', 'device-b')}
      remoteAgent={local ? undefined : { devices, selectedDeviceId: source, homeDeviceId: 'device-b',
        catalogHostDeviceId: 'device-b', homeDeviceName: 'Computer B' }}
      onUnifiedSelect={selection => {
        lastSelection = selection;
        setSource(selection.agentDevice?.deviceId ?? null);
        setModel(selection.modelId); setProviderId(selection.providerId);
      }} />
  </main>;
}

void mountPage({ route: '/', host: () => {
  const owner = getDataOwnerGeneration();
  commitProvidersSnapshot(beginProvidersRefresh(), { dataOwnerId: owner.dataOwnerId,
    ownerGeneration: owner.generation, providers: catalogs['device-a'], providerOrder: [] });
  return {
    maker: { getCapabilities: async () => capabilities('device-a'), listAvailableAgents: async () => ['codex'],
      getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
      onProvidersChanged: subscription('providers'), send: forbid('maker.send') },
    deviceLink: { onRemotePush: subscription('remotePush'), onPeerLinkReset: subscription('peerReset'),
      onStatusChanged: subscription('status'), onPresenceChanged: subscription('presence'),
      invoke: async (host: string, channel: string, args: unknown[] = []) => {
        calls.push({ host, channel, args });
        if (host !== 'device-b') throw new Error('Catalog must be read through B');
        let source = host;
        if (channel === 'maker:model-catalog:read') {
          const request = args[0] as { op: string; agentDeviceId: string; channel: string };
          if (request.op === 'locations') return { locations };
          source = request.agentDeviceId; channel = request.channel;
        }
        if (channel === 'maker:provider:list') return { providers: catalogs[source] ?? [] };
        if (channel === 'maker:get-capabilities') return capabilities(source);
        if (channel === MODEL_FAVORITES_GET) return favorites;
        if (channel === MODEL_FAVORITES_APPLY) {
          const mutation = args[0] as ModelFavoriteMutation;
          if (mutation.kind === 'add') favorites = [...favorites, { ...mutation.item, uid: 'b-favorite' }];
          else if (mutation.kind === 'remove') favorites = favorites.filter(item => item.uid !== mutation.expected.uid);
          else throw new Error('Unexpected favorite mutation');
          return favorites;
        }
        if (channel === 'maker:list-available-agents') return ['codex'];
        if (channel === 'maker:orca:execution-devices') return { devices: [] };
        throw new Error(`Unexpected mock read: ${channel}`);
      } },
  };
}, render: ctx => <Fixture scenario={ctx.case} /> });
