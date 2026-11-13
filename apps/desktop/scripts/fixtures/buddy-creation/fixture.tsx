import { useState } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { BotRosterView } from '../../../src/renderer/features/bots/BotRosterView';
import { refreshBotProfiles, type BotProfile } from '../../../src/renderer/features/bots/botStore';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { BUNDLED_CATALOG, type ProviderView } from '@cindy/model-providers';

const route = { harness: 'codex' as const, model: 'fixture-model', providerId: 'openai', effort: 'high', fastMode: false };
const model = { id: route.model, name: 'GPT', contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' };
const provider: ProviderView = { ...BUNDLED_CATALOG.providers.find(p => p.id === 'openai')!,
  connected: true, agents: ['codex'], access: { kind: 'subscription' }, models: { codex: [model] } };

function Fixture() {
  const [created, setCreated] = useState<BotProfile | null>(null);
  return created ? <p role="status">{created.name}</p> : <BotRosterView onCreated={setCreated} />;
}

void mountPage({
  route: '/bots',
  host: () => {
    Math.random = () => 0; // Keep the portrait identical in before/after captures.
    const owner = getDataOwnerGeneration();
    commitProvidersSnapshot(beginProvidersRefresh(), { dataOwnerId: owner.dataOwnerId,
      ownerGeneration: owner.generation, providers: [provider], providerOrder: ['openai'] });
    return {
      localDb: { bots: {
        list: async () => [],
        getModelChainSettings: async () => ({ modelChain: [route], isCustomized: true }),
        // Leave the real store's optimistic profile pending, without touching a database.
        create: () => {
          (window as unknown as { __buddyCreationPending: boolean }).__buddyCreationPending = true;
          return new Promise(() => {});
        },
      } },
      maker: {
        listAvailableAgents: async () => ['codex'],
        getCapabilities: async () => ({ hasFastMode: false, availableModels: [{ ...model, displayName: model.name }],
          effortLevels: [], permissionModes: [], turnPermissionPolicy: { supported: { supported: true }, unsupportedPermissionModes: [] } }),
        onProvidersChanged: subscription('providers'),
      },
    };
  },
  render: () => { refreshBotProfiles(); return <Fixture />; },
});
